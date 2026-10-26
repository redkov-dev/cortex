import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { saveObservedSignal } from '../src/observe-task.js';
import { processOwnerNotifications, notificationText } from '../src/owner-notifications.js';

const settings = {
  TELEGRAM_NOTIFICATIONS_ENABLED: 'true', TELEGRAM_GOAL_NOTIFICATIONS_ENABLED: 'true',
  TELEGRAM_BOT_TOKEN: '123456:FAKE_TOKEN_FOR_LOCAL_TESTS_ONLY_abcdef',
  TELEGRAM_OWNER_CHAT_ID: '123456789', NOTIFY_FROM: '2020-01-01T00:00:00.000Z',
};
const ok = () => Response.json({ ok: true, result: { message_id: 42,
  chat: { id: Number(settings.TELEGRAM_OWNER_CHAT_ID), type: 'private' } } });
const statements = (sql) => sql.replace(/--[^\n]*/g, '').split(';').filter((s) => s.trim());

async function fixture(t, { through = 5, bindings = settings } = {}) {
  const modules = {};
  for (const name of (await readdir('dist')).filter((n) => n.endsWith('.js') || n.endsWith('.sql'))) {
    modules[name] = { type: name.endsWith('.sql') ? 'text' : 'esm', contents: await readFile(`dist/${name}`, 'utf8') };
  }
  const logs = [], requests = [];
  const mf = new Miniflare({ cf: false, logRequests: false, telemetry: { enabled: false },
    handleStructuredLogs: (entry) => logs.push(entry), workers: [{ config: {
      name: 'goal-notification-test', compatibilityDate: '2026-09-23', compatibilityFlags: ['nodejs_compat'],
      manifest: { mainModule: 'index.js', modules },
      env: { CONTACTS: { type: 'd1', id: crypto.randomUUID() },
        ...Object.fromEntries(Object.entries(bindings).map(([k, value]) => [k, { type: 'text', value }])) },
    }, dev: { outboundService: { type: 'fetcher', handler: async (request) => {
      assert.equal(new URL(request.url).hostname, 'api.telegram.org');
      requests.push(await request.json()); return ok();
    } } } }] });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('CONTACTS');
  for (const name of (await readdir('migrations')).filter((n) => n.endsWith('.sql') && Number(n.slice(0, 4)) <= through).sort()) {
    await db.batch(statements(await readFile(`migrations/${name}`, 'utf8')).map((sql) => db.prepare(sql)));
  }
  let clock = Date.now();
  const run = (overrides = {}, deps = {}) => processOwnerNotifications({ ...settings, CONTACTS: db, ...overrides }, {
    now: () => clock, sleep: async (ms) => { clock += ms; }, log: (event) => logs.push(event),
    fetcher: async (_url, init) => { requests.push(JSON.parse(init.body)); return ok(); }, ...deps,
  });
  return { mf, db, logs, requests, run, advance: (ms) => { clock += ms; } };
}

function rpc(goal, { isTest = false, controlled = false, tool = 'search_shared_experience' } = {}) {
  return { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': tool,
    ...(controlled ? { 'User-Agent': 'MAGNT-Controlled-Test/0.2' } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool,
    arguments: { goal, is_test: isTest }, _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'goal-notifications-test', version: '0.1.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    } } }) };
}

async function contact(db) {
  const id = `mc_${crypto.randomUUID()}`;
  await db.prepare(`INSERT INTO contacts (contact_id, created_at, summary, submission_id, payload_hash)
    VALUES (?, ?, 'Contact remains deliverable', ?, 'hash')`)
    .bind(id, new Date().toISOString(), crypto.randomUUID()).run();
  return id;
}

test('public search atomically saves a private goal and delivers its full text through Cron', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const goal = '<b>PRIVATE_GOAL_SENTINEL</b> ' + 'я'.repeat(970);
  const response = await f.mf.dispatchFetch('https://magnt.ru/mcp', rpc(goal));
  assert.equal((await response.json()).result.structuredContent.status, 'no_relevant_experience');
  const observation = await f.db.prepare('SELECT * FROM observed_task_signals').first();
  const queued = await f.db.prepare('SELECT * FROM owner_notification_outbox').first();
  assert.equal(queued.source_type, 'observed_goal'); assert.equal(queued.source_id, observation.observation_id);
  assert.ok(!queued.notification_id.includes(observation.observation_id));
  assert.equal(queued.status, 'pending'); assert.equal(f.requests.length, 0);
  await (await f.mf.getWorker()).scheduled({ cron: '* * * * *', scheduledTime: Date.now() });
  assert.equal(f.requests.length, 1); assert.ok(f.requests[0].text.includes(goal));
  assert.match(f.requests[0].text, /^MAGNT · цель агента/);
  assert.equal(f.requests[0].parse_mode, undefined);
  assert.deepEqual(f.requests[0].link_preview_options, { is_disabled: true });
  assert.equal(f.requests[0].chat_id, settings.TELEGRAM_OWNER_CHAT_ID);
  assert.equal((await f.run()).sent, 0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM task_signals').first()).n, 0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM contacts').first()).n, 0);
  const logs = JSON.stringify(f.logs);
  for (const value of [goal, observation.observation_id, settings.TELEGRAM_BOT_TOKEN]) assert.ok(!logs.includes(value));
});

