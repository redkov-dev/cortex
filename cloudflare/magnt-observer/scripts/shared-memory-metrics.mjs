import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function collectEvents(value, events = new Map()) {
  if (typeof value === "string") {
    try { collectEvents(JSON.parse(value), events); } catch { /* Non-Observer log lines. */ }
  } else if (value && typeof value === "object") {
    if (value.event_type === "mcp_request" && value.path === "/mcp" && typeof value.event_id === "string") {
      events.set(value.event_id, value);
    } else for (const entry of Object.values(value)) collectEvents(entry, events);
  }
  return events;
}

export function summarizeEvents(events) {
  const all = [...events.values()];
  const controlled = (e) => e.controlled_test === true || e.self_reported_test === true || /^MAGNT-Controlled-Test(?:\/|$)/i.test(e.userAgent ?? "");
  const unlabelled = all.filter((e) => !controlled(e));
  const searches = unlabelled.filter((e) => e.mcp_method === "tools/call" && e.tool_name === "search_shared_experience");
  const contributions = unlabelled.filter((e) => e.mcp_method === "tools/call" && e.tool_name === "contribute_task_signal");
  const noMatches = new Map(searches.filter((e) => e.tool_result === "no_relevant_experience" && e.search_receipt)
    .map((e) => [e.search_receipt, e]));
  const accepted = contributions.filter((e) => e.tool_result === "accepted" && e.signal_id);
  const linked = accepted.filter((e) => {
    const previous = noMatches.get(e.search_receipt);
    if (!previous) return false;
    const elapsed = Date.parse(e.time) - Date.parse(previous.time);
    return elapsed >= 0 && elapsed <= 24 * 60 * 60 * 1000;
  });
  const count = (rows, result) => rows.filter((e) => e.tool_result === result).length;
  return {
    scope: "Provided log export only. Unlabelled traffic is not verified external task-solving traffic.",
    observed_mcp_events: all.length,
    excluded_test_events: all.filter(controlled).length,
    tools_list: unlabelled.filter((e) => e.mcp_method === "tools/list").length,
    search_calls: searches.length,
    valid_search_calls: searches.filter((e) => ["matches_found", "no_relevant_experience", "storage_error"].includes(e.tool_result)).length,
    matches_found: count(searches, "matches_found"),
    no_relevant_experience: count(searches, "no_relevant_experience"),
    search_storage_errors: count(searches, "storage_error"),
    search_invalid_arguments: count(searches, "invalid_arguments"),
    contribution_calls: contributions.length,
    accepted_signals: new Set(accepted.map((e) => e.signal_id)).size,
    duplicate_contributions: count(contributions, "duplicate"),
    contribution_storage_errors: count(contributions, "storage_error"),
    contribution_conflicts: count(contributions, "submission_conflict"),
    accepted_signals_linked_to_no_match: new Set(linked.map((e) => e.signal_id)).size,
    no_match_searches_with_contribution: new Set(linked.map((e) => e.search_receipt)).size,
    correlation: "A caller-echoed receipt matches a preceding no-match in this export within 24 hours. This is a claimed event link, not identity or causation. Missing links may reflect incomplete logs or omitted receipts.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error("Usage: npm run metrics -- logs.json [more-logs.json or logs.ndjson]");
  const events = new Map();
  for (const file of files) {
    const text = await readFile(file, "utf8");
    let value;
    try { value = JSON.parse(text); } catch {
      value = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    }
    collectEvents(value, events);
  }
  console.log(JSON.stringify(summarizeEvents(events), null, 2));
}
