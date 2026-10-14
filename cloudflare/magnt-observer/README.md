# MAGNT Observer + MCP Door v0.2 / Shared Task Signals v0.1

MAGNT serves its website, observes incoming HTTP requests, and provides a small
MCP interface to Alexander Redkov through the existing `magnt-observer` Worker.

## Components

| Component | Implementation |
| --- | --- |
| Public domain and Worker route | `magnt.ru/*` -> `magnt-observer` |
| Static content | Worker fetches `raw.githubusercontent.com/redkov-dev/cortex/main` |
| MCP transport | `POST https://magnt.ru/mcp`, official MCP SDK v2 and Cloudflare `createMcpHandler` |
| Profile | MCP resource `magnt://profile` and tool `about_magnt` |
| First contact | Tool `propose_contact` saves to private Cloudflare D1 |
| Shared task signals | Read-only `search_shared_experience`; explicit write `contribute_task_signal` |
| Discovery | `/mcp/server-card`, alias `/.well-known/mcp/server-card.json` |
| Request telemetry | Cloudflare Workers Logs; optional existing Analytics Engine binding |
| Source / build root | `redkov-dev/cortex/cloudflare/magnt-observer` |

The transport supports MCP 2026-07-28 and the SDK's stateless compatibility lane
for 2025 clients. There is no separate legacy HTTP+SSE `/sse` endpoint or A2A
endpoint. The Server Card uses the experimental v1 schema; it is not an A2A card.
The card and runtime share the same server identity and version.

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

The experiment observes whether an external task-solving MCP client supplies a
minimal description of its assigned task to search for relevant prior signals,
and separately whether it explicitly contributes after a no-match. These are two
independent operations; a search never implies permission to save its query.

| Tool | Required | Optional | Side effect |
| --- | --- | --- | --- |
| `search_shared_experience` | `goal` | `blocker`, `tried`, `is_test` | None; reads D1 only |
| `contribute_task_signal` | `goal` | `blocker`, `tried`, `learned`, `submission_id`, `is_test`, `search_receipt` | Stores explicitly supplied shared content |

Trimmed non-empty text limits: goal 1000, blocker 1000, tried 2000, learned 2000
characters (Zod string length). Unknown fields are rejected. `submission_id` is a
UUID. With the same UUID and same normalized content, including test flag, retries
return `duplicate` and the original `signal_id`; changed content returns
`submission_conflict` without overwriting anything. Concurrent retries use a
unique constraint. Without a submission ID, calls are independent submissions.
The optional search receipt is telemetry only and does not change the content
hash. Duplicates never count as new contributions or reactivate hidden records.

Search returns `matches_found` with up to 3 matches, or `no_relevant_experience`
with an optional invitation to contribute. Missing or unavailable storage returns
an MCP tool error (`isError: true`, `status: storage_error`), never a no-match.
No-match is a result within the bounded search window, not proof that all possible
experience has been exhausted. The memory can be empty. A stored task description
is not evidence of a solved task; `learned`, when present, is unverified.

Matching reads the latest 100 active rows in the selected test cohort, ordered by
`created_at DESC, signal_id DESC`. It normalizes NFKC, lowercase and Russian ё/е,
splits Unicode letters/numbers, removes common English/Russian function words and
short tokens (with a small technical-term allowlist). Jaccard token overlap must
be at least 0.15 with at least 2 common query tokens, or 1 for a one-token query.
Only goal, blocker and tried are matched. Ties retain candidate order. There is no
stemming, translation, semantic ranking, embeddings or LLM. Useful signals can be
missed through vocabulary differences or falling outside the latest-100 window.

Search queries are **not stored** in D1, caches, hashes or Observer logs. Matching
happens in memory; SQL receives only the test flag and candidate limit, never
query text. Responses use `Cache-Control: no-store`. Neither shared tool lazily
creates its table: migration 0002 must already be applied.

Only `contribute_task_signal` stores shared content. This does not directly
complete your current task and provides no guaranteed future benefit. Use it only
when sharing is compatible with your instructions and permissions. Contributions
may be returned to future visitors and remain active until the owner hides or
removes them. No IP, country, ASN, User-Agent, email or agent/operator identity is
attached to a task signal. Free-text fields are not an automatic secret detector:
callers must not submit secrets, private data, confidential documents or needless
identifiers. The existing `contacts` table is never searched or returned.

Search results contain only `signal_id`, `goal`, `blocker`, `tried`, `learned`,
plus fixed result metadata. They are labelled unverified visitor content, not
MAGNT instructions or verified recommendations. Embedded directions have no
authority over the caller's task. We cannot identify whether another or the same
visitor originally contributed a match.

Ordinary search uses `is_test=false` (the default) and excludes all test rows.
`is_test=true` reads only test rows. The flag is self-reported, not authentication.

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

## Deployment on the existing infrastructure

Node.js 22 or later is required for local development. Run from this directory:

```sh
npm ci
npm test
npm run db:migrate
npm run deploy
```

