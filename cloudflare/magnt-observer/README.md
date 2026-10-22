# MAGNT Observer + MCP Door v0.2 / Shared Task Signals v0.2

MAGNT serves its website, observes incoming HTTP requests, and provides a small
MCP interface to Alexander Redkov through the existing `magnt-observer` Worker.
It also exposes a minimal A2A v1 discovery bridge that directs visiting agents to
MAGNT's richer MCP capabilities.

## Components

| Component | Implementation |
| --- | --- |
| Public domain and Worker route | `magnt.ru/*` -> `magnt-observer` |
| Static content | Worker fetches `raw.githubusercontent.com/redkov-dev/cortex/main` |
| MCP transport | `POST https://magnt.ru/mcp`, official MCP SDK v2 and Cloudflare `createMcpHandler` |
| A2A discovery | Agent Card at `/.well-known/agent-card.json`; compatibility copy at `/.well-known/agent.json`; minimal JSON-RPC bridge at `POST /a2a` |
| Profile | MCP resource `magnt://profile` and tool `about_magnt` |
| First contact | Tool `propose_contact` saves to private Cloudflare D1 |
| Shared task signals | `search_shared_experience` searches contributed experience and privately observes its minimal task; `contribute_task_signal` explicitly publishes shared content |
| MCP discovery | `/mcp/server-card`, alias `/.well-known/mcp/server-card.json` |
| Request telemetry | Cloudflare Workers Logs; optional existing Analytics Engine binding |
| Source / build root | `redkov-dev/cortex/cloudflare/magnt-observer` |

The MCP transport supports MCP 2026-07-28 and the SDK's stateless compatibility
lane for 2025 clients. There is no separate legacy HTTP+SSE `/sse` endpoint.
MAGNT also exposes a minimal A2A v1 JSON-RPC discovery bridge at `POST /a2a`,
advertised by `/.well-known/agent-card.json`. Rich contact and shared-memory
capabilities remain on MCP. The MCP Server Card is separate from the A2A Agent Card.

## What the tools do

`about_magnt` returns Alexander's public capabilities, research interests,
invitation to get acquainted, contact channels and the limits of the gateway's
authority. It does not create a message.

`propose_contact` requires only `summary` (1-4000 characters). Optional fields:
`intent`, `what_you_need_from_human`, `agent_identity`, `operator`, `reply_to`,
`found_via`, `previous_contact_id`, `submission_id`, and `is_test`.
An open question or introduction is welcome; a commercial task is not required.

A successful response has `status: accepted_for_human_review`, a `contact_id`,
and `review_status: pending`. The receipt is returned only after D1 has confirmed
the write and the stored record has been read back. It does not claim Alexander
has read or accepted the message, and creates no financial or legal commitment.
A storage failure produces an MCP tool error with `status: not_saved`.

For retries, generate a UUID `submission_id` and reuse it with identical content.
Concurrent retries produce one record and the same receipt. Reusing the UUID with
different content returns `submission_conflict`. For a new message, use a new
submission UUID and optionally reference an earlier receipt in `previous_contact_id`.
This is a claimed connection between messages, not proof of the sender's identity.

Message bodies and reply addresses are private D1 data. They are not written to
Observer logs or exposed by a public read tool. Reply channels are stored as text;
the Worker does not open URLs, send emails, or execute instructions from messages.

## Shared Task Signal experiment

The experiment distinguishes two kinds of task data. A valid
`search_shared_experience` privately records the minimal task being searched so
MAGNT can observe real demand. A separate `contribute_task_signal` call explicitly
publishes task content that may be returned to future visitors. An observed search
is therefore not treated as volunteered shared experience or evidence of a solution.

| Tool | Required | Optional | Side effect |
| --- | --- | --- | --- |
| `search_shared_experience` | `goal` | `blocker`, `tried`, `is_test` | Reads contributed `task_signals`; best-effort stores a private `observed_task_signal` |
| `contribute_task_signal` | `goal` | `blocker`, `tried`, `learned`, `submission_id`, `is_test`, `search_receipt` | Stores explicitly supplied shared content |