test('test labels, controlled searches and shared contributions do not notify; matches still notify', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  for (const options of [{ isTest: true }, { controlled: true }, { tool: 'contribute_task_signal' }]) {
    const response = await f.mf.dispatchFetch('https://magnt.ru/mcp', rpc('database migration retries', options));
    assert.equal(response.status, 200);
  }
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM owner_notification_outbox').first()).n, 0);
  const response = await f.mf.dispatchFetch('https://magnt.ru/mcp', rpc('database migration retries'));
  assert.equal((await response.json()).result.structuredContent.status, 'matches_found');
  assert.equal((await f.run()).sent, 1);
});

test('enabling goals does not backfill history and pausing goals leaves contacts deliverable', async (t) => {
  const f = await fixture(t);
  await saveObservedSignal(f.db, { goal: 'OLD_GOAL_NO_BACKFILL' });
  assert.equal((await f.run()).sent, 0);
  await saveObservedSignal(f.db, { goal: 'NEW_GOAL_SENTINEL' }, { notifyOwner: true });
  await contact(f.db);
  assert.equal((await f.run({ TELEGRAM_GOAL_NOTIFICATIONS_ENABLED: 'false' })).sent, 1);
  assert.match(f.requests[0].text, /новое обращение/);
  assert.equal((await f.db.prepare("SELECT status FROM owner_notification_outbox WHERE source_type = 'observed_goal'").first()).status, 'pending');
  f.advance(60_000); assert.equal((await f.run()).sent, 1);
  assert.match(f.requests[1].text, /NEW_GOAL_SENTINEL/);
  assert.ok(f.requests.every((r) => !r.text.includes('OLD_GOAL_NO_BACKFILL')));
});

test('queue failure rolls back the observation but public search keeps its result', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  await f.db.prepare(`CREATE TRIGGER reject_goal_queue BEFORE INSERT ON owner_notification_outbox
    WHEN NEW.source_type = 'observed_goal' BEGIN SELECT RAISE(ABORT, 'PRIVATE_QUEUE_ERROR'); END`).run();
  await assert.rejects(saveObservedSignal(f.db, { goal: 'PRIVATE_ATOMIC_GOAL' }, { notifyOwner: true }));
  const response = await f.mf.dispatchFetch('https://magnt.ru/mcp', rpc('PRIVATE_SEARCH_SURVIVES'));
  assert.equal((await response.json()).result.structuredContent.status, 'no_relevant_experience');
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM observed_task_signals').first()).n, 0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM owner_notification_outbox').first()).n, 0);
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_QUEUE_ERROR'));
  await saveObservedSignal(f.db, { goal: 'Observation works with notifications disabled' });
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM observed_task_signals').first()).n, 1);
});

test('goal retries share the channel backoff and a contact takes priority over a goal backlog', async (t) => {
  const f = await fixture(t);
  await saveObservedSignal(f.db, { goal: 'RETRIED_GOAL' }, { notifyOwner: true });
  assert.equal((await f.run({}, { fetcher: async () => Response.json({ ok: false, error_code: 429,
    parameters: { retry_after: 7200 } }, { status: 429 }) })).retried, 1);
  await contact(f.db); f.advance(60_000);
  assert.equal((await f.run()).outcome, 'busy_or_backoff');
  f.advance(7200_000); assert.equal((await f.run()).sent, 2);
  assert.match(f.requests[0].text, /новое обращение/); assert.match(f.requests[1].text, /RETRIED_GOAL/);
  assert.equal((await f.db.prepare("SELECT attempts FROM owner_notification_outbox WHERE source_type = 'observed_goal'").first()).attempts, 2);
});

