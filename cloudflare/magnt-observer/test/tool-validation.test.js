import assert from "node:assert/strict";
import test from "node:test";
import { observeToolArguments, recordToolFailure } from "../src/tool-validation.js";

test("tool error classification requires evidence and preserves known operational outcomes", () => {
  const cases = [
    [{ validation_status: "invalid" }, "invalid_arguments"],
    [{ validation_status: "valid" }, "unclassified_tool_error"],
    [{}, "unclassified_tool_error"],
    [{ validation_status: "valid", tool_result: "storage_error" }, "storage_error"],
    [{ validation_status: "valid", tool_result: "storage_unavailable" }, "storage_unavailable"],
  ];
  for (const [state, expected] of cases) {
    const event = { tool_name: "search_shared_experience", ...state };
    recordToolFailure(event);
    assert.equal(event.tool_result, expected);
  }
  const unknown = { tool_name: "unknown", validation_status: "invalid" };
  recordToolFailure(unknown);
  assert.equal(unknown.tool_result, undefined);
});

test("validation logs are bounded and never expose extra keys, values or prototype names", () => {
  const input = Object.fromEntries(["summary", "intent", "what_you_need_from_human", "agent_identity", "operator",
    "reply_to", "found_via", "previous_contact_id", "submission_id", "is_test", "PRIVATE_EXTRA_KEY"].map((key) => [key, null]));
  const event = {};
  observeToolArguments("propose_contact", input, event);
  assert.equal(event.validation_issue_count, 11);
  assert.equal(event.validation_issues.length, 8);
  assert.ok(!JSON.stringify(event).includes("PRIVATE_EXTRA_KEY"));

  const extra = {};
  observeToolArguments("search_shared_experience", JSON.parse('{"goal":"PRIVATE_GOAL","__proto__":{"PRIVATE_KEY":"PRIVATE_VALUE"},"constructor":"PRIVATE_VALUE"}'), extra);
  assert.deepEqual(extra.validation_issues, [{ field: "arguments", code: "unknown_field" }]);
  assert.ok(!JSON.stringify(extra).includes("PRIVATE"));
  assert.ok(!JSON.stringify(extra).includes("__proto__"));
  assert.ok(!JSON.stringify(extra).includes("constructor"));
  for (const name of ["unknown", "__proto__", "constructor"]) {
    const ignored = {};
    observeToolArguments(name, {}, ignored);
    assert.deepEqual(ignored, {});
  }
});
