import { AlgoliaError, fetchComments, fetchPosts, type Comment, type Post, type PostType } from "./algolia.ts";
import { llmTags, TAGGER_VERSION } from "./llm.ts";
import { threadTerms } from "./text.ts";

export interface Env {
  DB: D1Database;
  DATA: R2Bucket;
  AI: Ai;
  BACKFILL_DAYS: string;
  LLM_MODELS: string; // comma-separated Workers AI model ids; the first one's tags are shown. Empty disables LLM tagging.
  LLM_THREADS_PER_RUN: string; // threads tagged from their comments per run (each costs an Algolia fetch)
}

const DAY = 86400;
const RESYNC_DAYS = 5; // points and comment counts keep moving for a few days after posting (measured: little change after day 5)
const BACKFILL_CHUNK_DAYS = 10; // older history fetched per run until BACKFILL_DAYS is covered
const LIST_SIZE = 300; // posts per (window, sort, type) list
const MIN_COMMENTS = 5; // smaller threads are tagged from the title alone, then re-tagged from comments once they reach this
const TITLE_TAGS_PER_RUN = 100; // title-only tagging is cheap (~3 neurons, no Algolia fetch)
const CONCURRENCY = 6; // Workers' limit on simultaneous outbound connections
const VOCABULARY_SIZE = 150; // most-used existing LLM tags offered to the model for reuse

const WINDOWS = { "24h": 1, "1w": 7, "1m": 30, "1y": 365 };
const SORTS = { points: "points", comments: "num_comments" };
type WindowKey = keyof typeof WINDOWS;
type SortKey = keyof typeof SORTS;
type Lists = Record<WindowKey, Record<SortKey, Record<"all" | PostType, number[]>>>;

export async function runJob(env: Env, now: number): Promise<void> {
  const started = Date.now();
  // An Algolia outage or block shouldn't stop the site from updating: carry on with the posts already in D1.
  let sync = { synced: 0, backfillDone: false };
  try {
    sync = await syncPosts(env, now);
  } catch (e) {
    console.error(`post sync failed; building lists from stored posts: ${e}`);
  }
  const { synced, backfillDone } = sync;
  const lists = await buildLists(env.DB, now);
  const listed = [
    ...new Set(
      Object.values(lists).flatMap((bySort) => Object.values(bySort).flatMap((byType) => Object.values(byType).flat())),
    ),
  ];
  const models = env.LLM_MODELS.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const { due, llm } = await tagPosts(env, listed, models, now);
  const bytes = await exportData(env, now, lists, listed, models);
  // scripts/backfill.sh reads this line: it stops once backfillDone and nothing is left due.
  console.log(
    JSON.stringify({ synced, backfillDone, listed: listed.length, due, llm, bytes, ms: Date.now() - started }),
  );
}

/** Re-sync recent posts every run, and walk the backfill cursor further into the past until BACKFILL_DAYS is reached. */
async function syncPosts(env: Env, now: number): Promise<{ synced: number; backfillDone: boolean }> {
  const recentFrom = now - RESYNC_DAYS * DAY;
  let synced = await upsertPosts(env.DB, await fetchPosts(recentFrom, now + 1));

  const target = now - Number(env.BACKFILL_DAYS) * DAY;
  const cursor = Number((await getState(env.DB, "backfill_cursor")) ?? recentFrom);
  if (cursor <= target) return { synced, backfillDone: true };
  const from = Math.max(target, cursor - BACKFILL_CHUNK_DAYS * DAY);
  synced += await upsertPosts(env.DB, await fetchPosts(from, cursor));
  await setState(env.DB, "backfill_cursor", String(from));
  return { synced, backfillDone: from <= target };
}

// Rows go in as one JSON parameter per chunk, since D1 caps bound parameters (100) and queries per invocation (1000).
async function upsertPosts(db: D1Database, posts: Post[]): Promise<number> {
  for (const chunk of chunks(posts, 500)) {
    await db
      .prepare(
        `INSERT INTO posts (id, type, title, url, author, points, num_comments, created_at)
         SELECT p->>'id', p->>'type', p->>'title', p->>'url', p->>'author', p->>'points', p->>'numComments', p->>'createdAt'
         FROM (SELECT value AS p FROM json_each(?1)) WHERE true
         ON CONFLICT (id) DO UPDATE SET
           type = excluded.type, title = excluded.title, url = excluded.url,
           points = excluded.points, num_comments = excluded.num_comments
         WHERE posts.points <> excluded.points OR posts.num_comments <> excluded.num_comments
           OR posts.title <> excluded.title OR posts.url IS NOT excluded.url OR posts.type <> excluded.type`,
      )
      .bind(JSON.stringify(chunk))
      .run();
  }
  return posts.length;
}

