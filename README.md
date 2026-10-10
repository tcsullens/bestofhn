# Best of HN

https://bestofhn.dev

Top Hacker News stories, Ask HN, Show HN and polls by points or comment count over 24h / 1 week / 1 month / 1 year,
each with 1–3 topic tags from a Workers AI model: what the post is about, then the main discussion topic if it differs.

## How it works

One Cloudflare Worker:

- **Hourly cron** (`src/job.ts`)
  1. Syncs posts from the [HN Algolia API](https://hn.algolia.com/api) into D1: the last 5 days every run (scores are still moving; measured changes after day 5 are negligible), plus a 10-day chunk of older history per run until `BACKFILL_DAYS` is covered.
  2. Builds the top 300 posts per window × sort × type.
  3. Tags listed posts that are untagged or stale. Posts with fewer than 5 comments are tagged from the title and link (up to 100 per run, newest first); larger threads from their comments (`LLM_THREADS_PER_RUN` per run, biggest first), re-tagged on reaching 5 comments and each time the count doubles.
  4. Writes `data.json` to R2.
- **Static page** (`public/`) loads `/data.json` once and does all filtering client-side. View state lives in the URL hash, so views can be shared.

Tagging (`src/llm.ts`): the model gets the title, link domain, ~4k tokens of comments (top-level first), the thread's most frequent words (`src/text.ts`: stopword-filtered, stemmed counts), and its own most-used recent tags (so it reuses them). Replies are parsed leniently, then normalized in code: synonyms folded (`artificial intelligence` → `ai`, `llm`/`large language models` → `llms`), generic non-topic words dropped (`decision`, `info`, `update`, …), at most one broad tag (`ai`, `llms`, …), at most 3 tags. Posts show no tags until tagged. Lessons:

- Don't put example tags in the prompt; models copy them onto unrelated threads. That's why synonym folding lives in code.
- Keyword extraction (TF-IDF over comments) was tried first and dropped: it surfaced words like `decision`, `vote`, `disable` that don't name a topic.
- `gemma-4-26b-a4b-it` is a reasoning model: without `chat_template_kwargs: { enable_thinking: false }` it spends the whole output budget thinking.
- Measured with gemma: ~36 neurons for a 600+ comment thread (~3.9k input tokens; llama-3.3-70b was ~106), ~2.6 for a title-only post. Workers AI includes 10k neurons/day free, then $0.011 per 1k.

## Local development

```sh
npm install
npm run db:migrate:local
npm run dev                # http://localhost:8787
npm run run-job:local      # in another terminal: run the hourly job once (~3 min)
npm test                   # unit tests (node --test)
npm run typecheck
```

Local D1/R2 state lives in `.wrangler/state`. The first few job runs complete the backfill and tag queue; run it a few times.

Workers AI always runs on Cloudflare, even under `wrangler dev`, so local dev needs `npx wrangler login` and a workers.dev subdomain on the account, and LLM calls count against the account's neurons. Override per session with e.g. `npx wrangler dev --var LLM_THREADS_PER_RUN:5`.

## Deploying to Cloudflare

Requires the **Workers Paid** plan ($5/mo): the free plan allows only 10 ms CPU per cron run.

### Seeding a fresh deployment

Rather than letting hourly runs backfill a year in 10-day chunks (and tag it 25 threads at a time), fill the local
database in one go and copy it up. Locally there's no 15-minute limit, and the Algolia burst comes from your own IP.

```sh
scripts/backfill.sh        # ~45-60 min: ~363k posts, ~4k listed posts tagged (~110k neurons, ~$1.10)
npm run dev                # review http://localhost:8787, then stop it
```

Export the seed **before** creating the remote database: local dev keys its D1 storage to the `database_id` in
`wrangler.jsonc`, so once that's replaced, local commands see a new, empty database.

```sh
npx wrangler d1 export bestofhn --local --no-schema --table posts --table llm_tags --table state --output seed.sql
npx wrangler r2 object get bestofhn-data/data.json --local --file data.json
```

Then create the Cloudflare resources and load the data (Workers Paid plan required; the import is ~365k row writes,
more than the free plan's 100k/day):

```sh
npx wrangler d1 create bestofhn              # paste the database_id into wrangler.jsonc
npx wrangler r2 bucket create bestofhn-data
npm run db:migrate:remote                    # schema (migrations/0001_init.sql) + migration history
npx wrangler d1 execute bestofhn --remote --file seed.sql
npx wrangler r2 object put bestofhn-data/data.json --remote --file data.json --content-type application/json
npm run deploy                               # Worker, static pages, cron, and the bestofhn.dev custom domain
```

Hourly runs then only re-sync the last 5 days and tag new posts. Logs: `npx wrangler tail` or the Workers dashboard.

Without seeding, `npm run db:migrate:remote && npm run deploy` also works: `/data.json` returns 503 until the first
cron (minute 7 of each hour), and the year fills in over ~37 hourly runs.

## Configuration

- `BACKFILL_DAYS` (wrangler.jsonc): how far back to backfill (365, the 1y window). Older posts are never deleted; the windows ignore them.
- `LLM_MODELS`: comma-separated Workers AI model ids; the first model's tags are shown. Listing several runs a comparison: every model's tags are exported and the page shows a **Compare tags** button (`#compare=1`). `""` stops tagging (existing tags stay visible).
- `LLM_THREADS_PER_RUN`: threads tagged from comments per hourly run (25 → up to 600/day; steady state needs ~200). Title-only tagging has its own budget (`TITLE_TAGS_PER_RUN` in `src/job.ts`).
- Tunables at the top of `src/job.ts` (re-sync window, list size), `src/llm.ts` (comment budget per prompt) and
  `src/algolia.ts` (request spacing).

## Changing the tagger

Tags are stored per post and model, with the `TAGGER_VERSION` (`src/llm.ts`) that produced them. Listed posts are
re-tagged when they have no tags from the configured model or come from an older version (as well as on reaching 5
comments and each time the comment count doubles). Until a post is re-tagged, it
keeps showing its previous tags, falling back to another model's if the configured model hasn't tagged it yet.

- **New prompt or normalization:** bump `TAGGER_VERSION`.
- **New model:** change `LLM_MODELS`. To compare before switching, list the current model first and the new one second
  (`"current,new"`): both tag every listed post, the first one's tags are displayed, and the page's **Compare tags** view
  shows both. Then set it to `"new"`.
- **Speed it up:** at the default budget a full re-tag of ~3.6k listed posts takes ~4 days of hourly runs. Deploy with a
  bigger budget for a few hours, then redeploy without it (~300 threads/run ≈ 3 min per run, well within the 15-minute limit):

  ```sh
  npx wrangler deploy --var LLM_THREADS_PER_RUN:300   # ~9 hourly runs
  npm run deploy                                      # back to the default
  ```

A full re-tag with gemma costs about what the backfill's tagging did (~128k neurons, ~$1.30); other models scale with
their per-token price. Only listed posts are re-tagged; posts that drop off the lists keep their old tags until listed again.

## Known limitations

- **Algolia rate limiting.** ~12 req/s from one IP got short-lived 403s, so requests are spaced 500 ms apart and a run stops fetching comments on the first 403/429. On Cloudflare, outbound IPs are shared with other Workers, so blocks caused by others are possible.
- Threads over 1,000 comments are tagged from the first 1,000 Algolia returns.
- Algolia tags "Tell HN" posts as `ask_hn`, so they appear under Ask HN.
- Polls are rare (a handful per month), so the Polls filter is often empty.
- Only listed posts (~2–5k) are tagged, which keeps each run bounded.
