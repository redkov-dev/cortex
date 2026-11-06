import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fixture } from './support/owner-fixture.mjs';
import { processOwnerNotifications } from '../src/owner-notifications.js';
import { notificationText } from '../src/telegram-notifications.js';
import { pollAdvice } from '../src/dialogue-common.js';
import { createContactDialogue } from '../src/dialogue-workflow.js';
import { runOwnerOperation } from '../src/owner-workflow.js';

const enabled = { DIALOGUE_CREATE_ENABLED: 'true', DIALOGUE_READ_ENABLED: 'true', DIALOGUE_WRITE_ENABLED: 'true' };
const pub = { public: true, token: null };
const setup = (t, options = {}) => fixture(t, { through: 7, ...options, overrides: { ...enabled, ...options.overrides } });
const create = async (f, extra = {}) => {
  const result = await f.call('propose_contact', { summary: 'PRIVATE_INITIAL_SENTINEL', submission_id: crypto.randomUUID(), ...extra }, pub);
  assert.equal(result.value.status, 'accepted_for_human_review', JSON.stringify(result.value));
  return { ...result.value, conversation_id: 'oc_' + result.value.contact_id };
};
const inbox = async (f, c) => (await f.call('list_inbox', { view: 'all', include_tests: true })).value.items.find(i => i.conversation_id === c.conversation_id);
const get = async (f, c, extra = {}) => (await f.call('get_dialogue', { dialogue_token: c.dialogue_token, ...extra }, pub)).value;
const send = (f, c, extra = {}) => f.call('send_dialogue_message', { dialogue_token: c.dialogue_token,
  body: 'PRIVATE_FOLLOWUP_SENTINEL', submission_id: crypto.randomUUID(), ...extra }, pub);
const write = async (f, c, body = 'OWNER_REPLY_SENTINEL', extra = {}) => f.call('write_reply', {
  conversation_id: c.conversation_id, expected_revision: (await inbox(f, c)).revision,
  mode: 'publish', body, submission_id: crypto.randomUUID(), ...extra });
const manage = async (f, c, action, extra = {}) => f.call('manage_dialogue_access', { conversation_id: c.conversation_id,
  expected_revision: (await inbox(f, c)).revision, action, submission_id: crypto.randomUUID(), ...extra });
const count = async (f, table) => (await f.db.prepare('SELECT COUNT(*) AS n FROM ' + table).first()).n;
const epoch = async f => (await f.db.prepare('SELECT revision FROM owner_workspace_state').first()).revision;

test('C.1 discovery, one-message round trip, read receipts and publication without opening incoming', { timeout: 60000 }, async t => {
  const f = await setup(t), c = await create(f);
  assert.match(c.dialogue_token, /^mdt_[A-Za-z0-9_-]{43}$/);
  assert.equal(c.read_status, 'unread'); assert.equal(c.retry_after_seconds, 3600);
  const publicTools = (await (await f.raw('tools/list', {}, pub)).json()).result.tools;
  assert.equal(publicTools.length, 6);
  const getter = publicTools.find(x => x.name === 'get_dialogue');
  assert.equal(getter.annotations.readOnlyHint, false); assert.equal(getter.annotations.destructiveHint, false);
  assert.equal(getter.inputSchema.properties.limit, undefined);
  const ownerTools = (await (await f.raw('tools/list')).json()).result.tools;
  assert.equal(ownerTools.length, 5);
  const reader = ownerTools.find(x => x.name === 'read_conversation');
  assert.equal(reader.annotations.readOnlyHint, false);
  assert.deepEqual(reader._meta.securitySchemes[0].scopes, ['magnt.owner.read']);
  const item = await inbox(f, c);
  assert.equal(item.unread_incoming_count, 1); assert.equal(item.last_reply_read_status, null); assert.equal(item.can_publish, true);
  assert.equal(await count(f, 'message_read_receipts'), 0);
  const waiting = await get(f, c);
  assert.equal(waiting.message, null); assert.equal(waiting.status, 'waiting_for_reply'); assert.equal(waiting.sent_message.read_status, 'unread');
  const published = (await write(f, c)).value;
  assert.equal(published.status, 'published'); assert.equal(published.delivery_status, 'available_to_visitor');
  assert.equal(await count(f, 'message_read_receipts'), 0);
  const afterPublish = await inbox(f, c), contentEpoch = await epoch(f);
  assert.equal(afterPublish.needs_attention, false); assert.equal(afterPublish.has_unread_incoming, true);
  assert.equal(afterPublish.last_reply_read_status, 'unread');
  const first = await get(f, c);
  assert.equal(first.status, 'message_available'); assert.equal(first.message.body, 'OWNER_REPLY_SENTINEL');
  assert.equal(first.message.read_status, 'read'); assert.equal(first.sent_message.read_status, 'unread');
  assert.equal(first.messages, undefined); assert.equal(first.has_more, false); assert.equal(first.next_poll_at, null);
  const again = await get(f, c);
  assert.deepEqual(again.message, first.message); assert.equal(again.next_cursor, first.next_cursor);
  const empty = await get(f, c, { cursor: first.next_cursor });
  assert.equal(empty.message, null); assert.equal(empty.status, 'no_new_reply'); assert.equal(empty.next_cursor, first.next_cursor);
  assert.equal((await inbox(f, c)).last_reply_read_at, first.message.read_at);
  assert.equal(await epoch(f), contentEpoch);
  const owner = (await f.call('read_conversation', { reference: c.contact_id })).value;
  assert.equal(owner.events[0].read_status, 'read'); assert.equal(owner.events[1].read_status, 'read');
  assert.equal(owner.revision, afterPublish.revision); assert.equal(owner.unread_incoming_count, 0);
  assert.equal((await get(f, c)).sent_message.read_at, owner.events[0].read_at);
  assert.equal(await epoch(f), contentEpoch);
  assert.equal(await count(f, 'owner_notification_outbox'), 1);
});

