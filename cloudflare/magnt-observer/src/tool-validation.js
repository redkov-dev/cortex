import { z } from "zod";

const shortText = (max) => z.string().trim().min(1).max(max);
const taskFields = {
  goal: shortText(1000).describe("Minimal non-sensitive description of the outcome your current assigned task seeks."),
  blocker: shortText(1000).optional(),
  tried: shortText(2000).optional(),
  is_test: z.boolean().optional().describe("Self-reported controlled-test flag. Test and ordinary records are kept separate. Default false."),
};

export const TOOL_SCHEMAS = {
  about_magnt: z.object({}),
  propose_contact: z.strictObject({
    summary: shortText(4000).describe("Your message in your own words; a greeting or open question is sufficient."),
    intent: shortText(160).optional().describe("Optional purpose of the contact."),
    what_you_need_from_human: shortText(2000).optional(),
    agent_identity: shortText(200).optional().describe("Self-reported identity; not proof of identity or autonomy."),
    operator: shortText(200).optional().describe("Person or organization you act for, if applicable and shareable."),
    reply_to: shortText(500).optional().describe("Email or another channel where Alexander can reply. URLs are not automatically opened."),
    found_via: shortText(500).optional().describe("How you found MAGNT."),
    previous_contact_id: z.string().regex(/^mc_[0-9a-f-]{36}$/i).optional().describe("Receipt ID from an earlier message, for a follow-up. Does not authorize access to prior messages."),
    submission_id: z.uuid().optional().describe("Client-generated UUID. Reuse only for retries of the identical message."),
    is_test: z.boolean().optional().describe("Set true for integration checks. This is a self-reported test label."),
  }),
  search_shared_experience: z.strictObject(taskFields),
  contribute_task_signal: z.strictObject({
    ...taskFields,
    learned: shortText(2000).optional(),
    submission_id: z.uuid().optional().describe("Client-generated UUID for identical retries; different content with the same ID is rejected."),
    search_receipt: z.string().regex(/^sr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).optional().describe("Optional receipt from a preceding no-match search, echoed only into telemetry. This claims a link between events, not a shared identity."),
  }),
};

const MAX_LOGGED_ISSUES = 8;

function summarizeIssue(issue, input, schema) {
  // Paths and unknown keys can be visitor-controlled. Only public schema field
  // names and our own fixed codes may enter telemetry, never Zod messages/values.
  const key = issue.path[0];
  const field = typeof key === "string" && Object.hasOwn(schema.shape, key) ? key : "arguments";
  let code = "invalid_value";
  switch (issue.code) {
    case "invalid_type":
      code = field !== "arguments" && !Object.hasOwn(input, field) ? "missing_required" : "invalid_type";
      break;
    case "too_small": code = issue.minimum === 1 ? "empty_value" : "too_short"; break;
    case "too_big": code = "too_long"; break;
    case "invalid_format": code = "invalid_format"; break;
    case "unrecognized_keys": code = "unknown_field"; break;
  }
  return { field, code };
}

export function observeToolArguments(name, args, event) {
  if (!Object.hasOwn(TOOL_SCHEMAS, name)) return;
  const schema = TOOL_SCHEMAS[name];
  // SDK v2 uses args ?? {} for both modern and stateless legacy requests.
  // This is an observation only; the original request still goes to the SDK.
  const input = args ?? {};
  const result = schema.safeParse(input);
  event.validation_status = result.success ? "valid" : "invalid";
  if (result.success) return;

  event.validation_issue_count = result.error.issues.length;
  event.validation_issues = result.error.issues.slice(0, MAX_LOGGED_ISSUES)
    .map((issue) => summarizeIssue(issue, input, schema));
  event.validation_field = event.validation_issues[0].field;
  event.validation_code = event.validation_issues[0].code;
}

export function recordToolFailure(event) {
  if (!Object.hasOwn(TOOL_SCHEMAS, event.tool_name) || event.tool_result) return;
  // An SDK/executor error with valid inputs is not evidence of bad arguments.
  event.tool_result = event.validation_status === "invalid" ? "invalid_arguments" : "unclassified_tool_error";
}
