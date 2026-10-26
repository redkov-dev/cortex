import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { processOwnerNotifications, notificationText } from '../src/owner-notifications.js';

const START = Date.parse('2026-10-23T10:00:00.000Z');
const settings = {
  TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
  TELEGRAM_BOT_TOKEN: '123456:FAKE_TOKEN_FOR_LOCAL_TESTS_ONLY_abcdef',
  TELEGRAM_OWNER_CHAT_ID: '123456789',
  NOTIFY_FROM: '2026-10-23T00:00:00.000Z',
};

function telegramOk(chatId = settings.TELEGRAM_OWNER_CHAT_ID, messageId = 42) {
  return Response.json({ ok: true, result: { message_id: messageId, chat: { id: Number(chatId), type: 'private' } } });
}

async function migrate(db) {
  for (const name of (await readdir('migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = await readFile(`migrations/${name}`, 'utf8');
    for (const statement of sql.replace(/--[^\n]*/g, '').split(';').filter((s) => s.trim())) await db.prepare(statement).run();
  }
}

async function fixture(t, { built = false, bindings = {}, migrations = true } = {}) {
  const modules = { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response("fixture"); } }' } };
  if (built) {
    for (const name of (await readdir(process.env.MAGNT_TEST_BUNDLE ?? 'dist')).filter((n) => n.endsWith('.js') || n.endsWith('.sql'))) {
      modules[name] = { type: name.endsWith('.sql') ? 'text' : 'esm', contents: await readFile(`${process.env.MAGNT_TEST_BUNDLE ?? "dist"}/${name}`, 'utf8') };
    }
  }
  const logs = [], requests = [];
  const mf = new Miniflare({
    cf: false, logRequests: false, telemetry: { enabled: false }, handleStructuredLogs: (entry) => logs.push(entry),
    workers: [{ config: {
      name: 'notification-test', compatibilityDate: '2026-09-23', compatibilityFlags: ['nodejs_compat'],
      manifest: { mainModule: 'index.js', modules },
      env: { CONTACTS: { type: 'd1', id: crypto.randomUUID() },
        ...Object.fromEntries(Object.entries(bindings).map(([k, value]) => [k, { type: 'text', value }])) },
    }, dev: { outboundService: { type: 'fetcher', handler: async (request) => {
      if (new URL(request.url).hostname === 'api.telegram.org') {
        requests.push(await request.json()); return telegramOk();
      }
      assert.equal(new URL(request.url).hostname, 'raw.githubusercontent.com');
      return new Response('origin fixture');
    } } } }],
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('CONTACTS');
  if (migrations) await migrate(db);
  let clock = START;
  const env = { ...settings, CONTACTS: db };
  const options = { now: () => clock, sleep: async (ms) => { clock += ms; }, log: (entry) => logs.push(entry),
    fetcher: async (url, init) => { requests.push({ url, ...JSON.parse(init.body), parse_mode: JSON.parse(init.body).parse_mode }); return telegramOk(); } };
  return { mf, db, logs, requests, env, options, run: (overrides = {}, deps = {}) => processOwnerNotifications({ ...env, ...overrides }, { ...options, ...deps }),
    advance: (ms) => { clock += ms; }, time: () => clock };
}

async function contact(db, { id = `mc_${crypto.randomUUID()}`, created = START, isTest = 0, summary = 'PRIVATE_SUMMARY_SENTINEL' } = {}) {
  await db.prepare(`INSERT INTO contacts (contact_id, created_at, summary, reply_to, self_reported_test, submission_id, payload_hash)
    VALUES (?, ?, ?, 'PRIVATE_REPLY_SENTINEL@example.test', ?, ?, 'fixture-hash')`)
    .bind(id, new Date(created).toISOString(), summary, isTest, crypto.randomUUID()).run();
  return id;
}

test('notifications are disabled by default and invalid settings never touch storage or the network', async () => {
  const unused = () => { throw Error('must not be called'); };
  assert.deepEqual(await processOwnerNotifications({ CONTACTS: { prepare: unused } }, { fetcher: unused, log: unused }), { outcome: 'disabled' });
  for (const override of [
    { TELEGRAM_BOT_TOKEN: undefined }, { TELEGRAM_OWNER_CHAT_ID: '-100123' },
    { NOTIFY_FROM: '2026-02-31T00:00:00Z' }, { NOTIFY_FROM: '' },
    { TELEGRAM_MAX_ATTEMPTS: '0' }, { TELEGRAM_RETRY_DELAYS_SECONDS: '60,no' }, { TELEGRAM_PREVIEW_MODE: 'full' },
  ]) {
    const result = await processOwnerNotifications({ ...settings, ...override, CONTACTS: { prepare: unused } }, { fetcher: unused, log: () => {} });
    assert.equal(result.outcome, 'error'); assert.match(result.error_code, /^invalid_/);
  }
});

test('D1 discovery filters history, tests and telemetry; repeated runs and migrations do not replay delivery', async (t) => {
  const f = await fixture(t);
  await contact(f.db, { created: Date.parse(settings.NOTIFY_FROM) - 1 });
  await contact(f.db, { isTest: 1 });
  const id = await contact(f.db, { summary: '<b>PRIVATE_SUMMARY_SENTINEL</b> https://example.test/\n' + '🙂'.repeat(400) });
  await f.db.prepare("INSERT INTO observed_task_signals VALUES ('obs', ?, 'OBSERVED_ONLY_SENTINEL', NULL, NULL, 0)").bind(new Date(START).toISOString()).run();
  await f.db.prepare("INSERT INTO task_signals (signal_id,created_at,goal,submission_id,payload_hash) VALUES ('signal', ?, 'SHARED_ONLY_SENTINEL','submission','hash')").bind(new Date(START).toISOString()).run();
  const first = await f.run();
  assert.equal(first.discovered, 1); assert.equal(first.sent, 1);
  const row = await f.db.prepare('SELECT * FROM owner_notification_outbox').first();
  assert.equal(row.source_id, id); assert.equal(row.status, 'sent'); assert.equal(row.attempts, 1);
  assert.equal(row.telegram_message_id, 42);
  assert.equal(f.requests[0].chat_id, settings.TELEGRAM_OWNER_CHAT_ID);
  assert.equal(f.requests[0].parse_mode, undefined);
  assert.deepEqual(f.requests[0].link_preview_options, { is_disabled: true });
  assert.match(f.requests[0].text, /<b>PRIVATE_SUMMARY_SENTINEL<\/b>/);
  assert.match(f.requests[0].text, /МСК/); assert.ok(f.requests[0].text.length <= 1500);
  assert.ok(!f.requests[0].text.includes('PRIVATE_REPLY_SENTINEL'));
  await migrate(f.db);
  f.advance(86400_000);
  assert.equal((await f.run()).discovered, 0);
  assert.equal(f.requests.length, 1);
  const logged = JSON.stringify(f.logs);
  for (const privateValue of ['PRIVATE_SUMMARY_SENTINEL', 'PRIVATE_REPLY_SENTINEL', 'OBSERVED_ONLY_SENTINEL', 'SHARED_ONLY_SENTINEL', settings.TELEGRAM_BOT_TOKEN]) {
    assert.ok(!logged.includes(privateValue));
  }
});

test('metadata-only mode and explicit admin tests do not expose message contents or count as contacts', async (t) => {
  const f = await fixture(t);
  await contact(f.db);
  await f.db.prepare(`INSERT INTO owner_notification_outbox (notification_id, source_type, source_id, created_at)
    VALUES ('mn_test', 'admin_test', 'test', ?)`)
    .bind(new Date(START).toISOString()).run();
  assert.equal((await f.run({ TELEGRAM_PREVIEW_MODE: 'metadata_only' })).sent, 2);
  assert.ok(f.requests.every((r) => !r.text.includes('PRIVATE_SUMMARY_SENTINEL')));
  assert.ok(f.requests.some((r) => r.text.includes('ТЕСТ')));
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM contacts').first()).n, 1);
  const body = notificationText({ source_type: 'contact', notification_id: 'test' },
    { contact_id: 'mc_id', created_at: new Date(START).toISOString(), summary: 'a\u202Eb\u0000c\n d' });
  assert.ok(!/[\u202E\u0000]/u.test(body));
});

test('the stored start time and recipient cannot change silently after deployment', async (t) => {
  const f = await fixture(t);
  await contact(f.db); await f.run(); f.advance(60_000);
  for (const override of [{ NOTIFY_FROM: '2020-01-01T00:00:00Z' }, { TELEGRAM_OWNER_CHAT_ID: '987654321' }]) {
    assert.equal((await f.run(override)).error_code, 'notification_configuration_changed');
  }
  assert.equal(f.requests.length, 1);
  assert.equal((await f.run({ NOTIFY_FROM: '2026-10-23T00:00:00Z' })).outcome, 'completed');
});

test('a Telegram outage does not lose persisted contacts, including arrivals during a long pause', async (t) => {
  const f = await fixture(t); await contact(f.db);
  const result = await f.run({}, { fetcher: async () => Response.json({ ok: false, description: 'PRIVATE_ERROR_SENTINEL' }, { status: 503 }) });
  assert.equal(result.retried, 1);
  let row = await f.db.prepare('SELECT * FROM owner_notification_outbox').first();
  assert.equal(row.next_attempt_at, START + 60_000); assert.equal(row.attempts, 1);
  assert.equal(row.last_error_code, 'telegram_server_error');
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM contacts').first()).n, 1);
  await contact(f.db, { created: START + 86400_000 });
  assert.equal((await f.run({ TELEGRAM_NOTIFICATIONS_ENABLED: 'false' })).outcome, 'disabled');
  f.advance(7 * 86400_000);
  assert.equal((await f.run()).sent, 2);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM owner_notification_outbox WHERE status = 'sent'").first()).n, 2);
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_ERROR_SENTINEL'));
});

test('Telegram retry_after pauses the whole destination, including newly discovered messages', async (t) => {
  const f = await fixture(t); await contact(f.db);
  await f.run({}, { fetcher: async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 7200 } }, { status: 429 }) });
  assert.equal((await f.db.prepare('SELECT next_send_at FROM owner_notification_state').first()).next_send_at, START + 7200_000);
  await contact(f.db); f.advance(60_000);
  const early = await f.run(); assert.equal(early.outcome, 'busy_or_backoff'); assert.equal(early.discovered, 1);
  assert.equal(f.requests.length, 0);
  f.advance(7200_000); assert.equal((await f.run()).sent, 2);
});