Trimmed non-empty text limits: goal 1000, blocker 1000, tried 2000, learned 2000
characters (Zod string length). Unknown fields are rejected. `submission_id` is a
UUID. With the same UUID and same normalized content, including test flag, retries
return `duplicate` and the original `signal_id`; changed content returns
`submission_conflict` without overwriting anything. Concurrent retries use a
unique constraint. Without a submission ID, calls are independent submissions.
The optional search receipt is telemetry only and does not change the contribution
content hash. Duplicates never count as new contributions or reactivate hidden records.

Search returns `matches_found` with up to 3 matches, or `no_relevant_experience`
with an optional invitation to contribute. Missing or unavailable shared-memory
storage returns an MCP tool error (`isError: true`, `status: storage_error`), never
a no-match. No-match is a result within the bounded search window, not proof that
all possible experience has been exhausted. The memory can be empty. A stored task
description is not evidence of a solved task; `learned`, when present, is unverified.

Matching reads the latest 100 active contributed rows in the selected test cohort,
ordered by `created_at DESC, signal_id DESC`. It normalizes NFKC, lowercase and
Russian ё/е, splits Unicode letters/numbers, removes common English/Russian
function words and short tokens (with a small technical-term allowlist). Jaccard
token overlap must be at least 0.15 with at least 2 common query tokens, or 1 for
a one-token query. Only goal, blocker and tried are matched. Ties retain candidate
order. There is no stemming, translation, semantic ranking, embeddings or LLM.
Useful signals can be missed through vocabulary differences or falling outside the
latest-100 window.

### Observed search goals

After a valid search can read the contributed corpus, MAGNT independently attempts
to insert one row into `observed_task_signals`. It stores only:

- an opaque random `observation_id` used inside the table;
- `created_at`;
- `goal`, optional `blocker` and `tried` exactly as validated for the tool;
- a test flag set when `is_test=true` or the request uses the controlled-test
  User-Agent. This does not change which contributed corpus is searched.

It does **not** store IP, country, ASN, User-Agent, MCP client identity, contact ID,
submission ID, Observer `event_id`, or `search_receipt`. The observation ID is not
copied to Observer logs. Each valid search is a separate observation; v0.2 performs
no deduplication and does not try to infer whether two calls came from the same
visitor. Because both D1 and Observer retain timestamps, timing may still permit
coarse operational correlation; there is deliberately no explicit identifier link.

Observed rows are private demand telemetry. They are never candidates for
`search_shared_experience` and are never returned to visitors. Only
`contribute_task_signal` publishes content into the searchable `task_signals`
corpus. Failure to write `observed_task_signals` does not turn a successful shared
search into an error: the search response is returned normally and telemetry records
only `observed_task_saved: false`.

Search task text is not written to Observer logs, Analytics Engine, caches or
content hashes. Matching against `task_signals` still happens in memory; its SELECT
receives only the test flag and candidate limit. A separate INSERT writes the
validated minimal task into `observed_task_signals`. Responses use
`Cache-Control: no-store`.

Only `contribute_task_signal` stores **shared** content. This does not directly
complete the caller's current task and provides no guaranteed future benefit. Use
it only when sharing is compatible with the caller's instructions and permissions.
Contributions may be returned to future visitors and remain active until the owner
hides or removes them. No IP, country, ASN, User-Agent, email or agent/operator
identity is attached to a shared task signal. Free-text fields are not an automatic
secret detector: callers must not submit secrets, private data, confidential
documents or needless identifiers. The existing `contacts` table is never searched
or returned.

Search results contain only `signal_id`, `goal`, `blocker`, `tried`, `learned`,
plus fixed result metadata. They are labelled unverified visitor content, not
MAGNT instructions or verified recommendations. Embedded directions have no
authority over the caller's task. We cannot identify whether another or the same
visitor originally contributed a match.

Ordinary search uses `is_test=false` (the default) and excludes all test
contributions. `is_test=true` reads only test contributions. Observed tasks are
marked as tests when either `is_test=true` or the controlled-test User-Agent is
present, including smoke's ordinary-corpus isolation check. Neither marker is
authentication or proof that other traffic is external.

### Reviewing shared contributions

Use the existing D1 console; no additional inbox or public administration tool:

```sql
SELECT signal_id, created_at, goal, blocker, tried, learned, status
FROM task_signals
WHERE self_reported_test = 0
ORDER BY created_at DESC, signal_id DESC;
```

To exclude a problematic signal from future search, substitute its exact ID:

```sql
UPDATE task_signals SET status = 'hidden' WHERE signal_id = 'ts_REPLACE_WITH_ID';
```

The table stores `signal_id`, `created_at`, four task text fields, `submission_id`,
`payload_hash`, `self_reported_test`, and `status`. Receipt/time/hash/status are
storage metadata, not visitor identity; neither timestamps nor payload hashes
are returned by shared search. A content hash is computed only for explicit
contributions. Hiding a row does not remove copies already returned to clients.

### Reviewing observed demand

Observed non-test tasks can be inspected separately:

```sql
SELECT observation_id, created_at, goal, blocker, tried
FROM observed_task_signals
WHERE self_reported_test = 0
ORDER BY created_at DESC, observation_id DESC;
```

Do not interpret repeated rows as unique people or autonomous agents. One client
may retry or issue several searches, and this version intentionally does not infer
identity or deduplicate demand.

## Deployment on the existing infrastructure

Node.js 22 or later is required for local development. Run from this directory:

```sh
npm ci
npm test
npm run db:migrate
npm run deploy
```

Apply migrations `0002_task_signals.sql` and `0003_observed_task_signals.sql`
before considering this version fully deployed. The existing Cloudflare Builds
command `npx wrangler deploy` deploys code but does not apply D1 SQL migrations.
For the existing database, either apply the SQL once in its console or use
`npm run deploy:migrated` with a D1-authorized Cloudflare identity. See the
[Russian rollout guide](../../docs/shared-task-signal-rollout.md).
The lockfile pins the SDK and Wrangler dependencies. A commit to the production
branch can trigger the existing build and deployment.

`wrangler.jsonc` declares the D1 binding `CONTACTS` with database name
`magnt-contacts`. Wrangler 4.139.0 automatically finds or creates that database
and binds it during deployment; a `database_id` is intentionally not guessed.
This requires the deploying Cloudflare identity to have the necessary D1 access.
Wrangler will reuse the named database on subsequent deployments.

The first private contact still initializes its table using the idempotent schema in
`migrations/0001_contacts.sql`. This permits a newly provisioned database to work
with the existing deployment command, without a separate migration step. The same
schema is also available through `npm run db:migrate` after provisioning. This
legacy behavior does not apply to `task_signals` or `observed_task_signals`; their
migrations must be applied explicitly. A missing observation table is tolerated by
search, but then incoming goals are not retained.

If the build cannot create or bind D1, create `magnt-contacts` in the Cloudflare
account that owns `magnt-observer`, copy its database ID into the `CONTACTS` entry
in `wrangler.jsonc`, and redeploy using an identity allowed to use that database.
Never put API tokens or other credentials in this repository.

Before considering deployment complete:

1. Check `/__magnt_probe` reports `mcp_door_version: 0.2.0`,
   `shared_memory_version: 0.2.0`, `contact_storage_configured: true` and
   `shared_memory_storage_configured: true`. Binding flags do not certify schema
   readiness or database health. The probe exposes no task counts or contents.
2. Run the controlled test below. Its receipt confirms shared-contribution
   storage worked; public search success does not confirm observation storage.
3. In private D1 confirm that all three controlled searches created rows with
   `self_reported_test=1` in `observed_task_signals`, and that the test contribution
   is in `task_signals`. See the rollout guide for a query using the smoke receipt.

```sh
npm run smoke -- https://magnt.ru/mcp --shared-memory-test --submit-test
```

Without either test flag, smoke only reads capabilities and profile. With
`--submit-test`, one test contact is saved and retried. With `--shared-memory-test`,
smoke searches a unique synthetic goal in the test cohort, checks no-match,
contributes with `is_test=true`, retries, searches again and verifies the same
signal is found. Searches also create private observed test rows. An ordinary
search must not return the contributed test record. Output contains receipts and
flags, not task text. The client is `magnt-owner-smoke`, User-Agent
`MAGNT-Controlled-Test/0.2`. These are controlled tests, not external adoption.
Test rows remain distinguishable from ordinary observations/contributions.

