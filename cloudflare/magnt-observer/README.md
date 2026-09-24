# MAGNT Observer + MCP Door v0.1

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

## Deployment on the existing infrastructure

Node.js 22 or later is required for local development. Run from this directory:

```sh
npm ci
npm test
npm run deploy
```

The existing Cloudflare Builds deployment command `npx wrangler deploy` also works.
The lockfile pins the SDK and Wrangler dependencies. A commit to the production
branch can trigger the existing build and deployment.

`wrangler.jsonc` declares the D1 binding `CONTACTS` with database name
`magnt-contacts`. Wrangler 4.139.0 automatically finds or creates that database
and binds it during deployment; a `database_id` is intentionally not guessed.
This requires the deploying Cloudflare identity to have the necessary D1 access.
Wrangler will reuse the named database on subsequent deployments.

The first contact initializes the table using the idempotent schema in
`migrations/0001_contacts.sql`. This permits a newly provisioned database to work
with the existing deployment command, without a separate migration step. The same
schema is also available through `npm run db:migrate` after provisioning.

If the build cannot create or bind D1, create `magnt-contacts` in the Cloudflare
account that owns `magnt-observer`, copy its database ID into the `CONTACTS` entry
in `wrangler.jsonc`, and redeploy using an identity allowed to use that database.
Never put API tokens or other credentials in this repository.

Before considering deployment complete:

1. Check `/__magnt_probe` reports `mcp_door_version: 0.1.0` and
   `contact_storage_configured: true`.
2. Run the controlled test below. Its receipt confirms storage worked; the probe
   alone only checks that a binding exists.
3. Find the test receipt in D1 and confirm Alexander can view the inbox.

```sh
npm run smoke -- https://magnt.ru/mcp --submit-test
```

Without `--submit-test`, the smoke command only reads capabilities and profile.
With it, one clearly marked test message is saved and an identical retry checks
idempotency. The client identifies itself as `magnt-owner-smoke` and uses
`MAGNT-Controlled-Test/0.1` as its User-Agent.

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

Arbitrary method/tool/resource names are recorded as `unknown`. Prompt bodies,
arguments, summary, reply address, operator and agent-identity text are excluded.
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

## Local verification

```sh
npm run dev -- --config wrangler.local.jsonc
npm run smoke -- http://localhost:8787/mcp --submit-test
```

The local configuration has a separate database name. `npm test` runs a real
Workers runtime and local D1 through Miniflare, using official MCP clients from
both protocol generations. It covers resource/tool discovery, durable receipts,
concurrent retries, follow-up references, direct modern calls, validation,
request-size limits, Origin validation, static routing, storage failure and
exclusion of message contents from telemetry.

HTTP POST bodies are limited to 24 KiB. The handler validates public hostnames
and browser origins. No OAuth or language model is required for these public
information and append-only contact capabilities.

## References

- [Cloudflare MCP handler](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [MCP versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [Experimental Server Card schema](https://github.com/modelcontextprotocol/ext-server-card/blob/main/schema.ts)
- [Cloudflare D1](https://developers.cloudflare.com/d1/get-started/)
