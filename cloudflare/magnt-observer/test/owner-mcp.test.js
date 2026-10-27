import assert from 'node:assert/strict';
import test from 'node:test';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { notificationText } from '../src/telegram-notifications.js';

import { fixture, OWNER } from './support/owner-fixture.mjs';

async function seed(f, { type = 'contact', text = 'Private input', isTest = false, time = '2026-10-20T10:00:00.000Z' } = {}) {
  const id = (type === 'contact' ? 'mc_' : 'ots_') + crypto.randomUUID();
  if (type === 'contact') await f.db.prepare('INSERT INTO contacts (contact_id, created_at, summary, reply_to, previous_contact_id, submission_id, payload_hash, self_reported_test) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, time, text, 'claimed-address@example.test', 'mc_' + crypto.randomUUID(), crypto.randomUUID(), 'test', isTest ? 1 : 0).run();
  else await f.db.prepare('INSERT INTO observed_task_signals (observation_id, created_at, goal, blocker, tried, self_reported_test) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, time, text, 'PRIVATE_BLOCKER', 'PRIVATE_TRIED', isTest ? 1 : 0).run();
  return { id, conversation_id: 'oc_' + id, incoming: 'in_' + id };
}
const write = (source, body = 'Private draft', revision = 1) => ({ conversation_id: source.conversation_id,
  body, mode: 'draft', expected_revision: revision, submission_id: crypto.randomUUID() });
const update = (source, action, revision, extra = {}) => ({ conversation_id: source.conversation_id,
  action, expected_revision: revision, submission_id: crypto.randomUUID(), ...extra });
const count = async (f, table) => (await f.db.prepare('SELECT COUNT(*) AS n FROM ' + table).first()).n;

test('owner auth rejects missing, foreign, revoked and forged credentials; public tools remain separate', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.raw('tools/list', {}, { token: null })).status, 401);
  assert.equal((await f.raw('tools/list', {}, { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await f.raw('tools/list', {}, { token: (await f.mint({ userId: '2' })).access_token })).status, 403);
  assert.equal((await f.raw('tools/list', {}, { token: (await f.mint({ epoch: 'old' })).access_token })).status, 403);
  assert.equal((await f.raw('tools/list', {}, { token: f.credentials.access_token + 'broken' })).status, 401);
  const tools = (await (await f.raw('tools/list')).json()).result.tools;
  assert.deepEqual(tools.map(x => x.name).sort(), ['list_inbox', 'read_conversation', 'update_inbox', 'write_reply']);
  assert.equal(tools.find(x => x.name === 'list_inbox').annotations.readOnlyHint, true);
  assert.equal(tools.find(x => x.name === 'write_reply').annotations.readOnlyHint, false);
  assert.equal(tools[0]._meta.securitySchemes[0].type, 'oauth2');
  const publicTools = (await (await f.raw('tools/list', {}, { token: null, public: true })).json()).result.tools;
  assert.deepEqual(publicTools.map(x => x.name).sort(), ['about_magnt', 'contribute_task_signal', 'propose_contact', 'search_shared_experience']);
  assert.equal(f.requests.length, 0);
});

test('disabled, incomplete and read-only configurations fail closed', { timeout: 60000 }, async t => {
  for (const overrides of [{ OWNER_MCP_ENABLED: 'false' }, { OWNER_GITHUB_ID: undefined }, { OWNER_AUTH_EPOCH: undefined }]) {
    const f = await fixture(t, { overrides });
    assert.equal((await f.raw('tools/list')).status, 503);
    assert.equal((await (await f.raw('tools/list', {}, { public: true })).json()).result.tools.length, 4);
  }
  const readOnly = await fixture(t, { overrides: { OWNER_MCP_WRITE_ENABLED: 'false' } });
  const source = await seed(readOnly);
  assert.equal((await readOnly.call('read_conversation', { reference: source.id })).value.can_draft, false);
  assert.equal((await readOnly.call('write_reply', write(source))).value.code, 'forbidden');
  assert.equal(await count(readOnly, 'owner_operations'), 0);
});

test('owner reads original contacts and observed goals without copying content or changing inbox state', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const contact = await seed(f, { text: 'PRIVATE_CONTACT_SENTINEL' });
  const goal = await seed(f, { type: 'observation', text: 'PRIVATE_GOAL_SENTINEL' });
  await seed(f, { isTest: true });
  const inbox = (await f.call('list_inbox')).value;
  assert.equal(inbox.items.length, 2); assert.equal(inbox.has_more, false);
  assert.ok(inbox.items.every(x => !x.is_test && x.has_new_incoming && !x.can_publish));
  assert.ok(!JSON.stringify(inbox).includes('claimed-address@example.test'));
  assert.equal((await f.call('list_inbox', { include_tests: true })).value.items.length, 3);
  assert.equal((await f.call('list_inbox', { source: 'observation' })).value.items.length, 1);
  const full = (await f.call('read_conversation', { reference: contact.id })).value;
  assert.equal(full.events[0].content.reply_to, 'claimed-address@example.test');
  assert.equal(full.reply_channel, 'unavailable');
  const observed = (await f.call('read_conversation', { reference: goal.conversation_id })).value;
  assert.equal(observed.events[0].content.blocker, 'PRIVATE_BLOCKER');
  assert.equal(observed.events[0].content.tried, 'PRIVATE_TRIED');
  assert.equal(observed.source_type, 'observation'); assert.equal(observed.events[0].identity_verified, false);
  assert.equal(await count(f, 'owner_inbox'), 0); assert.equal(await count(f, 'owner_replies'), 0);
  const published = await f.call('write_reply', { ...write(contact), mode: 'publish' });
  assert.equal(published.value.code, 'reply_channel_unavailable');
  assert.equal(await count(f, 'owner_inbox'), 0);
  assert.equal(await count(f, 'task_signals'), 0);
});

