#!/usr/bin/env bash
# One-off: fill the local D1/R2 with BACKFILL_DAYS of posts and tags by running the hourly job back-to-back with a
# bigger tagging budget, until the backfill window is covered and no listed post is left to tag. The local database
# can then seed a fresh Cloudflare deployment (see README).
#
# Usage: scripts/backfill.sh            (stop `npm run dev` first; this starts its own dev server on the same port)
# Env:   LLM_THREADS_PER_RUN (default 300), MAX_RUNS (default 100)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8787
LOG=$(mktemp -t bestofhn-backfill.XXXXXX)
echo "dev server log: $LOG"

npx wrangler d1 migrations apply bestofhn --local
npx wrangler dev --port "$PORT" --var "LLM_THREADS_PER_RUN:${LLM_THREADS_PER_RUN:-300}" >"$LOG" 2>&1 &
DEV=$!
trap 'kill "$DEV" 2>/dev/null; wait "$DEV" 2>/dev/null || true' EXIT # keep the script's own exit status
until grep -aq "Ready on" "$LOG"; do
  kill -0 "$DEV" 2>/dev/null || { echo "dev server exited:"; tail -20 "$LOG"; exit 1; }
  sleep 1
done

summaries() { tr -d '\000' <"$LOG" | grep -a '"backfillDone"' || true; }

for run in $(seq 1 "${MAX_RUNS:-100}"); do
  before=$(summaries | wc -l)
  # A failed trigger isn't fatal: each run picks up wherever the previous one stopped.
  curl -sf "http://localhost:$PORT/cdn-cgi/local/scheduled" >/dev/null || echo "run $run: trigger failed (curl exit $?)"
  # The job's summary line can reach the log a moment after the trigger returns.
  for _ in $(seq 1 30); do [ "$(summaries | wc -l)" -gt "$before" ] && break; sleep 1; done
  summary=$(summaries | tail -1)
  echo "run $run: $summary"
  if node -e 'const s = JSON.parse(process.argv[1]); process.exit(s.backfillDone && s.due === 0 ? 0 : 1)' "$summary"; then
    echo "backfill complete after $run runs"
    exit 0
  fi
done
echo "stopped after MAX_RUNS without finishing; run again to continue" >&2
exit 1