test('Owner pages mark only full incoming messages; empty polling still returns chosen message read status', { timeout: 60000 }, async t => {
  const f = await setup(t), c = await create(f);
  const second = (await send(f, c)).value;
  assert.equal((await inbox(f, c)).unread_incoming_count, 2);
  const before = await epoch(f);
  const page = (await f.call('read_conversation', { reference: c.contact_id, limit: 1 })).value;
  assert.equal(page.events.length, 1); assert.equal(page.has_more, true); assert.equal(page.unread_incoming_count, 1);
  const defaultStatus = await get(f, c);
  assert.equal(defaultStatus.message, null); assert.equal(defaultStatus.sent_message.message_id, second.message_id);
  assert.equal(defaultStatus.sent_message.read_status, 'unread');
  assert.equal((await get(f, c, { sent_message_id: c.message_id })).sent_message.read_status, 'read');
  const next = (await f.call('read_conversation', { reference: c.contact_id, limit: 1, cursor: page.next_cursor })).value;
  assert.equal(next.events[0].event_id, second.message_id); assert.equal(next.unread_incoming_count, 0);
  assert.equal(next.revision, page.revision); assert.equal(await epoch(f), before);
  assert.equal((await inbox(f, c)).needs_attention, true);
  assert.equal((await get(f, c)).sent_message.read_status, 'read');
  const originalTime = page.events[0].read_at;
  assert.equal((await f.call('read_conversation', { reference: c.contact_id, limit: 1 })).value.events[0].read_at, originalTime);
});

test('Unread replies are independently tracked and old cursors survive new messages and private draft edits', { timeout: 60000 }, async t => {
  const f = await setup(t), c = await create(f);
  const a = (await write(f, c, 'first')).value, b = (await write(f, c, 'second')).value;
  const first = await get(f, c);
  assert.equal(first.message.message_id, a.message_id); assert.equal(first.has_more, true); assert.equal(first.retry_after_seconds, 0);
  assert.equal((await inbox(f, c)).last_reply_read_status, 'unread');
  await send(f, c);
  await write(f, c, 'PRIVATE_DRAFT_SENTINEL', { mode: 'draft' });
  const second = await get(f, c, { cursor: first.next_cursor });
  assert.equal(second.message.message_id, b.message_id); assert.equal(second.message.body, 'second');
  assert.equal((await get(f, c, { cursor: second.next_cursor })).message, null);
  assert.equal((await get(f, c, { cursor: first.next_cursor })).message.read_at, second.message.read_at);
  assert.ok(!JSON.stringify(second).includes('PRIVATE_DRAFT_SENTINEL'));
});