test('drafts survive new clients; exact retries are idempotent and conflicting concurrent edits are rejected', { timeout: 60000 }, async t => {
  const f = await fixture(t); const source = await seed(f);
  const input = write(source, 'PRIVATE_DRAFT_SENTINEL');
  const duplicates = await Promise.all([f.call('write_reply', input), f.call('write_reply', input)]);
  assert.deepEqual(duplicates[0].value, duplicates[1].value);
  assert.equal(duplicates[0].value.status, 'draft_saved');
  assert.equal(await count(f, 'owner_replies'), 1); assert.equal(await count(f, 'owner_operations'), 1);
  assert.equal((await f.call('write_reply', { ...input, body: 'Changed' })).value.code, 'submission_conflict');
  assert.equal((await f.call('write_reply', write(source))).value.code, 'revision_conflict');
  const legacy = new LegacyClient({ name: 'owner-second-client', version: '0.1.0' });
  try {
    await legacy.connect(new LegacyTransport(new URL(OWNER + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + f.credentials.access_token } }, fetch: f.fetchWorker }));
    const read = (await legacy.callTool({ name: 'read_conversation', arguments: { reference: source.id } })).structuredContent;
    assert.equal(read.events[1].body, input.body); assert.equal(read.revision, 2);
  } finally { await legacy.close(); }
  const edits = await Promise.all(['First edit', 'Second edit'].map(body => f.call('write_reply', {
    ...write(source, body, 2), reply_id: duplicates[0].value.reply_id })));
  assert.equal(edits.filter(x => x.value.status === 'draft_saved').length, 1);
  assert.equal(edits.filter(x => x.value.code === 'revision_conflict').length, 1);
  assert.equal(await count(f, 'owner_replies'), 1);
  assert.equal((await f.call('write_reply', input)).value.reply_id, duplicates[0].value.reply_id);
  assert.equal((await f.raw('tools/call', { name: 'write_reply', arguments: input }, { token: (await f.mint({ userId: '2' })).access_token })).status, 403);
  const other = await seed(f);
  assert.equal((await f.call('write_reply', { ...write(other), reply_id: duplicates[0].value.reply_id })).value.code, 'reply_not_found');
});

test('acknowledgement, archive and restore are explicit; drafts do not acknowledge incoming content', { timeout: 60000 }, async t => {
  const f = await fixture(t); const source = await seed(f);
  await f.call('write_reply', write(source));
  assert.equal((await f.call('list_inbox')).value.items.length, 1);
  assert.equal((await f.call('update_inbox', update(source, 'acknowledge', 2))).value.code, 'invalid_arguments');
  const acknowledge = update(source, 'acknowledge', 2, { through_event_id: source.incoming });
  assert.equal((await f.call('update_inbox', acknowledge)).value.revision, 3);
  assert.equal((await f.call('list_inbox')).value.items.length, 0);
  assert.equal((await f.call('update_inbox', update(source, 'archive', 3))).value.revision, 4);
  assert.equal((await f.call('list_inbox', { view: 'archived' })).value.items[0].conversation_id, source.conversation_id);
  assert.equal((await f.call('update_inbox', update(source, 'restore', 4))).value.revision, 5);
  assert.equal((await f.call('list_inbox', { view: 'all' })).value.items[0].archived, false);
  assert.equal((await f.call('update_inbox', acknowledge)).value.revision, 3);
  assert.equal(await count(f, 'contacts'), 1);
  const next = await seed(f);
  await f.db.prepare('UPDATE contacts SET previous_contact_id = ? WHERE contact_id = ?').bind(source.id, next.id).run();
  assert.equal((await f.call('list_inbox')).value.items[0].conversation_id, next.conversation_id);
});

