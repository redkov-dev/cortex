# MAGNT C.1 — messages and read receipts

Implementation of the approved dialogue specification v0.2 (6 November 2026).
Activation is separate from deployment; all three dialogue flags default off.
See [manual rollout](mcp-dialogue-c1-rollout.md). This release supersedes the
draft-only and read-without-receipts rules of Owner B.1 when dialogue reading is enabled.

## Public contract

`propose_contact` retains its input schema. When create/read/write are enabled,
one D1 batch saves the original contact, private workspace, dialogue, initial
message reference, secret access hash and one non-test notification. It returns
the secret `dialogue_token` once, the stable contact/dialogue/message IDs and
instructions to return in approximately one hour. This is a polling recommendation,
not a guaranteed human response time. Clients must save their token and schedule
their own return. A closed chat is not promised an automatic wake-up.

| Tool | Inputs | Successful result |
| --- | --- | --- |
| `get_dialogue` | `dialogue_token`; optional `cursor`, `sent_message_id` | One next owner `message` or `null`, `sent_message` read status, `has_more`, `next_cursor`, `next_actor`, polling advice |
| `send_dialogue_message` | `dialogue_token`, `body` (1–4000), UUID `submission_id`; optional `in_reply_to_message_id` | One new visitor message ID and historical write receipt |

There is no public history array, limit argument or return of visitor texts.
Without a cursor, the first published owner reply is selected. With a cursor,
the next owner reply after its sequence is selected. Old cursors repeat the same
message even after it is marked read; save the new cursor only after receiving
the result and deduplicate by `message_id`. An empty poll preserves the cursor.
Private drafts, token changes and later messages cannot silently skip a reply.
Rotation requires starting without an old cursor; stable message IDs permit deduplication.

`sent_message_id` selects one visitor message in this dialogue, defaulting to
the latest. Its read status is returned even when `message=null`. A foreign,
unknown or wrong-direction ID produces `message_unavailable` after authorization.
Polling returns `message_available`, `waiting_for_reply` or `no_new_reply`.

Advice is one hour initially; after a day waiting it becomes six hours; after
seven days, one day. More available replies permit an immediate next poll.
When the next move belongs to the visitor and all replies have been returned,
`next_poll_at` is null. Configured limits are 30 reads / 10 writes per minute per
active access and 120 dialogue/contact calls per minute per public source IP.
These bindings reside in the private core behind the public gateway.
Cloudflare counters are approximate and local to each location; they are abuse
controls, not a strict worldwide quota ([provider documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)).

## Read and queue semantics

| Action | Read receipt | Content revision / attention |
| --- | --- | --- |
| Owner `read_conversation` | Only full incoming messages in the returned page | Unchanged |
| Public `get_dialogue` | Only the single returned owner reply | Unchanged |
| Inbox preview, Telegram, direct SQL, empty public poll | No additional read receipt | Unchanged |
| Draft | None | Revision changes; incoming still needs attention |
| Publish | Incoming remains technically unread if never opened in Owner | CAS revision; processed through the confirmed revision; next actor visitor |
| New visitor message | Initially unread | Revision and inbox epoch change; next actor Alexander; unarchive; one outbox job |
| Acknowledge / archive | None | Owner queue only |

“Read” means the full message was included in a successful MCP result. It does
not prove human attention. A network disconnect after persistence can leave a
receipt without the client receiving the result; repeating the same cursor
returns the same text. The first persisted timestamp is stable. Publication
does not require opening the incoming message: the owner can obtain revision
and message ID from `list_inbox` when sufficient context is already known.

`list_inbox` exposes unread incoming count, latest incoming ID, last reply ID
and its read status/time without marking anything. `read_conversation` exposes
each message's status. UTC is stored; owner tool instructions request display
in explicitly labelled Moscow time. Read scope permits automatic read receipts
even when `OWNER_MCP_WRITE_ENABLED=false`; explicit mutations still require write scope.

## Owner publication and access

`write_reply(mode=publish)` requires an explicit owner instruction, current
revision, UUID submission ID and an active dialogue. It atomically creates one
immutable public event, changes next actor and acknowledges through that revision.
If `reply_id` is supplied, only that draft becomes a reference to the canonical
published event; other drafts stay private. Editing published content means
publishing a new message. Optional `in_reply_to_message_id` must refer to a visitor
message in this dialogue. Without it, no relationship is fabricated.

`manage_dialogue_access` adds three explicit owner operations:

- `enable`: attach a dialogue to a legacy contact; no old text or draft is published.
- `rotate`: revoke previous access and issue one new token, in one transaction.
- `revoke`: disable access while retaining history and drafts.

It uses the existing owner OAuth, write permission, revision and UUID checks.
The owner verifies the recipient and transfers the secret manually. No token
or message is sent by access management. Names, email, contact IDs and
`previous_contact_id` are never authorization or automatic conversation merging.

Tokens contain 32 random bytes, encoded as `mdt_` plus 43 base64url characters.
Only a SHA-256 hash is persisted; a separate random key signs access-bound
cursors. At most one access is active per dialogue, without automatic expiry.
Raw tokens never enter operation receipts, logs, notification outbox or Telegram.
Creation and enable/rotate retries return IDs but never the secret again.
Losing the first response therefore requires owner reissue after recipient
verification; a submission UUID cannot recover access.

Public send retries are scoped to access and UUID. Authentication precedes
receipt lookup, including after revocation. Identical retries have one effect;
different contents conflict. Historical write receipts can still say unread
after a subsequent read; obtain current status through the read tools.

## Data and isolation

Migration 0007 preserves original contacts, goals, drafts, operation receipts,
notification delivery state and OAuth storage. It adds dialogue/access/event/
operation/read-receipt tables, extends workspace sequencing, permits published
draft references and adds the `dialogue_message` outbox source type.

| Module | Responsibility |
| --- | --- |
| `contacts.js` | Original source, idempotent contact insertion, latest-incoming projection |
| `dialogues.js` | Dialogue, access, public events and send receipts |
| `message-reads.js` | Per-message first-read timestamps; no message text |
| `owner-workspace.js` | Private drafts, content revision, processing/archive state and owner receipts |
| `dialogue-workflow.js`, `owner-workflow.js` | Authorized orchestration of prepared operations and atomic D1 batches |
| `notification-queue.js`, `owner-notifications.js` | Unique incoming-event jobs and existing durable dispatcher |
| MCP adapters | Bounded validation, discovery and safe serialization |

Domain SQL stays in owning modules. Gateways retain only their restricted
Service Bindings; D1, OAuth KV and secrets stay in `magnt-core`. Public and owner
capabilities remain separate. The initial event references the original contact
without copying reply addresses or client metadata. No content enters shared
task memory. Later incoming messages update one existing contact card.

Request limit is 24 KiB. Selection and publication budget both MCP result
representations below 64 KiB; text is never truncated to fit. Read receipts are
committed only for selected full messages after validation and size checks.
Mutations and dependent outbox records roll back together. Explicit error codes
contain no token, source text or raw database exception. Responses containing
messages, tokens or read statuses use `Cache-Control: no-store`.

## Validation

`npm test` uses local Miniflare D1, service bindings, OAuth and both official MCP
client generations. C.1 checks cover two-way reads, per-page marking, lost-response
cursor retries, publication without prior reading, private drafts, ordering and
CAS conflicts, idempotence, rollback via failing database triggers, migration
preservation, token isolation/rotation/revocation, flags, rate limiting, safe logs,
response bounds and one outbox job per incoming event. Production activation and
real-client smoke verification remain separate manual steps in the rollout guide.