test('Atomic creation and send retries, conflicting submissions, concurrent continuation ordering', { timeout: 60000 }, async t => {
  const f = await setup(t), submission = crypto.randomUUID();
  const input = { summary: 'private creation', submission_id: submission };
  const results = await Promise.all([f.call('propose_contact', input, pub), f.call('propose_contact', input, pub)]);
  assert.equal(results.filter(r => r.value.dialogue_token).length, 1);
  assert.equal(results[0].value.contact_id, results[1].value.contact_id);
  assert.equal(results[0].value.dialogue_id, results[1].value.dialogue_id);
  assert.equal(await count(f, 'contacts'), 1); assert.equal(await count(f, 'dialogue_access'), 1);
  assert.equal(await count(f, 'owner_notification_outbox'), 1);
  assert.equal((await f.call('propose_contact', { ...input, summary: 'different' }, pub)).value.code, 'submission_conflict');
  const c = results.find(r => r.value.dialogue_token).value;
  const sendInput = { dialogue_token: c.dialogue_token, body: 'one followup', submission_id: crypto.randomUUID() };
  const sends = await Promise.all([f.call('send_dialogue_message', sendInput, pub), f.call('send_dialogue_message', sendInput, pub)]);
  assert.deepEqual(sends[0].value, sends[1].value);
  assert.equal(await count(f, 'dialogue_events'), 2); assert.equal(await count(f, 'owner_notification_outbox'), 2);
  assert.equal((await f.call('send_dialogue_message', { ...sendInput, body: 'different' }, pub)).value.code, 'submission_conflict');
  const concurrent = await Promise.all(['one', 'two', 'three'].map(body => send(f, c, { body })));
  assert.ok(concurrent.every(r => r.value.status === 'accepted_for_human_review'), JSON.stringify(concurrent.map(r => r.value)));
  const events = (await f.db.prepare('SELECT sequence FROM dialogue_events ORDER BY sequence').all()).results;
  assert.deepEqual(events.map(e => e.sequence), [1,2,3,4,5]);
  assert.equal(await count(f, 'owner_notification_outbox'), 5);
  const serialized = JSON.stringify((await f.db.prepare('SELECT * FROM dialogue_access').all()).results);
  assert.ok(!serialized.includes(c.dialogue_token));
});

test('Source, access, event, workspace and queue roll back together on storage failure', { timeout: 60000 }, async t => {
  const f = await setup(t);
  await f.db.prepare("CREATE TRIGGER reject_queue BEFORE INSERT ON owner_notification_outbox BEGIN SELECT RAISE(ABORT, 'PRIVATE_DB_SENTINEL'); END").run();
  const input = { summary: 'atomic', submission_id: crypto.randomUUID() };
  assert.equal((await f.call('propose_contact', input, pub)).value.code, 'storage_unavailable');
  for (const table of ['contacts', 'dialogues', 'dialogue_access', 'dialogue_events', 'owner_inbox']) assert.equal(await count(f, table), 0, table);
  await f.db.prepare('DROP TRIGGER reject_queue').run();
  const c = await create(f, input);
  const before = await inbox(f, c);
  await f.db.prepare("CREATE TRIGGER reject_queue BEFORE INSERT ON owner_notification_outbox BEGIN SELECT RAISE(ABORT, 'PRIVATE_DB_SENTINEL'); END").run();
  assert.equal((await send(f, c)).value.code, 'storage_unavailable');
  assert.equal(await count(f, 'dialogue_events'), 1); assert.equal(await count(f, 'dialogue_operations'), 0);
  assert.deepEqual(await inbox(f, c), before);
  await f.db.prepare('DROP TRIGGER reject_queue').run();
  await f.db.prepare("CREATE TRIGGER reject_event BEFORE INSERT ON dialogue_events BEGIN SELECT RAISE(ABORT, 'PRIVATE_DB_SENTINEL'); END").run();
  assert.equal((await write(f, c)).value.code, 'storage_unavailable');
  assert.equal((await inbox(f, c)).revision, before.revision); assert.equal(await count(f, 'owner_operations'), 0);
  await f.db.prepare('DROP TRIGGER reject_event').run();
  await f.db.prepare("CREATE TRIGGER reject_read BEFORE INSERT ON message_read_receipts BEGIN SELECT RAISE(ABORT, 'PRIVATE_DB_SENTINEL'); END").run();
  assert.equal((await f.call('read_conversation', { reference: c.contact_id })).value.code, 'storage_unavailable');
  assert.equal(await count(f, 'message_read_receipts'), 0);
});