test('a failed channel update rolls back delivery and preserves the known Telegram pause during cleanup', async (t) => {
  const f = await fixture(t); await contact(f.db); await contact(f.db);
  await f.run(); // Initialize the destination before installing a storage fault.
  await f.db.prepare('DELETE FROM owner_notification_outbox').run();
  f.requests.length = 0; f.advance(60_000);
  const rateLimitedAt = f.time();
  await f.db.prepare(`CREATE TRIGGER fail_channel_backoff BEFORE UPDATE OF next_send_at ON owner_notification_state
    BEGIN SELECT RAISE(ABORT, 'PRIVATE_SQL_ERROR'); END`).run();
  let rolledBack = false;
  const failingDb = { prepare: (sql) => f.db.prepare(sql), batch: async (statements) => {
    try { return await f.db.batch(statements); }
    catch (error) {
      const statuses = (await f.db.prepare('SELECT status FROM owner_notification_outbox ORDER BY status').all()).results;
      assert.deepEqual(statuses.map((r) => r.status), ['pending', 'sending']);
      rolledBack = true;
      await f.db.prepare('DROP TRIGGER fail_channel_backoff').run();
      throw error;
    }
  } };
  const result = await f.run({ CONTACTS: failingDb }, { fetcher: async () =>
    Response.json({ ok: false, error_code: 429, parameters: { retry_after: 7200 } }, { status: 429 }) });
  assert.equal(result.error_code, 'storage_unavailable'); assert.equal(result.retried, 0);
  assert.equal(rolledBack, true);
  const state = await f.db.prepare('SELECT next_send_at, lease_token FROM owner_notification_state').first();
  assert.equal(state.next_send_at, rateLimitedAt + 7200_000); assert.equal(state.lease_token, null);
  f.advance(60_000); assert.equal((await f.run()).outcome, 'busy_or_backoff');
  assert.equal(f.requests.length, 0);
  f.advance(7200_000); assert.equal((await f.run()).sent, 2);
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_SQL_ERROR'));
});

