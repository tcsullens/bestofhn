const API = "https://hn.algolia.com/api/v1";
const MAX_HITS = 1000; // Algolia returns at most 1000 hits per query, regardless of paging
// The documented limit is 10k requests/hour/IP, but ~12 req/s got us short-term 403s; stay well under that.
const MIN_REQUEST_INTERVAL_MS = 500;

export class AlgoliaError extends Error {
  status: number;
  constructor(endpoint: string, status: number, body: string) {
    super(`Algolia ${endpoint} ${status}: ${body.slice(0, 200)}`);
    this.status = status;
  }
  /** Algolia is refusing this IP for now; further requests in this run will fail too. */
  get blocked(): boolean {
    return this.status === 403 || this.status === 429;
  }
}

export type PostType = "story" | "ask" | "show" | "poll";

export interface Post {
  id: number;
  type: PostType;
  title: string;
  url: string | null;
  author: string;
  points: number;
  numComments: number;
  createdAt: number;
}

interface PostHit {
  objectID: string;
  title: string | null;
  url: string | null;
  author: string;
  points: number | null;
  num_comments: number | null;
  created_at_i: number;
  _tags: string[];
}

let nextRequestAt = 0;

async function search<T>(endpoint: string, params: Record<string, string>): Promise<{ hits: T[]; nbHits: number }> {
  const now = Date.now();
  const wait = nextRequestAt - now;
  nextRequestAt = Math.max(now, nextRequestAt) + MIN_REQUEST_INTERVAL_MS;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

  const res = await fetch(`${API}/${endpoint}?${new URLSearchParams(params)}`);
  if (!res.ok) throw new AlgoliaError(endpoint, res.status, await res.text());
  return res.json();
}

// Ask HN and Show HN items are also tagged "story", so check the specific tags first.
export function postType(tags: string[]): PostType {
  if (tags.includes("poll")) return "poll";
  if (tags.includes("ask_hn")) return "ask";
  if (tags.includes("show_hn")) return "show";
  return "story";
}

/** All stories and polls created in [from, to), splitting the range until each query fits under the 1000-hit cap. */
export async function fetchPosts(from: number, to: number): Promise<Post[]> {
  const { hits, nbHits } = await search<PostHit>("search_by_date", {
    tags: "(story,poll)",
    numericFilters: `created_at_i>=${from},created_at_i<${to}`,
    hitsPerPage: String(MAX_HITS),
    attributesToRetrieve: "title,url,author,points,num_comments,created_at_i,_tags",
  });
  if (nbHits > hits.length && to - from > 1) {
    const mid = Math.floor((from + to) / 2);
    return [...(await fetchPosts(from, mid)), ...(await fetchPosts(mid, to))];
  }
  return hits
    .filter((h) => h.title)
    .map((h) => ({
      id: Number(h.objectID),
      type: postType(h._tags),
      title: h.title!,
      url: h.url || null,
      author: h.author,
      points: h.points ?? 0,
      numComments: h.num_comments ?? 0,
      createdAt: h.created_at_i,
    }));
}

export interface Comment {
  text: string; // HTML
  topLevel: boolean; // a direct reply to the post rather than to another comment
}

/** Comments for a post. Threads over 1000 comments are sampled to the first 1000 Algolia returns. */
export async function fetchComments(postId: number): Promise<Comment[]> {
  const { hits } = await search<{ comment_text: string | null; parent_id: number }>("search", {
    tags: `comment,story_${postId}`,
    hitsPerPage: String(MAX_HITS),
    attributesToRetrieve: "comment_text,parent_id",
  });
  return hits.flatMap((h) => (h.comment_text ? [{ text: h.comment_text, topLevel: h.parent_id === postId }] : []));
}