test('D1 failure rolls back revision, draft and receipt together and never breaks public contact intake', { timeout: 60000 }, async t => {
  const f = await fixture(t); const source = await seed(f);
  await f.db.prepare("CREATE TRIGGER reject_draft BEFORE INSERT ON owner_replies BEGIN SELECT RAISE(ABORT, 'PRIVATE_DB_ERROR'); END").run();
  const input = write(source);
  assert.equal((await f.call('write_reply', input)).value.code, 'storage_unavailable');
  assert.equal(await count(f, 'owner_inbox'), 0); assert.equal(await count(f, 'owner_operations'), 0);
  assert.equal((await f.db.prepare('SELECT revision FROM owner_workspace_state').first()).revision, 1);
  await f.db.prepare('DROP TRIGGER reject_draft').run();
  assert.equal((await f.call('write_reply', input)).value.status, 'draft_saved');
  const oldSchema = await fixture(t, { through: 5 });
  assert.equal((await oldSchema.call('list_inbox')).value.code, 'storage_unavailable');
  const publicCall = await oldSchema.raw('tools/call', { name: 'propose_contact', arguments: { summary: 'Public intake survives missing owner migration', is_test: true } }, { public: true, token: null });
  assert.equal((await publicCall.json()).result.structuredContent.status, 'accepted_for_human_review');
});

test('inbox pagination scans archived records without omissions and detects changed snapshots', { timeout: 60000 }, async t => {
  const f = await fixture(t); const wanted = [];
  for (let i = 0; i < 65; i++) {
    const source = await seed(f, { type: i % 2 ? 'contact' : 'observation', text: 'Entry ' + i }); wanted.push(source.conversation_id);
    if (i < 55) await f.db.prepare('INSERT INTO owner_inbox (conversation_id, source_type, source_id, archived) VALUES (?, ?, ?, 1)')
      .bind(source.conversation_id, i % 2 ? 'contact' : 'observation', source.id).run();
  }
  let cursor, seen = [];
  do {
    const result = (await f.call('list_inbox', { view: 'all', limit: 7, ...(cursor ? { cursor } : {}) })).value;
    assert.equal(result.status, 'inbox'); seen.push(...result.items.map(x => x.conversation_id)); cursor = result.next_cursor;
  } while (cursor);
  assert.equal(new Set(seen).size, 65); assert.deepEqual(seen.slice().sort(), wanted.sort());
  cursor = undefined; seen = [];
  do {
    const result = (await f.call('list_inbox', { limit: 7, ...(cursor ? { cursor } : {}) })).value;
    seen.push(...result.items.map(x => x.conversation_id)); cursor = result.next_cursor;
  } while (cursor);
  assert.equal(new Set(seen).size, 10);
  const before = (await f.call('list_inbox', { view: 'all', limit: 2 })).value;
  await seed(f);
  assert.equal((await f.call('list_inbox', { view: 'all', limit: 2, cursor: before.next_cursor })).value.code, 'invalid_cursor');
  const beforeEdit = (await f.call('list_inbox', { view: 'all', limit: 2 })).value;
  await f.call('write_reply', write({ conversation_id: beforeEdit.items[0].conversation_id }));
  assert.equal((await f.call('list_inbox', { view: 'all', limit: 2, cursor: beforeEdit.next_cursor })).value.code, 'invalid_cursor');
  assert.equal((await f.call('list_inbox', { cursor: 'not-a-cursor' })).value.code, 'invalid_cursor');
});