test('Draft publication preserves other drafts, CAS and idempotence without read prerequisites', { timeout: 60000 }, async t => {
  const f = await setup(t), c = await create(f);
  const draft = (await write(f, c, 'selected', { mode: 'draft' })).value;
  await write(f, c, 'PRIVATE_OTHER_DRAFT_SENTINEL', { mode: 'draft' });
  const input = { conversation_id: c.conversation_id, expected_revision: (await inbox(f, c)).revision, mode: 'publish',
    body: 'selected', reply_id: draft.reply_id, in_reply_to_message_id: c.message_id, submission_id: crypto.randomUUID() };
  const replies = await Promise.all([f.call('write_reply', input), f.call('write_reply', input)]);
  assert.deepEqual(replies[0].value, replies[1].value); assert.equal(replies[0].value.status, 'published');
  assert.equal(await count(f, 'message_read_receipts'), 0);
  const selected = await f.db.prepare('SELECT * FROM owner_replies WHERE reply_id = ?').bind(draft.reply_id).first();
  assert.equal(selected.body, null); assert.equal(selected.published_event_id, replies[0].value.message_id);
  const polled = await get(f, c);
  assert.equal(polled.message.body, 'selected'); assert.equal(polled.message.in_reply_to_message_id, c.message_id);
  const staleRevision = (await inbox(f, c)).revision;
  await send(f, c);
  assert.equal((await write(f, c, 'stale', { expected_revision: staleRevision })).value.code, 'revision_conflict');
  const rev = (await inbox(f, c)).revision;
  const competing = await Promise.all(['a','b'].map(body => write(f, c, body, { expected_revision: rev })));
  assert.equal(competing.filter(r => r.value.status === 'published').length, 1);
  assert.equal(competing.filter(r => r.value.code === 'revision_conflict').length, 1);
  assert.equal((await f.call('write_reply', input)).value.message_id, replies[0].value.message_id);
  assert.equal((await write(f, c, 'edited', { mode: 'draft', reply_id: draft.reply_id })).value.code, 'revision_conflict');
  assert.equal((await inbox(f, c)).has_unread_incoming, true);
});

test('Access is isolated by token and direction; rotation/revocation reject old tokens and retries', { timeout: 60000 }, async t => {
  const f = await setup(t), a = await create(f), b = await create(f);
  const reply = (await write(f, a)).value, poll = await get(f, a);
  assert.equal((await get(f, b, { sent_message_id: a.message_id })).code, 'message_unavailable');
  assert.equal((await get(f, a, { sent_message_id: reply.message_id })).code, 'message_unavailable');
  assert.equal((await get(f, b, { cursor: poll.next_cursor })).code, 'invalid_cursor');
  assert.equal((await get(f, a, { cursor: poll.next_cursor + 'x' })).code, 'invalid_cursor');
  assert.equal((await send(f, b, { in_reply_to_message_id: reply.message_id })).value.code, 'message_unavailable');
  assert.equal((await write(f, b, 'foreign', { in_reply_to_message_id: a.message_id })).value.code, 'message_unavailable');
  const oldSend = { dialogue_token: a.dialogue_token, body: 'retry', submission_id: crypto.randomUUID() };
  assert.equal((await f.call('send_dialogue_message', oldSend, pub)).value.status, 'accepted_for_human_review');
  const rotation = { conversation_id: a.conversation_id, expected_revision: (await inbox(f, a)).revision,
    action: 'rotate', submission_id: crypto.randomUUID() };
  const rotated = await Promise.all([f.call('manage_dialogue_access', rotation), f.call('manage_dialogue_access', rotation)]);
  assert.equal(rotated.filter(r => r.value.dialogue_token).length, 1);
  const token = rotated.find(r => r.value.dialogue_token).value.dialogue_token;
  assert.equal((await f.call('manage_dialogue_access', rotation)).value.token_issued, false);
  assert.equal((await get(f, a)).code, 'dialogue_unavailable');
  assert.equal((await f.call('send_dialogue_message', oldSend, pub)).value.code, 'dialogue_unavailable');
  const renewed = { ...a, dialogue_token: token };
  assert.equal((await get(f, renewed, { cursor: poll.next_cursor })).code, 'invalid_cursor');
  assert.equal((await get(f, renewed)).message.message_id, reply.message_id);
  await manage(f, renewed, 'revoke');
  assert.equal((await get(f, renewed)).code, 'dialogue_unavailable');
  assert.equal((await write(f, renewed)).value.code, 'reply_channel_unavailable');
  const badToken = { ...a, dialogue_token: 'mdt_' + 'a'.repeat(43) };
  assert.equal((await get(f, badToken, { cursor: 'broken' })).code, 'dialogue_unavailable');
  assert.equal((await f.raw('tools/list', {}, { token: token })).status, 401);
  assert.ok(!JSON.stringify((await f.db.prepare('SELECT * FROM owner_operations').all()).results).includes(token));
});