test('permanent failures are diagnosable and a deliberate manual retry can recover them', async (t) => {
  const f = await fixture(t); await contact(f.db);
  const first = await f.run({}, { fetcher: async () => Response.json({ ok: false, error_code: 403, description: 'DO_NOT_LOG_ME' }, { status: 403 }) });
  assert.equal(first.failed, 1);
  f.advance(86400_000); assert.equal((await f.run()).discovered, 0); assert.equal(f.requests.length, 0);
  await f.db.prepare("UPDATE owner_notification_outbox SET status = 'retry', attempts = 0, next_attempt_at = 0 WHERE status = 'failed'").run();
  assert.equal((await f.run()).sent, 1);
  assert.ok(!JSON.stringify(f.logs).includes('DO_NOT_LOG_ME'));
});

test('ambiguous timeouts have bounded retries and never log exception URLs or the bot token', async (t) => {
  const f = await fixture(t); await contact(f.db);
  const broken = { fetcher: async () => { throw Object.assign(new Error(`https://api.telegram.org/bot${settings.TELEGRAM_BOT_TOKEN}/ PRIVATE_EXCEPTION`), { name: 'TimeoutError' }); } };
  assert.equal((await f.run({ TELEGRAM_MAX_ATTEMPTS: '2' }, broken)).retried, 1);
  f.advance(60_000);
  assert.equal((await f.run({ TELEGRAM_MAX_ATTEMPTS: '2' }, broken)).failed, 1);
  f.advance(86400_000); assert.equal((await f.run({ TELEGRAM_MAX_ATTEMPTS: '2' })).sent, 0);
  const row = await f.db.prepare('SELECT * FROM owner_notification_outbox').first();
  assert.equal(row.attempts, 2); assert.equal(row.last_error_code, 'telegram_timeout');
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_EXCEPTION'));
  assert.ok(!JSON.stringify(f.logs).includes(settings.TELEGRAM_BOT_TOKEN));
});