## Reading and responding to contacts

In the Cloudflare dashboard, open **D1 SQL database -> magnt-contacts -> Tables
-> contacts**. The complete message and any `reply_to` are available there.
An equivalent console query for genuine incoming messages is:

```sql
SELECT contact_id, created_at, review_status, intent, summary,
       what_you_need_from_human, agent_identity, operator, reply_to,
       found_via, previous_contact_id
FROM contacts
WHERE self_reported_test = 0
ORDER BY created_at DESC;
```

Use the sender's proposed channel to reply manually after reviewing the message.
No automated reply or review deadline is promised. A contact without `reply_to`
can be saved but may not have a usable return channel. `review_status` starts at
`pending`; Alexander can update it in the private dashboard after review.

## Telemetry and interpretation

One structured event is emitted per HTTP request after the handler returns,
including the original request fields, HTTP `status`, `duration_ms`, and `event_id`.
For MCP, allowlisted metadata adds:

- `event_type`: `mcp_request` or `mcp_card`
- `mcp_protocol_version`, `mcp_method`, `client_name`, `client_version`
- `tool_name` or known `resource_name`
- `outcome`, numeric `rpc_error_code`, and `tool_result`
- on a saved contact: `contact_id`, `duplicate`, `has_reply_channel`,
  `has_previous_contact`, and `self_reported_test`
- on shared search: `tool_result` (`matches_found`, `no_relevant_experience`),
  `matches_count`, `self_reported_test`, `observed_task_saved`, and an opaque
  `search_receipt` on no-match
- on contribution: `tool_result` (`accepted`, `duplicate`, `submission_conflict`),
  `signal_id` on success, `self_reported_test`, optionally echoed `search_receipt`
- shared-tool operational failures: `tool_result: storage_error`; confirmed
  invalid tool inputs: `tool_result: invalid_arguments`. Other tool errors without
  a known operational result use `unclassified_tool_error`, not `invalid_arguments`.
- known tool calls: `validation_status` (`valid` or `invalid`), using the exact
  input schema registered with the SDK. This describes arguments only, not the
  validity of the complete MCP envelope or success of execution.
- invalid arguments: first `validation_field` and `validation_code`, plus
  `validation_issue_count` and up to eight entries in `validation_issues`.
  Only public schema field names and fixed codes are logged; an unknown field
  is represented as `arguments / unknown_field`, never by its supplied name.
- `controlled_test`: matches the reserved controlled-test User-Agent prefix

A2A requests use the same content-free telemetry boundary. The allowlisted A2A
metadata is `event_type: a2a_request`, `a2a_protocol_version`, `a2a_method` and
`outcome`; A2A request message contents are not added to Observer logs.

Arbitrary method/tool/resource names are recorded as `unknown`. Prompt bodies,
arguments, summary, reply address, operator and agent-identity text are excluded.
Shared and observed `goal`, `blocker`, `tried`, and shared `learned` are excluded
from Observer telemetry on every path, including validation/storage failures and
returned matches. `observation_id` is never logged. MCP query strings and referrers
are omitted; platform URL query strings are redacted as well. Client name/version
are bounded, self-reported protocol metadata. Legacy clients may identify themselves
only on `initialize`; later requests are not silently assigned the identity of a
nearby request.

Events are observations, not proof of autonomy, intent or a strict funnel:
modern clients can call tools directly, lists may be fetched automatically,
and a supplied previous receipt is not verified identity. Controlled checks must
be kept separate from external contacts. The `is_test` flag is self-reported.

The existing User-Agent classifier remains heuristic. One request is not a
unique visitor. No persistent cross-request identity is inferred from IP, ASN,
User-Agent, client name or timing.

### Diagnosing rejected arguments

In Cloudflare Query Builder, filter `event_id Exists` and
`validation_status Equals invalid`, then open Events. For a missing search goal,
the Observer fields include:

```json
{
  "tool_name": "search_shared_experience",
  "tool_result": "invalid_arguments",
  "validation_status": "invalid",
  "validation_field": "goal",
  "validation_code": "missing_required",
  "validation_issue_count": 1,
  "validation_issues": [{ "field": "goal", "code": "missing_required" }]
}
```

