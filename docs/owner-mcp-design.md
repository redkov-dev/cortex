# MAGNT Owner B.1 — architecture and release decisions

## Scope

Three deployment units, one modular domain core and the existing D1 database.
The public four tools are unchanged. `https://owner.magnt.ru/mcp` adds `list_inbox`,
`read_conversation`, `write_reply`, `update_inbox`. Sources are existing private
contacts and observed search goals. B does not publish, send replies, identify
visitors or implement project/dialogue tokens. A goal draft is an owner's private
note, without an established recipient or reply channel.

## Ownership and dependencies

| Module | Responsibility / owned tables |
| --- | --- |
| `owner-mcp.js` | HTTP/MCP adapter, bounded requests, tool declarations, safe errors |
| `owner-auth.js` | Fixed owner, resource, authorization epoch and write policy |
| `owner-login.js`, `owner-oauth.js` | GitHub identity adapter and official OAuth library integration; private core only |
| `core.js` | Closed default entrypoint; distinct public/owner Service Binding entrypoints and Cron |
| `owner-gateway.js`, `owner-http.js` | Canonical owner origin, bounded requests, rate limits and safe headers |
| `public-gateway.js`, `public-core-client.js` | Public HTTP adapter and restricted core binding; no storage or owner adapter |
| `owner-workflow.js` | Compose source, workspace and notification operations; no SQL or network I/O |
| `owner-workspace.js` | SQL for owner_inbox, owner_replies, owner_operations, owner_workspace_state |
| `contacts.js`, `observations.js` | Read/write their own original sources, bounded source lists and append-only source versions |
| `owner-notifications.js` | Existing outbox dispatch and read-only delivery diagnostics |
| `telegram-notifications.js` | Telegram formatting and network calls |
| `mcp-transport.js` | Shared 24 KiB body reader and MCP result representation |

Dependencies flow from adapters through workflows to domain operations, without
cycles. Source text is never duplicated in owner_inbox. Untouched source cards
are virtual revision 1; reads neither create rows nor mark items acknowledged.
Existing source records are immediately readable without notification backfill.
No speculative project tables are added in B.

## Boundary and authorization

[The B.1 decision](owner-security-decision.md) replaces Access Managed OAuth.
`magnt-core` has the existing D1, OAuth KV and secrets. Its default HTTP entrypoint
always returns 404 and it has no public routes, workers.dev or preview URLs.
Named Service Bindings select `PublicApi` or `OwnerApi`; URLs cannot select them.
The public gateway has only `PublicApi`; the owner gateway has only `OwnerApi`
and rate-limit bindings. Neither gateway contains domain SQL or owner data.
The domain modules remain in one core, not independent microservices. This is
an application capability boundary, not a separate database per entrypoint.

The owner origin is `owner.magnt.ru`, separated from public site scripts and
cookies. The pinned official `@cloudflare/workers-oauth-provider` owns OAuth
mechanics: PKCE, browser-bound consent/upstream state, storage, audience checks,
refresh rotation and revocation. GitHub proves the numeric owner ID at linking;
its token is discarded and never becomes an MCP credential. No repository scope
is requested. ChatGPT callbacks/client-metadata URLs are allowlisted before
lookups. Registration defaults closed; CIMD works without DCR. Legacy DCR can
be enabled temporarily and closed again without invalidating clients.

MAGNT access tokens last one hour. Refresh works without GitHub interaction;
grants expire after 30 days without renewal. The core checks the fixed owner,
resource, read scope and current server authorization epoch on every request
and refresh. Writes additionally require the write scope and
`OWNER_MCP_WRITE_ENABLED=true`. Feature flags default off. Revocation of the
GitHub app does not revoke local MAGNT grants; epoch rotation or disabling Owner
does. KV revocation and deployments have propagation latency, not instantaneous
global consistency. Client-provided identity headers and public project/dialogue
tokens confer no owner permissions.

