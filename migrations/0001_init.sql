CREATE TABLE posts (
  id INTEGER PRIMARY KEY,           -- HN item id
  type TEXT NOT NULL,               -- story | ask | show | poll
  title TEXT NOT NULL,
  url TEXT,
  author TEXT NOT NULL,
  points INTEGER NOT NULL,
  num_comments INTEGER NOT NULL,
  created_at INTEGER NOT NULL       -- unix seconds
);
CREATE INDEX posts_created_at ON posts (created_at);

CREATE TABLE llm_tags (
  post_id INTEGER NOT NULL,
  model TEXT NOT NULL,              -- Workers AI model id
  tags TEXT NOT NULL,               -- JSON array of tag strings ([] if the reply couldn't be parsed)
  comment_count INTEGER NOT NULL,   -- posts.num_comments when tagged; re-tagged at 5 comments and each time they double
  updated_at INTEGER NOT NULL,      -- unix seconds
  version INTEGER NOT NULL,         -- TAGGER_VERSION (src/llm.ts) that produced the tags; older versions get re-tagged
  PRIMARY KEY (post_id, model)
);
CREATE INDEX llm_tags_model_updated ON llm_tags (model, updated_at);

CREATE TABLE state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL               -- e.g. backfill_cursor: unix seconds the backfill has reached
);
