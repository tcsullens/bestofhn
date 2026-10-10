import { test } from "node:test";
import assert from "node:assert/strict";
import { displayTags } from "../src/job.ts";

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const LLAMA = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const OLD = "@cf/old/model";

test("displayTags shows the configured model's tags", () => {
  const rows = [
    { model: LLAMA, tags: ["rust"], updated_at: 200 },
    { model: GEMMA, tags: ["zig"], updated_at: 100 },
  ];
  assert.deepEqual(displayTags(rows, GEMMA), ["zig"]);
});

test("displayTags falls back to the most recent other model's tags after a model switch", () => {
  const rows = [
    { model: OLD, tags: ["older"], updated_at: 100 },
    { model: LLAMA, tags: ["newer"], updated_at: 200 },
  ];
  assert.deepEqual(displayTags(rows, GEMMA), ["newer"]);
});

test("displayTags skips empty (unparseable) tags when falling back", () => {
  const rows = [
    { model: GEMMA, tags: [], updated_at: 300 },
    { model: OLD, tags: ["kept"], updated_at: 100 },
  ];
  assert.deepEqual(displayTags(rows, GEMMA), ["kept"]);
  assert.deepEqual(displayTags([], GEMMA), []);
  assert.deepEqual(displayTags(rows, undefined), ["kept"]);
});
