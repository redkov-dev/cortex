import assert from "node:assert/strict";
import test from "node:test";
import { collectEvents, summarizeEvents } from "../scripts/shared-memory-metrics.mjs";

test("metrics deduplicate exports, exclude tests and correlate only observed no-match receipts", () => {
  const base = { event_type: "mcp_request", path: "/mcp", mcp_method: "tools/call", time: "2026-10-14T08:00:00Z" };
  const search = { ...base, event_id: "1", tool_name: "search_shared_experience", tool_result: "no_relevant_experience", search_receipt: "sr_one" };
  const contribution = { ...base, event_id: "2", tool_name: "contribute_task_signal", tool_result: "accepted", signal_id: "ts_one", search_receipt: "sr_one", time: "2026-10-14T08:01:00Z" };
  const input = [search, { logs: [{ message: [JSON.stringify(search)] }] }, contribution,
    { ...contribution, event_id: "3", tool_result: "duplicate" },
    { ...search, event_id: "4", self_reported_test: true },
    { ...search, event_id: "5", userAgent: "MAGNT-Controlled-Test/0.2" },
    { ...contribution, event_id: "6", signal_id: "ts_unknown", search_receipt: "sr_unknown" },
    { ...contribution, event_id: "7", signal_id: "ts_expired", time: "2026-10-16T08:00:00Z" },
    { ...contribution, event_id: "8", signal_id: "ts_earlier", time: "2026-10-13T08:00:00Z" },
    { ...base, event_id: "9", mcp_method: "tools/list" },
  ];
  const result = summarizeEvents(collectEvents(input));
  assert.equal(result.observed_mcp_events, 9);
  assert.equal(result.excluded_test_events, 2);
  assert.equal(result.tools_list, 1);
  assert.equal(result.valid_search_calls, 1);
  assert.equal(result.accepted_signals, 4);
  assert.equal(result.duplicate_contributions, 1);
  assert.equal(result.accepted_signals_linked_to_no_match, 1);
  assert.equal(result.no_match_searches_with_contribution, 1);
});