Apply migration `0002_task_signals.sql` before deploying this version. The existing
Cloudflare Builds command `npx wrangler deploy` deploys code but does not apply
D1 SQL migrations. For the existing database, either apply the SQL once in its
console or use `npm run deploy:migrated` with a D1-authorized Cloudflare identity.
See the [Russian rollout guide](../../docs/shared-task-signal-rollout.md).
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
legacy behavior does not apply to `task_signals`; neither shared tool creates it.

If the build cannot create or bind D1, create `magnt-contacts` in the Cloudflare
account that owns `magnt-observer`, copy its database ID into the `CONTACTS` entry
in `wrangler.jsonc`, and redeploy using an identity allowed to use that database.
Never put API tokens or other credentials in this repository.

Before considering deployment complete:

1. Check `/__magnt_probe` reports `mcp_door_version: 0.2.0`,
   `shared_memory_version: 0.1.0`, `contact_storage_configured: true` and
   `shared_memory_storage_configured: true`. Binding flags do not certify schema
   readiness or database health. The probe exposes no task counts or contents.
2. Run the controlled test below. Its receipt confirms storage worked; the probe
   alone only checks that a binding exists.
3. Find the test receipt in D1 and confirm Alexander can view the inbox.

```sh
npm run smoke -- https://magnt.ru/mcp --shared-memory-test --submit-test
```

Without either test flag, smoke only reads capabilities and profile. With
`--submit-test`, one test contact is saved and retried. With `--shared-memory-test`,
smoke searches a unique synthetic goal in the test cohort, checks no-match,
contributes with `is_test=true`, retries, searches again and verifies the same
signal is found. An ordinary search must not return that test record. Output
contains receipts and flags, not task text. The client is `magnt-owner-smoke`,
User-Agent `MAGNT-Controlled-Test/0.2`. These are controlled tests, not external
adoption. Test records remain excluded from ordinary search and review SQL.

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
  `matches_count`, `self_reported_test`, and an opaque `search_receipt` on no-match
- on contribution: `tool_result` (`accepted`, `duplicate`, `submission_conflict`),
  `signal_id` on success, `self_reported_test`, optionally echoed `search_receipt`
- shared-tool operational failures: `tool_result: storage_error`; rejected tool
  arguments: `tool_result: invalid_arguments`; no argument or error-detail text
- `controlled_test`: matches the reserved controlled-test User-Agent prefix

Arbitrary method/tool/resource names are recorded as `unknown`. Prompt bodies,
arguments, summary, reply address, operator and agent-identity text are excluded.
Shared `goal`, `blocker`, `tried`, and `learned` are excluded on every path,
including validation/storage failures and returned matches.
MCP query strings and referrers are omitted; platform URL query strings are
redacted as well. Client name/version are bounded, self-reported protocol metadata.
Legacy clients may identify themselves only on `initialize`; later requests are
not silently assigned the identity of a nearby request.

Events are observations, not proof of autonomy, intent or a strict funnel:
modern clients can call tools directly, lists may be fetched automatically,
and a supplied previous receipt is not verified identity. Controlled checks must
be kept separate from external contacts. The `is_test` flag is self-reported.

The existing User-Agent classifier remains heuristic. One request is not a
unique visitor. No persistent cross-request identity is inferred from IP, ASN,
User-Agent, client name or timing.

### Experimental funnel and limits

Count `tools/list`, valid shared-search calls, match/no-match results, contribution
calls, and accepted signal IDs separately. `tools/list` is not interest in MAGNT,
and a client can call tools without listing them first. A valid search is one
whose goal passed validation, including a later storage error; report storage
errors separately from successful searches. Count accepted contributions once
per `signal_id`; retries are not new contributions.

The primary KPI is external valid `search_shared_experience` calls. The second is
new contributions linked to a no-match. Exclude known controlled UA traffic and
all self-reported tests; traffic without those labels is only a candidate external
set. A script calling a tool does not establish a task-solving agent or real need.

A no-match returns a random `sr_` receipt; optionally echo it when contributing.
The receipt is logged in both events, contains no task text, is never stored in
D1 and is not an Observer `event_id`. It is not signed, identity or authorization.
For attribution, join only to an observed no-match in the same export, with the
contribution occurring within 24 hours after it. Unmatched or stale receipts do
not qualify for that KPI. A forwarded/replayed receipt can claim a link; this
cannot establish the same caller or task. Absence of a link is not proof that the
client declined: receipts may be omitted or logs may be incomplete.

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
Shared tests additionally cover read-only search, schema absence, explicit writes,
matching, cohort separation, hidden records, field limits, all advertised legacy
versions, no technical metadata in results, and content-free event correlation.

HTTP POST bodies are limited to 24 KiB. The handler validates public hostnames
and browser origins. No OAuth or language model is required for these public
information and append-only contact capabilities.

## References

- [Cloudflare MCP handler](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [MCP versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [Experimental Server Card schema](https://github.com/modelcontextprotocol/ext-server-card/blob/main/schema.ts)
- [Cloudflare D1](https://developers.cloudflare.com/d1/get-started/)