test('goal metadata mode omits the text, and removed or reclassified sources cannot be delivered', async (t) => {
  const f = await fixture(t);
  await saveObservedSignal(f.db, { goal: 'PRIVATE_METADATA_GOAL' }, { notifyOwner: true });
  assert.equal((await f.run({ TELEGRAM_PREVIEW_MODE: 'metadata_only' })).sent, 1);
  assert.ok(!f.requests[0].text.includes('PRIVATE_METADATA_GOAL'));
  for (const removed of [false, true]) {
    const saved = await saveObservedSignal(f.db, { goal: 'DO_NOT_DELIVER' }, { notifyOwner: true });
    await f.db.prepare(removed ? 'DELETE FROM observed_task_signals WHERE observation_id = ?'
      : 'UPDATE observed_task_signals SET self_reported_test = 1 WHERE observation_id = ?').bind(saved.observation_id).run();
  }
  f.advance(60_000); assert.equal((await f.run()).failed, 2); assert.equal(f.requests.length, 1);
  const text = notificationText({ source_type: 'observed_goal', notification_id: 'test' },
    { observation_id: 'ots_test', created_at: new Date().toISOString(), goal: 'a\u202Eb\u0000c\n d' });
  assert.ok(!/[\u202E\u0000]/u.test(text));
});

test('concurrent Cron runs do not duplicate goals and separate searches remain separate observations', async (t) => {
  const f = await fixture(t);
  await Promise.all([1, 2].map(() => saveObservedSignal(f.db, { goal: 'SAME_GOAL_SEPARATE_SEARCHES' }, { notifyOwner: true })));
  let release, entered, calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const first = f.run({}, { fetcher: async () => { calls++; entered(); await gate; return ok(); } });
  await started;
  try { assert.equal((await f.run()).outcome, 'busy_or_backoff'); }
  finally { release(); }
  assert.equal((await first).sent, 2); assert.equal(calls, 2);
  const rows = (await f.db.prepare('SELECT attempts, status, source_id FROM owner_notification_outbox').all()).results;
  assert.equal(new Set(rows.map((row) => row.source_id)).size, 2);
  assert.ok(rows.every((row) => row.attempts === 1 && row.status === 'sent'));
});

test('the previous schema still supports public search and contact delivery when goals are disabled', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { through: 4, bindings: { ...settings, TELEGRAM_GOAL_NOTIFICATIONS_ENABLED: 'false' } });
  const response = await f.mf.dispatchFetch('https://magnt.ru/mcp', rpc('LEGACY_SCHEMA_GOAL'));
  assert.equal((await response.json()).result.structuredContent.status, 'no_relevant_experience');
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM observed_task_signals').first()).n, 1);
  await contact(f.db);
  assert.equal((await f.run({ TELEGRAM_GOAL_NOTIFICATIONS_ENABLED: 'false' })).sent, 1);
});

test('migration preserves existing delivery states and rolls back completely on a batch failure', async (t) => {
  const f = await fixture(t, { through: 4 });
  await contact(f.db); await f.run({ TELEGRAM_GOAL_NOTIFICATIONS_ENABLED: 'false' });
  await contact(f.db); f.advance(60_000);
  await f.run({ TELEGRAM_GOAL_NOTIFICATIONS_ENABLED: 'false' }, { fetcher: async () => Response.json({ ok: false }, { status: 503 }) });
  const rows = (await f.db.prepare('SELECT * FROM owner_notification_outbox ORDER BY notification_id').all()).results;
  const state = await f.db.prepare('SELECT * FROM owner_notification_state').first();
  const sql = statements(await readFile('migrations/0005_observed_goal_notifications.sql', 'utf8'));
  await assert.rejects(f.db.batch([...sql.slice(0, 3).map((s) => f.db.prepare(s)), f.db.prepare('SELECT * FROM nonexistent_migration_fixture')]));
  assert.deepEqual((await f.db.prepare('SELECT * FROM owner_notification_outbox ORDER BY notification_id').all()).results, rows);
  assert.equal(await f.db.prepare("SELECT name FROM sqlite_master WHERE name = 'owner_notification_outbox_next'").first(), null);
  for (let i = 0; i < 2; i++) {
    await f.db.batch(sql.map((s) => f.db.prepare(s)));
    assert.deepEqual((await f.db.prepare('SELECT * FROM owner_notification_outbox ORDER BY notification_id').all()).results, rows);
    assert.deepEqual(await f.db.prepare('SELECT * FROM owner_notification_state').first(), state);
  }
  await saveObservedSignal(f.db, { goal: 'Post-migration goal' }, { notifyOwner: true });
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM owner_notification_outbox WHERE source_type = 'observed_goal'").first()).n, 1);
});