/** Top LIST_SIZE post ids per window and sort, overall and per type, in one query per (window, sort). */
async function buildLists(db: D1Database, now: number): Promise<Lists> {
  const lists = {} as Lists;
  for (const [w, days] of Object.entries(WINDOWS) as [WindowKey, number][]) {
    lists[w] = {} as Lists[WindowKey];
    for (const [s, column] of Object.entries(SORTS) as [SortKey, string][]) {
      const { results } = await db
        .prepare(
          `SELECT id, type, ra, rt FROM (
             SELECT id, type,
               ROW_NUMBER() OVER (ORDER BY ${column} DESC, id DESC) AS ra,
               ROW_NUMBER() OVER (PARTITION BY type ORDER BY ${column} DESC, id DESC) AS rt
             FROM posts WHERE created_at >= ?1)
           WHERE ra <= ?2 OR rt <= ?2`,
        )
        .bind(now - days * DAY, LIST_SIZE)
        .all<{ id: number; type: PostType; ra: number; rt: number }>();
      const byType: Record<"all" | PostType, number[]> = { all: [], story: [], ask: [], show: [], poll: [] };
      for (const r of [...results].sort((a, b) => a.ra - b.ra)) if (r.ra <= LIST_SIZE) byType.all.push(r.id);
      for (const r of [...results].sort((a, b) => a.rt - b.rt)) if (r.rt <= LIST_SIZE) byType[r.type].push(r.id);
      lists[w][s] = byType;
    }
  }
  return lists;
}

interface DuePost {
  id: number;
  title: string;
  type: PostType;
  url: string | null;
  num_comments: number;
  models_due: string; // JSON array of models with no tags yet, or tags from an older TAGGER_VERSION or a smaller thread
}

/**
 * LLM-tag listed posts that have no tags yet or whose tags are stale: tagged from the title while under MIN_COMMENTS,
 * then re-tagged from comments on reaching MIN_COMMENTS and again each time the comment count doubles, and re-tagged
 * whenever TAGGER_VERSION is bumped.
 * Per run: up to LLM_THREADS_PER_RUN threads from comments (biggest first) and TITLE_TAGS_PER_RUN from titles (newest first).
 */
