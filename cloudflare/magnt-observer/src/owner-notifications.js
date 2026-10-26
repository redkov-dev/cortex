import { readObservedGoal } from './observations.js';
import { notificationText, sendTelegram } from './telegram-notifications.js';
export { notificationText } from './telegram-notifications.js';

const DESTINATION = 'owner';
const DISCOVERY_LIMIT = 100;
const SEND_LIMIT = 5;
const LEASE_MS = 120_000;
const RUN_BUDGET_MS = 45_000;
const REQUEST_TIMEOUT_MS = 8_000;
const SEND_INTERVAL_MS = 1_100;
const DEFAULT_DELAYS = [60, 300, 900, 3600];

class NotificationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function configuration(env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_OWNER_CHAT_ID;
  const from = env.NOTIFY_FROM;
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new NotificationError('invalid_bot_token');
  }
  if (typeof chatId !== 'string' || !/^[1-9]\d{0,15}$/.test(chatId) || !Number.isSafeInteger(Number(chatId))) {
    throw new NotificationError('invalid_owner_chat_id');
  }
  if (typeof from !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(from)
      || !Number.isFinite(Date.parse(from))
      || new Date(from).toISOString() !== from.replace(/(?<!\.\d{3})Z$/, '.000Z')) {
    throw new NotificationError('invalid_notify_from');
  }
  const preview = env.TELEGRAM_PREVIEW_MODE ?? 'summary';
  const maxAttempts = Number(env.TELEGRAM_MAX_ATTEMPTS ?? 12);
  const rawDelays = env.TELEGRAM_RETRY_DELAYS_SECONDS;
  const delays = rawDelays === undefined ? DEFAULT_DELAYS : String(rawDelays).split(',').map(Number);
  if (!['summary', 'metadata_only'].includes(preview)
      || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 50
      || !delays.length || delays.length > 8
      || delays.some((s, i) => !Number.isInteger(s) || s < 1 || s > 86400 || (i > 0 && s < delays[i - 1]))) {
    throw new NotificationError('invalid_notification_options');
  }
  return { token, chatId, from: new Date(from).toISOString(), preview, maxAttempts, delays,
    goalsEnabled: env.TELEGRAM_GOAL_NOTIFICATIONS_ENABLED === 'true' };
}

async function discover(db, from, time) {
  return db.prepare(`
    INSERT INTO owner_notification_outbox (notification_id, source_type, source_id, destination, created_at, next_attempt_at)
    SELECT 'mn_' || c.contact_id, 'contact', c.contact_id, 'owner', c.created_at, ?
    FROM contacts c
    WHERE c.self_reported_test = 0 AND c.created_at >= ?
      AND NOT EXISTS (SELECT 1 FROM owner_notification_outbox n
        WHERE n.source_type = 'contact' AND n.source_id = c.contact_id AND n.destination = 'owner')
    ORDER BY c.created_at, c.contact_id LIMIT ?
    ON CONFLICT(source_type, source_id, destination) DO NOTHING
  `).bind(time, from, DISCOVERY_LIMIT).run();
}

async function claim(db, token, time, maxAttempts, goalsEnabled) {
  return db.prepare(`
    UPDATE owner_notification_outbox
    SET status = 'sending', attempts = attempts + 1, lease_token = ?, lease_until = ?
    WHERE notification_id = (
      SELECT notification_id FROM owner_notification_outbox
      WHERE destination = 'owner' AND attempts < ?
        AND (source_type != 'observed_goal' OR ?)
        AND ((status IN ('pending', 'retry') AND next_attempt_at <= ?)
          OR (status = 'sending' AND lease_until <= ?))
      ORDER BY CASE WHEN source_type = 'observed_goal' THEN 1 ELSE 0 END, created_at, notification_id LIMIT 1
    ) RETURNING *
  `).bind(token, time + LEASE_MS, maxAttempts, goalsEnabled ? 1 : 0, time, time).first();
}

function settlement(row, time, result, config) {
  if (result.ok) {
    return { status: 'sent', nextAttemptAt: 0, nextSendAt: time + SEND_INTERVAL_MS,
      messageId: result.messageId, sentAt: new Date(time).toISOString(), errorCode: null };
  }
  const delay = config.delays[Math.min(row.attempts - 1, config.delays.length - 1)] * 1000;
  const next = time + Math.max(delay, result.retryAfter ?? 0);
  const status = result.retryable && row.attempts < config.maxAttempts ? 'retry' : 'failed';
  return { status, nextAttemptAt: next,
    nextSendAt: result.local ? time : Math.max(next, result.retryable ? 0 : time + 3600_000),
    messageId: null, sentAt: null, errorCode: result.code };
}

async function settle(db, row, token, delivery) {
  // D1 batch is a transaction: the delivery and channel pause must commit together.
  // changes() prevents a stale sender from updating the channel after a failed CAS.
  const saved = await db.batch([
    db.prepare(`UPDATE owner_notification_outbox
      SET status = ?, next_attempt_at = ?, last_error_code = ?, telegram_message_id = ?, sent_at = ?,
          lease_token = NULL, lease_until = 0
      WHERE notification_id = ? AND status = 'sending' AND lease_token = ?
        AND EXISTS (SELECT 1 FROM owner_notification_state WHERE destination = 'owner' AND lease_token = ?)`)
      .bind(delivery.status, delivery.nextAttemptAt, delivery.errorCode, delivery.messageId, delivery.sentAt,
        row.notification_id, token, token),
    db.prepare(`UPDATE owner_notification_state SET next_send_at = MAX(next_send_at, ?)
      WHERE destination = 'owner' AND lease_token = ? AND changes() = 1`)
      .bind(delivery.nextSendAt, token),
  ]);
  if (saved.some((result) => result.meta.changes !== 1)) throw new NotificationError('delivery_lease_lost');
}

