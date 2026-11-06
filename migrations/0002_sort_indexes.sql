-- buildLists (src/job.ts) reads each (window, sort, type) list off these with INDEXED BY.
CREATE INDEX posts_type_points ON posts (type, points);
CREATE INDEX posts_type_num_comments ON posts (type, num_comments);