test('Legacy enable publishes no old content; test traffic inherits isolation and has no notifications', { timeout: 60000 }, async t => {
  const f = await setup(t, { overrides: { DIALOGUE_CREATE_ENABLED: 'false' } });
  const submission = crypto.randomUUID(), old = await create(f, { submission_id: submission });
  assert.equal(old.dialogue_token, undefined); assert.equal(await count(f, 'dialogues'), 0);
  await write(f, old, 'PRIVATE_LEGACY_DRAFT_SENTINEL', { mode: 'draft' });
  const enabledAccess = (await manage(f, old, 'enable')).value;
  assert.equal(enabledAccess.token_issued, true);
  const c = { ...old, dialogue_token: enabledAccess.dialogue_token };
  const empty = await get(f, c);
  assert.equal(empty.message, null); assert.ok(!JSON.stringify(empty).includes('PRIVATE'));
  assert.equal((await write(f, c)).value.status, 'published');
  assert.equal((await get(f, c)).message.body, 'OWNER_REPLY_SENTINEL');
  const testFixture = await setup(t), testContact = await create(testFixture, { is_test: true });
  await send(testFixture, testContact);
  assert.equal(await count(testFixture, 'owner_notification_outbox'), 0);
  assert.equal((await testFixture.call('list_inbox')).value.items.length, 0);
  assert.equal((await inbox(testFixture, testContact)).unread_incoming_count, 2);
  assert.equal((await send(testFixture, testContact, { is_test: false })).value.code, 'invalid_arguments');
});

test('Archive and acknowledge do not mark read; new messages restore and reorder one existing inbox item', { timeout: 60000 }, async t => {
  const f = await setup(t), a = await create(f), b = await create(f);
  let item = await inbox(f, a);
  const update = async (action, extra = {}) => f.call('update_inbox', { conversation_id: a.conversation_id,
    expected_revision: (await inbox(f, a)).revision, submission_id: crypto.randomUUID(), action, ...extra });
  await update('acknowledge', { through_event_id: a.message_id });
  assert.equal((await inbox(f, a)).needs_attention, false); assert.equal((await get(f, a)).sent_message.read_status, 'unread');
  await update('archive');
  const newMessage = (await send(f, a, { body: 'latest summary' })).value;
  item = await inbox(f, a);
  assert.equal(item.archived, false); assert.equal(item.needs_attention, true); assert.equal(item.summary, 'latest summary');
  assert.equal(item.latest_incoming_message_id, newMessage.message_id);
  const list = (await f.call('list_inbox', { view: 'all' })).value.items;
  assert.equal(list.length, 2); assert.equal(list[0].conversation_id, a.conversation_id);
  await update('acknowledge', { through_event_id: a.message_id });
  assert.equal((await inbox(f, a)).needs_attention, true);
  await update('acknowledge', { through_event_id: newMessage.message_id });
  assert.equal((await inbox(f, a)).needs_attention, false); assert.equal((await get(f, a)).sent_message.read_status, 'unread');
  assert.equal((await inbox(f, b)).needs_attention, true);
});

test('Read-only owner scope still records reads; disabled public writes preserve reads and emergency revoke', { timeout: 60000 }, async t => {
  const f = await setup(t, { overrides: { OWNER_MCP_WRITE_ENABLED: 'false' } }), c = await create(f);
  const readOnly = (await f.mint({ scope: ['magnt.owner.read'] })).access_token;
  assert.equal((await f.call('read_conversation', { reference: c.contact_id }, { token: readOnly })).value.events[0].read_status, 'read');
  assert.equal((await get(f, c)).sent_message.read_status, 'read');
  assert.equal((await write(f, c)).value.code, 'forbidden');
  const paused = await setup(t, { overrides: { DIALOGUE_WRITE_ENABLED: 'false' } });
  const old = await create(paused);
  assert.equal(old.dialogue_token, undefined);
  assert.equal((await manage(paused, old, 'enable')).value.code, 'reply_channel_unavailable');
  // Seed a previously active dialogue, then exercise the actual paused MCP surface.
  const prior = await createContactDialogue({ CONTACTS: paused.db, ...enabled }, { summary: 'existing before pause' }, {});
  const pc = { ...prior, conversation_id: 'oc_' + prior.contact_id };
  await runOwnerOperation({ CONTACTS: paused.db, ...enabled }, { verified: true, id: 'fixture', canWrite: true }, 'write_reply', {
    conversation_id: pc.conversation_id, expected_revision: 1, mode: 'publish', body: 'already published', submission_id: crypto.randomUUID() });
  assert.equal((await get(paused, pc)).message.body, 'already published');
  assert.equal((await send(paused, pc)).value.code, 'dialogue_disabled');
  assert.equal((await write(paused, pc)).value.code, 'reply_channel_unavailable');
  assert.equal((await manage(paused, pc, 'revoke')).value.status, 'access_revoked');
  assert.equal((await get(paused, pc)).code, 'dialogue_unavailable');
  const missingMigration = await setup(t, { through: 6 });
  assert.equal((await missingMigration.call('propose_contact', { summary: 'not partially saved' }, pub)).value.code, 'storage_unavailable');
  assert.equal(await count(missingMigration, 'contacts'), 0);
});