async function tagPosts(env: Env, ids: number[], models: string[], now: number) {
  const due: DuePost[] = [];
  for (const chunk of chunks(ids, 1000)) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM (
         SELECT p.id, p.title, p.type, p.url, p.num_comments,
           (SELECT json_group_array(m.value) FROM json_each(?3) AS m
              LEFT JOIN llm_tags AS l ON l.post_id = p.id AND l.model = m.value
              WHERE l.post_id IS NULL
                OR l.version < ?4
                OR (l.comment_count < ?2 AND p.num_comments >= ?2)
                OR (l.comment_count >= ?2 AND p.num_comments >= l.comment_count * 2)) AS models_due
         FROM posts AS p WHERE p.id IN (SELECT value FROM json_each(?1)))
       WHERE models_due <> '[]'`,
    )
      .bind(JSON.stringify(chunk), MIN_COMMENTS, JSON.stringify(models), TAGGER_VERSION)
      .all<DuePost>();
    due.push(...results);
  }
  const work = [
    ...due
      .filter((p) => p.num_comments >= MIN_COMMENTS)
      .sort((a, b) => b.num_comments - a.num_comments)
      .slice(0, Number(env.LLM_THREADS_PER_RUN))
      .map((post) => ({ post, fromComments: true })),
    ...due
      .filter((p) => p.num_comments < MIN_COMMENTS)
      .sort((a, b) => b.id - a.id) // HN ids increase over time
      .slice(0, TITLE_TAGS_PER_RUN)
      .map((post) => ({ post, fromComments: false })),
  ];

  const vocabularies = new Map(await Promise.all(models.map(async (m) => [m, await vocabulary(env.DB, m)] as const)));
  const stats = Object.fromEntries(
    models.map((m) => [m, { calls: 0, unparsed: 0, errors: 0, inputTokens: 0, outputTokens: 0, maxMs: 0 }]),
  );

  let blocked = false;
  const results = await mapPool(work, CONCURRENCY, async ({ post, fromComments }) => {
    let comments: Comment[] = [];
    if (fromComments) {
      if (blocked) return [];
      try {
        comments = await fetchComments(post.id);
      } catch (e) {
        if (e instanceof AlgoliaError && e.blocked && !blocked) {
          blocked = true;
          console.warn(`Algolia is refusing requests (${e.status}); leaving remaining threads for the next run`);
        } else if (!blocked) {
          console.warn(`comments for ${post.id} failed: ${e}`);
        }
        return [];
      }
    }
    const input = {
      title: post.title,
      type: post.type,
      domain: domain(post.url),
      comments,
      frequentWords: threadTerms(comments.map((c) => c.text))
        .slice(0, 15)
        .map(([, , word]) => word),
    };
    const tagged: { id: number; model: string; tags: string[]; count: number }[] = [];
    for (const model of JSON.parse(post.models_due) as string[]) {
      const s = stats[model];
      s.calls++;
      const callStarted = Date.now();
      try {
        const result = await llmTags(env.AI, model, { ...input, vocabulary: vocabularies.get(model)! });
        s.inputTokens += result.inputTokens;
        s.outputTokens += result.outputTokens;
        if (!result.tags) {
          s.unparsed++;
          console.warn(`${model} reply for ${post.id} had no tags: ${result.reply.slice(0, 300)}`);
        }
        // An unparseable reply is stored as [] so it isn't retried until the post is next due.
        tagged.push({ id: post.id, model, tags: result.tags ?? [], count: post.num_comments });
      } catch (e) {
        s.errors++;
        console.warn(`${model} failed for ${post.id}: ${e}`);
      } finally {
        s.maxMs = Math.max(s.maxMs, Date.now() - callStarted);
      }
    }
    return tagged;
  });

  for (const chunk of chunks(results.flat(), 100)) {
    await env.DB.prepare(
      `INSERT INTO llm_tags (post_id, model, tags, comment_count, updated_at, version)
       SELECT r->>'id', r->>'model', r->>'tags', r->>'count', ?2, ?3 FROM (SELECT value AS r FROM json_each(?1)) WHERE true
       ON CONFLICT (post_id, model) DO UPDATE SET
         tags = excluded.tags, comment_count = excluded.comment_count, updated_at = excluded.updated_at, version = excluded.version`,
    )
      .bind(JSON.stringify(chunk), now, TAGGER_VERSION)
      .run();
  }
  const finished = results.filter(
    (tagged, i) => tagged.length === (JSON.parse(work[i].post.models_due) as string[]).length,
  ).length;
  return { due: due.length - finished, llm: stats }; // posts still due after this run
}

function domain(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** The model's own most-used recent tags, offered back to it so the same topic gets the same tag across posts. */
async function vocabulary(db: D1Database, model: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT tags FROM llm_tags WHERE model = ?1 ORDER BY updated_at DESC LIMIT 2000")
    .bind(model)
    .all<{ tags: string }>();
  const counts = new Map<string, number>();
  for (const r of results)
    for (const tag of JSON.parse(r.tags) as string[]) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, VOCABULARY_SIZE)
    .map(([tag]) => tag);
}

/**
 * Write everything the static page needs (listed posts with tags + the lists) to R2 as data.json. Posts show the first
 * model's tags. With several models configured (a trial), every model's tags are included for the compare view.
 */
async function exportData(env: Env, now: number, lists: Lists, ids: number[], models: string[]): Promise<number> {
  type Row = {
    id: number;
    type: PostType;
    title: string;
    url: string | null;
    author: string;
    points: number;
    num_comments: number;
    created_at: number;
  };
  const rows: Row[] = [];
  for (const chunk of chunks(ids, 1000)) {
    const { results } = await env.DB.prepare(
      `SELECT id, type, title, url, author, points, num_comments, created_at
       FROM posts WHERE id IN (SELECT value FROM json_each(?1))`,
    )
      .bind(JSON.stringify(chunk))
      .all<Row>();
    rows.push(...results);
  }
  // Every model's rows, not just the configured ones, so a post can fall back to tags from a previous model.
  const llm = new Map<number, TagRow[]>();
  for (const chunk of chunks(ids, 1000)) {
    const { results } = await env.DB.prepare(
      `SELECT post_id, model, tags, updated_at FROM llm_tags WHERE post_id IN (SELECT value FROM json_each(?1))`,
    )
      .bind(JSON.stringify(chunk))
      .all<{ post_id: number; model: string; tags: string; updated_at: number }>();
    for (const r of results) llm.set(r.post_id, [...(llm.get(r.post_id) ?? []), { ...r, tags: JSON.parse(r.tags) }]);
  }
  const variantsFor = (id: number) =>
    Object.fromEntries(models.map((m) => [m.split("/").pop(), llm.get(id)?.find((r) => r.model === m)?.tags ?? []]));
  const oldest = await env.DB.prepare("SELECT MIN(created_at) AS t FROM posts").first<number>("t");

  const body = JSON.stringify({
    generatedAt: now,
    oldest,
    posts: rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      url: r.url,
      author: r.author,
      points: r.points,
      comments: r.num_comments,
      time: r.created_at,
      tags: displayTags(llm.get(r.id) ?? [], models[0]),
      ...(models.length > 1 && { variants: variantsFor(r.id) }),
    })),
    lists,
  });
  await env.DATA.put("data.json", body, { httpMetadata: { contentType: "application/json" } });
  return body.length;
}

export interface TagRow {
  model: string;
  tags: string[];
  updated_at: number;
}

/**
 * The tags a post shows: the first configured model's (even from an older TAGGER_VERSION, until re-tagged), else the
 * most recent non-empty tags from any other model, so switching models doesn't blank posts while re-tagging catches up.
 */
export function displayTags(rows: TagRow[], primaryModel: string | undefined): string[] {
  const primary = rows.find((r) => r.model === primaryModel);
  if (primary?.tags.length) return primary.tags;
  const fallback = rows.filter((r) => r.tags.length).sort((a, b) => b.updated_at - a.updated_at)[0];
  return fallback?.tags ?? [];
}

async function getState(db: D1Database, key: string): Promise<string | null> {
  return db.prepare("SELECT value FROM state WHERE key = ?1").bind(key).first<string>("value");
}

async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO state (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}
