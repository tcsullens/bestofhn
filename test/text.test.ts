import { test } from "node:test";
import assert from "node:assert/strict";
import { threadTerms, tokenize } from "../src/text.ts";
import { postType } from "../src/algolia.ts";

test("tokenize strips HTML, entities, URLs and stopwords, keeps tech tokens", () => {
  const html =
    `<p>I don&#x27;t think <i>Rust&#x27;s</i> borrow checker is the problem.<p>See ` +
    `<a href="https://example.com/x">https://example.com/x</a> &amp; compare with C++, C# and node.js`;
  assert.deepEqual(tokenize(html), ["rust", "borrow", "checker", "problem", "compare", "c++", "c#", "node.js"]);
});

test("threadTerms counts each word once per comment and merges inflections under one stem", () => {
  const terms = threadTerms([
    "models models models everywhere",
    "the model is better",
    "these models are fine",
    "unrelated comment",
  ]);
  const model = terms.find(([stem]) => stem === "model");
  assert.deepEqual(model, ["model", 3, "models"]);
  // words that appear in only one comment are dropped
  assert.equal(
    terms.find(([stem]) => stem === "unrel"),
    undefined,
  );
});

test("postType distinguishes Ask/Show HN and polls from plain stories", () => {
  assert.equal(postType(["story", "author_x", "story_1", "ask_hn"]), "ask");
  assert.equal(postType(["story", "show_hn"]), "show");
  assert.equal(postType(["poll", "author_x"]), "poll");
  assert.equal(postType(["story", "front_page"]), "story");
});