test('Safe errors, response bounds, no content or secrets in logs, rate limits', { timeout: 60000 }, async t => {
  const f = await setup(t), c = await create(f);
  const invalid = await f.call('get_dialogue', { dialogue_token: c.dialogue_token, [c.dialogue_token]: 'SECRET_VALUE_SENTINEL' }, pub);
  assert.equal(invalid.value.code, 'invalid_arguments'); assert.ok(!JSON.stringify(invalid.value).includes(c.dialogue_token));
  assert.equal((await send(f, c, { body: 'x'.repeat(4001) })).value.code, 'invalid_arguments');
  assert.equal((await write(f, c, '\u2000'.repeat(7999) + 'x')).value.status, 'published');
  // Escaping, multi-byte strings and both MCP copies must stay under the transport limit.
  const content = '界'.repeat(8000);
  const saved = await write(f, c, content);
  assert.equal(saved.value.status, 'published');
  const first = await get(f, c);
  const response = await f.call('get_dialogue', { dialogue_token: c.dialogue_token, cursor: first.next_cursor }, pub);
  assert.equal(response.value.message.body, content); assert.ok(response.size <= 65536, String(response.size));
  const raw = await f.raw('tools/call', { name: 'get_dialogue', arguments: { dialogue_token: c.dialogue_token } }, pub);
  assert.equal(raw.headers.get('cache-control'), 'no-store');
  const logs = JSON.stringify(f.logs);
  for (const secret of [c.dialogue_token, 'PRIVATE_INITIAL_SENTINEL', 'OWNER_REPLY_SENTINEL', 'SECRET_VALUE_SENTINEL', content]) assert.ok(!logs.includes(secret), 'log leaked ' + secret.slice(0, 20));
  const limited = await setup(t, { dialogueReadLimit: 1, dialogueWriteLimit: 1 }), lc = await create(limited);
  assert.equal((await get(limited, lc)).status, 'waiting_for_reply');
  assert.equal((await get(limited, lc)).code, 'rate_limited');
  assert.equal((await send(limited, lc)).value.status, 'accepted_for_human_review');
  const blocked = (await send(limited, lc)).value;
  assert.equal(blocked.code, 'rate_limited'); assert.equal(blocked.retry_after_seconds, 60);
  const ipLimited = await setup(t, { dialogueRequestLimit: 1 });
  const ic = await create(ipLimited);
  assert.equal((await get(ipLimited, ic)).code, 'rate_limited');
});

test('Modern and legacy independent clients can reconnect with token and receive a single reply', { timeout: 60000 }, async t => {
  const f = await setup(t);
  let c;
  for (const [ClientType, Transport] of [[Client, StreamableHTTPClientTransport], [LegacyClient, LegacyTransport]]) {
    const client = new ClientType({ name: 'c1-integration', version: '1.0.0' });
    try {
      await client.connect(new Transport(new URL('https://magnt.ru/mcp'), { fetch: f.fetchWorker }));
      if (!c) {
        c = (await client.callTool({ name: 'propose_contact', arguments: { summary: 'Reconnect', is_test: true } })).structuredContent;
        c.conversation_id = 'oc_' + c.contact_id;
        await write(f, c, 'response after reconnection');
      }
      const result = (await client.callTool({ name: 'get_dialogue', arguments: { dialogue_token: c.dialogue_token } })).structuredContent;
      assert.equal(result.message.body, 'response after reconnection'); assert.equal(result.messages, undefined);
    } finally { await client.close(); }
  }
});