test('redirects cannot forward the bot credential and malformed success receipts are not marked sent', async (t) => {
  const f = await fixture(t); await contact(f.db);
  const redirect = await f.run({}, { fetcher: async (_url, init) => {
    assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://example.test/PRIVATE_REDIRECT' } });
  } });
  assert.equal(redirect.error_code, 'telegram_redirect_refused'); assert.equal(redirect.failed, 1);
  f.advance(3600_000); await contact(f.db);
  const unconfirmed = await f.run({}, { fetcher: async () => Response.json({ ok: true, result: {} }) });
  assert.equal(unconfirmed.sent, 0); assert.equal(unconfirmed.error_code, 'telegram_unconfirmed_response');
});

test('a stale sender cannot acknowledge another lease or claim a confirmed delivery', async (t) => {
  const f = await fixture(t); await contact(f.db);
  const result = await f.run({}, { fetcher: async () => {
    await f.db.prepare("UPDATE owner_notification_outbox SET lease_token = 'another-owner' WHERE status = 'sending'").run();
    return telegramOk();
  } });
  assert.equal(result.sent, 0); assert.equal(result.error_code, 'delivery_lease_lost');
  assert.equal((await f.db.prepare('SELECT status FROM owner_notification_outbox').first()).status, 'sending');
});

test('losing the channel lease prevents both delivery acknowledgment and overwriting a newer pause', async (t) => {
  const f = await fixture(t); await contact(f.db);
  const result = await f.run({}, { fetcher: async () => {
    await f.db.prepare("UPDATE owner_notification_state SET lease_token = 'another-owner', next_send_at = ?")
      .bind(START + 7200_000).run();
    return telegramOk();
  } });
  assert.equal(result.sent, 0); assert.equal(result.error_code, 'delivery_lease_lost');
  assert.equal((await f.db.prepare('SELECT status FROM owner_notification_outbox').first()).status, 'sending');
  assert.equal((await f.db.prepare('SELECT next_send_at FROM owner_notification_state').first()).next_send_at, START + 7200_000);
});

test('concurrent scheduled runs send each notification once with a real D1 lease', async (t) => {
  const f = await fixture(t); await contact(f.db); await contact(f.db);
  let release, entered, calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const sending = new Promise((resolve) => { entered = resolve; });
  const first = f.run({}, { fetcher: async () => { calls++; entered(); await gate; return telegramOk(); } });
  await sending;
  try {
    assert.equal((await f.run()).outcome, 'busy_or_backoff');
  } finally { release(); }
  assert.equal((await first).sent, 2); assert.equal(calls, 2); assert.equal(f.requests.length, 0);
  const rows = (await f.db.prepare('SELECT attempts, status FROM owner_notification_outbox').all()).results;
  assert.ok(rows.every((r) => r.attempts === 1 && r.status === 'sent'));
});