// All dependencies are injectable for tests; production uses the fixed Telegram origin.
// No public endpoint calls this function and no received text chooses its destination.
export async function processOwnerNotifications(env, {
  fetcher = fetch, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (event) => console.log(JSON.stringify(event)),
} = {}) {
  if (env.TELEGRAM_NOTIFICATIONS_ENABLED !== 'true') return { outcome: 'disabled' };
  const started = now();
  const report = { event_type: 'owner_notifications', time: new Date(started).toISOString(),
    outcome: 'completed', discovered: 0, sent: 0, retried: 0, failed: 0 };
  const token = crypto.randomUUID();
  let db, locked = false, nextSendAt = 0;
  try {
    const config = configuration(env);
    db = env.CONTACTS;
    if (!db) throw new NotificationError('storage_unavailable');
    await db.prepare(`INSERT INTO owner_notification_state (destination, notify_from, chat_id)
      VALUES ('owner', ?, ?) ON CONFLICT(destination) DO NOTHING`).bind(config.from, config.chatId).run();
    const state = await db.prepare('SELECT * FROM owner_notification_state WHERE destination = ?').bind(DESTINATION).first();
    // Changing dashboard variables must not replay history or silently redirect private messages.
    if (!state || state.notify_from !== config.from || state.chat_id !== config.chatId) {
      throw new NotificationError('notification_configuration_changed');
    }
    report.discovered = (await discover(db, state.notify_from, now())).meta.changes;
    const acquired = await db.prepare(`UPDATE owner_notification_state SET lease_token = ?, lease_until = ?
      WHERE destination = 'owner' AND lease_until <= ? AND next_send_at <= ? RETURNING destination`)
      .bind(token, now() + LEASE_MS, now(), now()).first();
    if (!acquired) { report.outcome = 'busy_or_backoff'; return report; }
    locked = true;
    // An interrupted last attempt may have reached Telegram; do not claim it was delivered.
    report.failed += (await db.prepare(`UPDATE owner_notification_outbox
      SET status = 'failed', last_error_code = 'delivery_unconfirmed', lease_token = NULL, lease_until = 0
      WHERE attempts >= ? AND (source_type != 'observed_goal' OR ?)
        AND (status IN ('pending', 'retry') OR (status = 'sending' AND lease_until <= ?))`)
      .bind(config.maxAttempts, config.goalsEnabled ? 1 : 0, now()).run()).meta.changes;
    nextSendAt = state.next_send_at;
    for (let index = 0; index < SEND_LIMIT; index++) {
      const wait = Math.max(0, nextSendAt - now());
      if (now() + wait + REQUEST_TIMEOUT_MS >= started + RUN_BUDGET_MS) break;
      if (wait) await sleep(wait);
      const row = await claim(db, token, now(), config.maxAttempts, config.goalsEnabled);
      if (!row) break;
      const source = row.source_type === 'contact'
        ? await db.prepare('SELECT contact_id, created_at, summary FROM contacts WHERE contact_id = ? AND self_reported_test = 0')
          .bind(row.source_id).first()
        : row.source_type === 'observed_goal' ? await readObservedGoal(db, row.source_id) : null;
      if (now() + REQUEST_TIMEOUT_MS >= started + RUN_BUDGET_MS) break; // Lease permits a later retry.
      const result = row.source_type !== 'admin_test' && !source
        ? { ok: false, retryable: false, local: true, code: 'source_unavailable' }
        : await sendTelegram(config, notificationText(row, source, config.preview), fetcher);
      const settled = settlement(row, now(), result, config);
      // Retain a known Telegram pause for the cleanup attempt if the batch rolls back.
      nextSendAt = settled.nextSendAt;
      await settle(db, row, token, settled);
      report[settled.status === 'retry' ? 'retried' : settled.status]++;
      log({ event_type: 'owner_notification_delivery', notification_id: row.notification_id,
        source_type: row.source_type, outcome: settled.status, attempt: row.attempts,
        ...(result.ok ? {} : { error_code: result.code }) });
      if (!result.ok && !result.local) {
        report.outcome = 'delivery_error'; report.error_code = result.code; break;
      }
    }
  } catch (error) {
    report.outcome = 'error';
    report.error_code = error instanceof NotificationError ? error.code : 'storage_unavailable';
  } finally {
    if (locked) {
      try {
        await db.prepare(`UPDATE owner_notification_state
          SET lease_token = NULL, lease_until = 0, next_send_at = MAX(next_send_at, ?),
              last_run_at = ?, last_outcome = ?, last_error_code = ?
          WHERE destination = 'owner' AND lease_token = ?`)
          .bind(nextSendAt, new Date(now()).toISOString(), report.outcome, report.error_code ?? null, token).run();
      } catch { report.outcome = 'error'; report.error_code = 'storage_unavailable'; }
    }
    log({ ...report, duration_ms: now() - started });
  }
  return report;
}
