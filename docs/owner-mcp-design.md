# MAGNT Owner B — architecture and release decisions

## Scope

One Worker, one existing D1 binding, two independently authorized MCP adapters.
The public four tools are unchanged. `/mcp-owner` adds `list_inbox`,
`read_conversation`, `write_reply`, `update_inbox`. Sources are existing private
contacts and observed search goals. B does not publish, send replies, identify
visitors or implement project/dialogue tokens. A goal draft is an owner's private
note, without an established recipient or reply channel.

## Ownership and dependencies

| Module | Responsibility / owned tables |
| --- | --- |
| `owner-mcp.js` | HTTP/MCP adapter, bounded requests, tool declarations, safe errors |
| `owner-auth.js` | Validated Access identity and server-controlled write capability |
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

## Authorization decision

Use **Cloudflare Access Managed OAuth**, rather than implement password storage,
an authorization server or session/refresh-token storage in MAGNT. The edge owns
OAuth discovery, registration, consent and validation of its opaque OAuth token.
It forwards an application JWT. The Worker verifies RS256 against a fixed
configured team's JWKS, exact issuer and application AUD, required claims,
expiry, application type and the pinned owner subject on every request.
Self-reported email, tool arguments, source IDs and public bearer capabilities
grant no owner rights. Noncanonical hosts are rejected.

This explicitly revises the original TZ requirement for custom
`magnt.owner.read/write` scopes: Access's forwarded assertion is **not** claimed
to carry those scopes. Reading requires the allowed application and owner;
writing also requires `OWNER_MCP_WRITE_ENABLED=true`. This is a single-owner
policy, not per-user scope delegation. Both feature flags default off. Actual
ChatGPT OAuth compatibility remains a production acceptance gate.

The bootstrap GET `/mcp-owner/identity` validates issuer/AUD/signature and returns
only that caller's subject, with no database access. It works before pinning the
subject and enabling tools, behind the same owner-only Access policy.

Access token refresh re-evaluates Access policy; previously issued credentials
may remain valid until expiry. Short token/session lifetimes and the independent
server disable/write flags bound exposure. Deployment propagation and actual
revocation are tested during activation, not asserted from unit tests.

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
traces remain disabled. External Access/Logpush configurations need separate
inspection. Incoming content is labelled untrusted and grants no authority to
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
D1 and a mocked JWKS endpoint. It does not invoke Wrangler or Cloudflare APIs.
Production bundling remains the existing Wrangler deploy workflow. Tests cover
signatures/issuer/AUD/expiry/subject, disabled and read-only modes, unchanged public
tools, source privacy, drafts, conflicts, retries, atomic rollback, pagination
budgets, safe logs and Telegram next-step formatting. Cloudflare edge OAuth and
the actual ChatGPT account still require the manual acceptance in
[the activation guide](owner-mcp-rollout.md).

Migration 0006 is additive. Roll back by disabling owner flags and reverting code;
retain data. Notification settings and the public MCP remain independent.