test('large inbox pages stay under 64 KiB without skipping shortened-page candidates', { timeout: 60000 }, async t => {
  const f = await fixture(t); const expected = [];
  for (let i = 0; i < 60; i++) expected.push((await seed(f, { text: '語'.repeat(4000) })).conversation_id);
  const actual = []; let cursor;
  do {
    const response = await f.call('list_inbox', { view: 'all', limit: 50, ...(cursor ? { cursor } : {}) });
    assert.ok(response.size <= 65536, String(response.size));
    actual.push(...response.value.items.map(item => item.conversation_id)); cursor = response.value.next_cursor;
  } while (cursor);
  assert.equal(new Set(actual).size, 60); assert.deepEqual(actual.sort(), expected.sort());
});

test('Telegram next step refers to private Owner reading only when enabled, preserving metadata-only mode', () => {
  for (const type of ['contact', 'observed_goal']) {
    const row = { source_type: type, notification_id: 'test' };
    const source = { contact_id: 'mc_test', observation_id: 'ots_test', created_at: '2026-10-26T10:00:00Z', summary: 'PRIVATE_BODY', goal: 'PRIVATE_BODY' };
    const enabled = notificationText(row, source, 'metadata_only', true);
    assert.ok(enabled.includes('MAGNT Owner')); assert.ok(!enabled.includes('PRIVATE_BODY'));
    assert.ok(!notificationText(row, source, 'metadata_only', false).includes('с MAGNT Owner'));
  }
});

test('long private draft history is paged under 64 KiB and cursor cannot cross conversations or revisions', { timeout: 60000 }, async t => {
  const f = await fixture(t); const source = await seed(f, { text: '源'.repeat(3000) });
  for (let i = 1; i <= 8; i++) assert.equal((await f.call('write_reply', write(source, String(i) + '字'.repeat(7999), i))).value.status, 'draft_saved');
  let cursor, seen = [], firstCursor;
  do {
    const read = await f.call('read_conversation', { reference: source.id, limit: 50, ...(cursor ? { cursor } : {}) });
    assert.ok(read.size <= 65536, String(read.size)); assert.equal(read.value.status, 'conversation');
    seen.push(...read.value.events.map(e => e.event_id));
    firstCursor ??= read.value.next_cursor;
    cursor = read.value.has_more ? read.value.next_cursor : null;
  } while (cursor);
  assert.equal(new Set(seen).size, 9);
  const other = await seed(f);
  assert.equal((await f.call('read_conversation', { reference: other.id, cursor: firstCursor })).value.code, 'invalid_cursor');
  await f.call('write_reply', write(source, 'Another draft', 9));
  assert.equal((await f.call('read_conversation', { reference: source.id, cursor: firstCursor })).value.code, 'invalid_cursor');
});

test('private route logs never contain source text, credentials, query, referrer, client metadata or validation values', { timeout: 60000 }, async t => {
  const f = await fixture(t); const source = await seed(f, { text: 'PRIVATE_CONTENT_SENTINEL' });
  await f.call('read_conversation', { reference: source.id }, { path: '/mcp?code=PRIVATE_QUERY',
    headers: { referer: 'https://example.test/PRIVATE_REFERRER', 'user-agent': 'PRIVATE_UA' } });
  await f.call('write_reply', write(source, 'PRIVATE_DRAFT_SENTINEL'));
  assert.equal((await f.call('list_inbox', { PRIVATE_EXTRA_FIELD: 'PRIVATE_EXTRA_VALUE' })).value.code, 'invalid_arguments');
  const reserved = await f.pub.fetch('https://magnt.ru/.well-known/oauth-not-configured?token=PRIVATE_QUERY');
  assert.equal(reserved.status, 503); assert.equal(reserved.headers.get('cache-control'), 'no-store');
  const wrongHost = await f.edge.fetch('https://www.magnt.ru/mcp', { headers: { authorization: 'Bearer ' + f.credentials.access_token } });
  assert.equal(wrongHost.status, 404);
  const oversized = await f.raw('tools/call', { name: 'write_reply', arguments: write(source, 'x'.repeat(25000)) });
  assert.equal(oversized.status, 413);
  const logged = JSON.stringify(f.logs);
  for (const value of ['PRIVATE_CONTENT_SENTINEL', 'PRIVATE_DRAFT_SENTINEL', 'PRIVATE_QUERY', 'PRIVATE_REFERRER', 'PRIVATE_UA',
    'PRIVATE_EXTRA_FIELD', 'PRIVATE_EXTRA_VALUE', source.id, f.credentials.access_token]) assert.ok(!logged.includes(value), value);
  assert.equal((await f.raw('tools/list')).headers.get('cache-control'), 'no-store');
});