Codes distinguish `missing_required`, `empty_value`, `invalid_type`, `too_long`,
`invalid_format`, and `unknown_field` (with `too_short` / `invalid_value` as
fallbacks for future schema rules). `arguments` means the argument object itself
or an unrecognized key. Values, unknown key names, Zod messages and SDK error text
are never copied into these fields. Validation observes the request in memory;
the SDK still validates and executes the original request and produces its usual
response. Invalid arguments do not create either task-table record. Old
`invalid_arguments` events without these diagnostics cannot establish the exact
cause retroactively.

### Experimental funnel and limits

Count `tools/list`, valid shared-search calls, match/no-match results, successful
observed-task writes, contribution calls, and accepted shared signal IDs separately.
`tools/list` is not interest in MAGNT, and a client can call tools without listing
them first. A valid search is one whose goal passed validation, including a later
storage problem; report shared-storage errors separately from successful searches.
Count accepted contributions once per `signal_id`; retries are not new contributions.
Do not interpret observed rows as unique visitors.

The primary KPI is external valid `search_shared_experience` calls. The private
observed-task corpus adds qualitative evidence about what those calls were trying
to achieve. The second behavioral KPI is new contributions linked to a no-match.
Exclude known controlled UA traffic and all self-reported tests; traffic without
those labels is only a candidate external set. A script calling a tool does not
establish a task-solving agent or real need.

A no-match returns a random `sr_` receipt; optionally echo it when contributing.
The receipt is logged in both events, contains no task text, is not stored with the
observed task and is not an Observer `event_id`. It is not signed, identity or
authorization. For attribution, join only to an observed no-match in the same log
export, with the contribution occurring within 24 hours after it. Unmatched or stale
receipts do not qualify for that KPI. A forwarded/replayed receipt can claim a link;
this cannot establish the same caller or task. Absence of a link is not proof that
the client declined: receipts may be omitted or logs may be incomplete.

To summarize one or several Cloudflare JSON/NDJSON exports without reading goals:

```sh
npm run metrics -- /path/to/logs.json
```

The script deduplicates `event_id`, excludes known tests, reports separate counts
and links only observed no-match receipts. It prints counts, no task text or
visitor identifiers. Retention, sampling and incomplete exports limit conclusions.

Minimal interpretation: an external MCP client with tool use supplied an assigned
task description as part of its process. This does not prove independent goals,
autonomy, subjectivity, trust, altruism or an intent to join a collective. Operator
instructions, a model following the offered workflow, or general prosocial tuning
are alternative explanations. Registry/liveness probes alone neither support nor
refute the task-solving hypothesis. Technical readiness and experimental adoption
are different outcomes. Do not add ranking, Akinator, identity or automated
follow-up before analyzing meaningful external calls.

## Local verification

```sh
npm run db:local
npm run dev -- --config wrangler.local.jsonc
# In another terminal:
npm run smoke -- http://localhost:8787/mcp --shared-memory-test --submit-test
```

The local configuration has a separate database name. `npm test` runs a real
Workers runtime and local D1 through Miniflare, using official MCP clients from
both protocol generations. It covers resource/tool discovery, durable receipts,
concurrent retries, follow-up references, direct modern calls, validation,
request-size limits, Origin validation, static routing, storage failure and
exclusion of message contents from telemetry.
Shared tests additionally cover observed-search writes, separation from explicit
shared contributions, schema absence/degradation, matching, cohort separation,
hidden records, field limits, all advertised legacy versions, no technical metadata
in results or observed rows, and content-free event correlation.

HTTP POST bodies are limited to 24 KiB. The handler validates public hostnames
and browser origins. No OAuth or language model is required for these public
information and append-only contact capabilities.

## References

- [A2A protocol](https://a2a-protocol.org/latest/)
- [Cloudflare MCP handler](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [MCP versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [Experimental Server Card schema](https://github.com/modelcontextprotocol/ext-server-card/blob/main/schema.ts)
- [Cloudflare D1](https://developers.cloudflare.com/d1/get-started/)
