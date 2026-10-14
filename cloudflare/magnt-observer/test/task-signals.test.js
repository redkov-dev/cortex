import assert from "node:assert/strict";
import test from "node:test";
import { tokens, rankSignals, searchSignals } from "../src/task-signals.js";

test("token matching handles Unicode, punctuation, repetition and common words", () => {
  assert.deepEqual([...tokens("The Cloudflare, CLOUDFLARE! D1 для учёта")], ["cloudflare", "d1", "учета"]);
  assert.equal(tokens("the and нужно чтобы").size, 0);
  assert.equal(rankSignals({ goal: "the and" }, [{ signal_id: "a", goal: "the and" }]).length, 0);
  assert.equal(rankSignals({ goal: "database migration permissions" }, [{ signal_id: "a", goal: "calendar scheduling collision" }]).length, 0);
});

test("ranking favors overlap, returns at most three, and breaks ties in candidate order", () => {
  const rows = [
    { signal_id: "partial", goal: "database migration cloudflare" },
    ...["newer", "older", "third", "fourth"].map((signal_id) => ({ signal_id, goal: "database migration permissions" })),
  ];
  assert.deepEqual(rankSignals({ goal: "database migration permissions" }, rows).map((r) => r.signal_id), ["newer", "older", "third"]);
  assert.equal(rankSignals({ goal: "database migration permissions" }, [{ signal_id: "weak", goal: "database unrelated topics" }]).length, 0);
});

test("search never passes task text to SQL and never invokes a write", async () => {
  const queries = [];
  const db = { prepare(sql) {
    queries.push(sql);
    assert.match(sql.trim(), /^SELECT /);
    return { bind(...args) {
      assert.deepEqual(args, [0, 100]);
      return { all: async () => ({ success: true, results: [] }) };
    } };
  } };
  assert.deepEqual(await searchSignals(db, { goal: "QUERY_NEVER_IN_SQL", blocker: "BLOCKER_NEVER_IN_SQL", tried: "TRIED_NEVER_IN_SQL" }), []);
  assert.equal(queries.length, 1);
  assert.ok(!queries[0].includes("NEVER_IN_SQL"));
});