test('an expired send lease is recovered, but an exhausted interrupted attempt remains unconfirmed', async (t) => {
  const f = await fixture(t); await contact(f.db);
  await f.run({}, { fetcher: async () => Response.json({ ok: false }, { status: 503 }) });
  await f.db.prepare("UPDATE owner_notification_outbox SET status = 'sending', lease_token = 'crashed', lease_until = ?, next_attempt_at = 0").bind(START + 120_000).run();
  f.advance(60_000); assert.equal((await f.run()).sent, 0);
  f.advance(61_000); assert.equal((await f.run()).sent, 1);
  await contact(f.db); f.advance(60_000);
  await f.run({}, { fetcher: async () => Response.json({ ok: false }, { status: 503 }) });
  await f.db.prepare("UPDATE owner_notification_outbox SET status = 'sending', attempts = 12, lease_until = 0 WHERE status = 'retry'").run();
  f.advance(60_000); assert.equal((await f.run()).failed, 1);
  assert.equal((await f.db.prepare("SELECT last_error_code FROM owner_notification_outbox WHERE status = 'failed'").first()).last_error_code, 'delivery_unconfirmed');
});

test('a database failure after Telegram acceptance stays unconfirmed and can cause a documented retry', async (t) => {
  const f = await fixture(t); await contact(f.db);
  await f.db.prepare(`CREATE TRIGGER fail_delivery_ack BEFORE UPDATE OF status ON owner_notification_outbox
    WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'PRIVATE_SQL_ERROR'); END`).run();
  assert.equal((await f.run()).error_code, 'storage_unavailable');
  assert.equal((await f.db.prepare('SELECT status FROM owner_notification_outbox').first()).status, 'sending');
  await f.db.prepare('DROP TRIGGER fail_delivery_ack').run();
  f.advance(121_000); assert.equal((await f.run()).sent, 1);
  assert.equal(f.requests.length, 2);
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_SQL_ERROR'));
});

function rpc(name, args = {}) {
  return { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': name },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'owner-notifications-test', version: '0.1.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  } } }) };
}

test('the built Worker runs the complete MCP receipt to Cron to Telegram path without public admin routes', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { built: true, bindings: { ...settings, NOTIFY_FROM: '2020-01-01T00:00:00Z' } });
  const input = { summary: 'PRIVATE_E2E_SENTINEL', submission_id: crypto.randomUUID() };
  for (let i = 0; i < 2; i++) {
    const response = await f.mf.dispatchFetch('https://magnt.ru/mcp', rpc('propose_contact', input));
    assert.equal((await response.json()).result.structuredContent.status, 'accepted_for_human_review');
  }
  await f.mf.dispatchFetch('https://magnt.ru/mcp', rpc('propose_contact', { summary: 'TEST_DO_NOT_NOTIFY', is_test: true }));
  await f.mf.dispatchFetch('https://magnt.ru/mcp', rpc('about_magnt'));
  await f.mf.dispatchFetch('https://magnt.ru/mcp', rpc('search_shared_experience', { goal: 'SEARCH_DO_NOT_NOTIFY', is_test: true }));
  const worker = await f.mf.getWorker();
  await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() });
  assert.equal(f.requests.length, 1, JSON.stringify({ logs: f.logs,
    state: (await f.db.prepare('SELECT last_outcome, last_error_code FROM owner_notification_state').all()).results,
    outbox: (await f.db.prepare('SELECT status, last_error_code FROM owner_notification_outbox').all()).results }));
  assert.match(f.requests[0].text, /PRIVATE_E2E_SENTINEL/);
  assert.equal((await f.db.prepare('SELECT status FROM owner_notification_outbox').first()).status, 'sent');
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM contacts').first()).n, 2);
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_E2E_SENTINEL'));
  assert.ok(!JSON.stringify(f.logs).includes(settings.TELEGRAM_BOT_TOKEN));
});

test('a missing notification migration cannot break public contact storage', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { built: true, migrations: false, bindings: settings });
  const response = await f.mf.dispatchFetch('https://magnt.ru/mcp', rpc('propose_contact', { summary: 'Saved without the optional notification schema', is_test: true }));
  assert.equal((await response.json()).result.structuredContent.status, 'accepted_for_human_review');
  await (await f.mf.getWorker()).scheduled({ cron: '* * * * *', scheduledTime: Date.now() });
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM contacts').first()).n, 1);
  assert.equal(f.requests.length, 0);
  assert.match(JSON.stringify(f.logs), /storage_unavailable/);
});
