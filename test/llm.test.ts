import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessages, parseTags, selectComments } from "../src/llm.ts";

test("parseTags reads JSON from a reply with surrounding prose or code fences", () => {
  assert.deepEqual(parseTags('Sure!\n```json\n{"tags": ["Rust", "borrow checker"]}\n```'), ["rust", "borrow checker"]);
  assert.deepEqual(parseTags('["deno", "bun"]'), ["deno", "bun"]);
});

test("parseTags normalizes, dedupes, drops junk and caps at 3", () => {
  const reply = JSON.stringify({
    tags: ["H-1B Visas!", "h-1b visas", "x", "a tag that is far too many words", "  Open   Source ", "wages", "extra"],
  });
  assert.deepEqual(parseTags(reply), ["h-1b visas", "open source", "wages"]);
});

test("parseTags drops generic non-topic words", () => {
  assert.deepEqual(parseTags('{"tags": ["Decision", "vote", "esim", "info", "disable"]}'), ["esim"]);
  assert.equal(parseTags('{"tags": ["discussion", "update"]}'), null);
});

test("parseTags folds synonyms and keeps at most one broad tag", () => {
  const reply = JSON.stringify({
    tags: ["Large Language Models", "artificial intelligence", "LLM", "reward hacking", "ai models", "EU"],
  });
  assert.deepEqual(parseTags(reply), ["llms", "reward hacking", "eu"]);
});

test("parseTags returns null when there is nothing usable", () => {
  assert.equal(parseTags("I can't help with that."), null);
  assert.equal(parseTags('{"tags": []}'), null);
  assert.equal(parseTags('{"tags": "rust"}'), null);
});

test("selectComments puts top-level comments first and respects the budget", () => {
  const comments = [
    { text: "<p>a reply</p>", topLevel: false },
    { text: "top &amp; level", topLevel: true },
    ...Array.from({ length: 40 }, () => ({ text: "x".repeat(1500), topLevel: false })),
  ];
  const picked = selectComments(comments);
  assert.equal(picked[0], "top & level");
  assert.equal(picked[1], "a reply");
  assert.ok(
    picked.slice(2).every((c) => c.length === 1000),
    "long comments are truncated",
  );
  assert.ok(picked.join("").length <= 16_000);
});

test("buildMessages includes vocabulary and hints only when present", () => {
  const [system, user] = buildMessages({
    title: "Cloudflare acquires Deno",
    type: "story",
    domain: "deno.com",
    comments: [{ text: "Bun is faster", topLevel: true }],
    frequentWords: ["deno", "bun"],
    vocabulary: [],
  });
  assert.equal(system.role, "system");
  assert.match(user.content, /^Post \(Story\): Cloudflare acquires Deno\n\nLink: deno.com/);
  assert.match(user.content, /Frequent words in the comments: deno, bun/);
  assert.match(user.content, /- Bun is faster$/);
  assert.doesNotMatch(user.content, /Existing tags/);
});

test("buildMessages for a post tagged from its title alone", () => {
  const [, user] = buildMessages({
    title: "Show HN: A tiny Forth",
    type: "show",
    domain: null,
    comments: [],
    frequentWords: [],
    vocabulary: ["forth"],
  });
  assert.equal(
    user.content,
    "Existing tags: forth\n\nPost (Show HN): Show HN: A tiny Forth\n\n(Comments not included; tag from the title and link.)",
  );
});