The old `magnt.ru/mcp-owner` and misplaced OAuth routes stay closed. The default
build temporarily keeps the old public database/notifications path, without an
owner adapter, so a merge cannot break public intake before manual provisioning.
The final public config removes database bindings and Cron; Alexander removes
old public secrets and activates core Cron after cutover. Isolation is only
claimed after that acceptance, not from deploying the transitional entrypoint.

## Data and transaction contract

Each existing contact or observation has stable `oc_<source-id>` and initial
event `in_<source-id>`. Similar text and `previous_contact_id` never merge records.
Each private draft gets a random reply ID and server-assigned sequence/author.
Editing a draft preserves that sequence and bumps the conversation revision.
Published histories will be append-only in C; there are no published B replies.

Every mutation requires UUID submission_id and expected_revision. Authorization
precedes receipt lookup; an identical retry returns the original receipt even
after later changes. Reusing a submission ID with changed normalized arguments
or operation returns submission_conflict. Receipt keys include the owner actor.

One D1 batch performs conditional revision update, operation receipt, draft or
queue-state mutation and inbox snapshot epoch. A generated operation ID guards
subsequent writes. Concurrent exact retries return one receipt and one draft;
competing edits on the same revision yield one success. Database failures roll
back the whole batch. Failed publish has no fallback write or outbound call.
Acknowledgement is explicit and validates the exact incoming event.

## Bounded reads and privacy

History cursors bind to conversation/revision/sequence. B rejects changed
revisions with invalid_cursor; callers restart without the cursor. Empty results
do not advance sequence. Page size defaults 20, max 50; the output budget covers
both MCP representations and reserves framing space under 64 KiB.

Inbox uses keyset pagination over source timestamp/ID, scans at most 50
candidates per call and may return an empty page with has_more. It checks owner
epoch plus append-only source watermark/count before and after reading. New
incoming records or owner changes invalidate the snapshot. Direct SQL editing
or deletion of original source records is outside this pilot's pagination
contract. A maintenance feature would need explicit source revision tracking.

Private requests log only fixed path, request event/time, method, allowlisted
tool, outcome, safe error, status and duration. No source ID, identity, body,
query, referrer, user agent or credential is logged. Private routes bypass
Analytics Engine and static proxying; responses are no-store. Existing automatic
traces remain disabled. External Logpush configurations need separate inspection. Incoming content is labelled untrusted and grants no authority to
the assistant; server authorization does not attempt to solve prompt injection
by recognizing text.

## Future C: projects and dialogue branches

Projects contain several independent dialogue branches with separate histories,
revisions, inbox state and meetings. `project_token` accesses all published
branches and creates new ones; `dialogue_token` accesses only one branch.
Visitor identity/accounts are optional, not an authorization prerequisite.
IDs address resources; tokens authorize them. No visitor token reads owner drafts.

The updated project TZ proposes `start_dialogue` alongside the four planned
project tools: public total nine tools including the existing four. Owner tools
grow from four to six with state/meeting and access management. These contracts
are planned, not advertised as live tools or added as empty modules in B.

## Verification and activation

`npm test` bundles locally with esbuild and runs real MCP SDKs against Miniflare
D1/KV, Service Bindings and mocked GitHub/ChatGPT metadata endpoints. It does not invoke Wrangler or Cloudflare APIs.
Production bundling remains the existing Wrangler deploy workflow. Tests cover
real consent/code/refresh exchanges, callback state/cookies, PKCE, expiry, resource,
owner, epoch, read/write scopes, closed registration, request limits, gateway
module boundaries, disabled modes, unchanged public tools, source privacy, drafts,
conflicts, retries, rollback, pagination and safe logs. The actual ChatGPT account,
Cloudflare deployment boundaries and Free CPU budget require manual acceptance in
[the activation guide](owner-mcp-rollout.md).

Migration 0006 is additive and already applied by Alexander. B.1 adds no SQL
migration. Roll back by disabling Owner; retain the database and grants. Do not
restore a public database binding without following the documented full rollback.