test('Migration 0007 preserves existing drafts, operations, queue, goals and rolls back as one batch', { timeout: 60000 }, async t => {
  const f = await fixture(t, { through: 6 });
  const c = await create(f);
  await write(f, c, 'old private draft', { mode: 'draft' });
  await f.db.prepare("INSERT INTO owner_notification_outbox (notification_id, source_type, source_id, created_at, status, attempts, telegram_message_id, sent_at) VALUES ('test-sent','contact',?,'2026-11-01T00:00:00.000Z','sent',1,22,'2026-11-01T00:00:01.000Z')").bind(c.contact_id).run();
  const before = {};
  for (const table of ['contacts','owner_inbox','owner_replies','owner_operations','owner_notification_outbox']) before[table] = (await f.db.prepare('SELECT * FROM ' + table).all()).results;
  const sql = (await readFile('migrations/0007_dialogues.sql','utf8')).replace(/--[^\n]*/g, '').split(';').filter(s => s.trim());
  await assert.rejects(f.db.batch([...sql.slice(0,8).map(s => f.db.prepare(s)), f.db.prepare('SELECT * FROM missing_migration_table')]));
  assert.equal((await f.db.prepare('PRAGMA table_info(contacts)').all()).results.some(r => r.name === 'last_incoming_at'), false);
  await f.db.batch(sql.map(s => f.db.prepare(s)));
  for (const [table, rows] of Object.entries(before)) {
    const migrated = (await f.db.prepare('SELECT * FROM ' + table).all()).results;
    assert.equal(migrated.length, rows.length, table);
    for (let i = 0; i < rows.length; i++) for (const [key,value] of Object.entries(rows[i])) assert.equal(migrated[i][key], value, table + '.' + key);
  }
  assert.equal(await count(f, 'dialogues'), 0);
  assert.equal((await f.db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
});

test('Notifications queue once per incoming and never for reads/publication; dispatcher keeps secrets private', { timeout: 60000 }, async t => {
  const f = await setup(t), c = await create(f);
  const sent = (await send(f, c)).value;
  await write(f, c); await get(f, c); await f.call('read_conversation', { reference: c.contact_id });
  assert.equal(await count(f, 'owner_notification_outbox'), 2);
  const env = { CONTACTS: f.db, TELEGRAM_NOTIFICATIONS_ENABLED: 'true', TELEGRAM_BOT_TOKEN: '123456:' + 'a'.repeat(30),
    TELEGRAM_OWNER_CHAT_ID: '12345', NOTIFY_FROM: '2026-01-01T00:00:00.000Z', OWNER_MCP_ENABLED: 'true', DIALOGUE_READ_ENABLED: 'true' };
  let time = Date.now(); const texts = [];
  const report = await processOwnerNotifications(env, { now: () => time, sleep: async ms => { time += ms; }, log: () => {},
    fetcher: async (url, init) => { texts.push(JSON.parse(init.body).text); return Response.json({ ok: true, result: { message_id: texts.length, chat: { id: 12345, type: 'private' } } }); } });
  assert.equal(report.sent, 2); assert.equal(report.discovered, 0); assert.equal(await count(f, 'owner_notification_outbox'), 2);
  assert.ok(texts.some(text => text.includes(sent.message_id))); assert.ok(texts.some(text => text.includes('продолжение')));
  for (const text of texts) assert.ok(!text.includes(c.dialogue_token));
  const metadata = notificationText({ source_type: 'dialogue_message', notification_id: 'n' },
    { contact_id: c.contact_id, message_id: sent.message_id, summary: 'SECRET_PREVIEW_SENTINEL', created_at: c.received_at }, 'metadata_only', true, true);
  assert.ok(!metadata.includes('SECRET_PREVIEW_SENTINEL'));
});

test('Polling advice backs off without changing stored state', () => {
  const ago = days => new Date(Date.now() - days * 86400_000).toISOString();
  assert.equal(pollAdvice(ago(0), 'alexander').retry_after_seconds, 3600);
  assert.equal(pollAdvice(ago(2), 'alexander').retry_after_seconds, 21600);
  assert.equal(pollAdvice(ago(8), 'alexander').retry_after_seconds, 86400);
  assert.equal(pollAdvice(ago(8), 'visitor').next_poll_at, null);
  assert.equal(pollAdvice(ago(8), 'visitor', true).retry_after_seconds, 0);
});

test('Legacy contact retry under C.1 never creates access retroactively', { timeout: 60000 }, async t => {
  const f = await fixture(t, { through: 7 });
  const input = { summary: 'legacy receipt', submission_id: crypto.randomUUID() };
  const old = await create(f, input);
  const duplicate = await createContactDialogue({ CONTACTS: f.db, ...enabled }, input, {});
  assert.equal(duplicate.contact_id, old.contact_id); assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.dialogue_token, undefined); assert.equal(duplicate.dialogue_id, undefined);
  assert.equal(await count(f, 'dialogues'), 0); assert.equal(await count(f, 'dialogue_access'), 0);
});

test('Identical owner request committed during preflight returns its receipt without reissuing a token', { timeout: 60000 }, async t => {
  const f = await setup(t, { overrides: { DIALOGUE_CREATE_ENABLED: 'false' } }), c = await create(f);
  const actor = { verified: true, id: 'race-owner', canWrite: true };
  for (const tool of ['manage_dialogue_access', 'write_reply']) {
    const input = { conversation_id: c.conversation_id, expected_revision: (await inbox(f, c)).revision, submission_id: crypto.randomUUID(),
      ...(tool === 'manage_dialogue_access' ? { action: 'enable' } : { mode: 'publish', body: 'once' }) };
    let intercepted = false, winner;
    const db = { batch: statements => f.db.batch(statements), prepare(sql) {
      const statement = f.db.prepare(sql);
      if (!intercepted && sql.startsWith('SELECT payload_hash, result_json FROM owner_operations')) {
        intercepted = true;
        return { bind(...args) { const bound = statement.bind(...args); return { async first() {
          const row = await bound.first();
          winner = await runOwnerOperation({ CONTACTS: f.db, ...enabled }, actor, tool, input);
          return row;
        } }; } };
      }
      return statement;
    } };
    const resumed = await runOwnerOperation({ CONTACTS: db, ...enabled }, actor, tool, input);
    assert.equal(resumed.status, winner.status);
    assert.equal(resumed.dialogue_token, undefined);
    if (tool === 'manage_dialogue_access') { assert.ok(winner.dialogue_token); assert.equal(resumed.token_issued, false); }
    else assert.equal(resumed.message_id, winner.message_id);
  }
  assert.equal(await count(f, 'dialogue_access'), 1); assert.equal(await count(f, 'dialogue_events'), 2);
});

test('C.1 dependency graph is acyclic and workflows use domain operations', async () => {
  const files = (await readdir('src')).filter(name => name.endsWith('.js'));
  const graph = new Map();
  for (const name of files) {
    const source = await readFile('src/' + name, 'utf8');
    graph.set(name, [...source.matchAll(/(?:from\s*|import\s*)['"]\.\/([^'"]+\.js)['"]/g)].map(m => m[1]));
    if (['dialogue-workflow.js','owner-workflow.js','mcp.js','owner-mcp.js'].includes(name)) assert.ok(!/\.prepare\s*\(/.test(source), name);
    if (['task-signals.js','observations.js'].includes(name)) assert.ok(!/dialogues\.js|message-reads\.js/.test(source), name);
  }
  const visiting = new Set(), visited = new Set();
  function walk(name) {
    assert.ok(!visiting.has(name), 'import cycle at ' + name);
    if (visited.has(name)) return;
    visiting.add(name); for (const dependency of graph.get(name) ?? []) walk(dependency);
    visiting.delete(name); visited.add(name);
  }
  for (const name of graph.keys()) walk(name);
  const core = JSON.parse(await readFile('wrangler.core.jsonc', 'utf8'));
  assert.deepEqual(core.ratelimits.map(r => r.simple.limit), [120,30,10]);
});

test('Migration helper selects only 0007 and retains explicit existing database bindings', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'magnt-c1-config-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(folder, 'wrangler.core.jsonc'), await readFile('wrangler.core.jsonc'));
  execFileSync(process.execPath, [resolve('scripts/prepare-core-config.mjs'), '--dialogue-migration'], {
    cwd: folder, env: { ...process.env, MAGNT_D1_DATABASE_ID: '00000000-0000-0000-0000-000000000001', MAGNT_OAUTH_KV_ID: 'a'.repeat(32) } });
  const config = JSON.parse(await readFile(join(folder, 'wrangler.dialogue-migration.generated.json'), 'utf8'));
  assert.equal(config.d1_databases[0].database_name, 'magnt-contacts');
  assert.equal(config.d1_databases[0].migrations_pattern, 'migrations/0007_dialogues.sql');
  assert.equal(config.d1_databases[0].database_id, '00000000-0000-0000-0000-000000000001');
  assert.equal(basename(config.main), 'core.js');
});
