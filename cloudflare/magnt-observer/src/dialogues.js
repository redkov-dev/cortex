import { contentHash, OwnerError } from './owner-errors.js';
import { randomSecret } from './dialogue-common.js';
export async function newAccess(dialogueId) {
  const token = 'mdt_' + randomSecret();
  return { access_id: 'da_' + crypto.randomUUID(), dialogue_id: dialogueId, token_hash: await contentHash(token), cursor_key: randomSecret(), token };
}
export async function authenticateDialogue(db, token) {
  const access = await db.prepare(`SELECT a.*, d.contact_id, d.conversation_id, d.status, d.last_incoming_at, d.latest_incoming_id, d.self_reported_test
    FROM dialogue_access a JOIN dialogues d USING(dialogue_id) WHERE a.token_hash = ? AND a.revoked_at IS NULL`).bind(await contentHash(token)).first();
  if (!access) throw new OwnerError('dialogue_unavailable');
  return access;
}
export async function findDialogue(db, conversation) {
  return db.prepare(`SELECT d.*, EXISTS(SELECT 1 FROM dialogue_access a WHERE a.dialogue_id = d.dialogue_id AND a.revoked_at IS NULL) AS active_access
    FROM dialogues d WHERE conversation_id = ?`).bind(conversation).first();
}
export async function readDialogueMetadata(db, conversations) {
  if (!conversations.length) return new Map();
  const rows = (await db.prepare(`SELECT d.*,
    EXISTS(SELECT 1 FROM dialogue_access a WHERE a.dialogue_id = d.dialogue_id AND a.revoked_at IS NULL) AS active_access,
    (SELECT COUNT(*) FROM dialogue_events e WHERE e.dialogue_id = d.dialogue_id AND e.author = 'visitor') AS incoming_count,
    (SELECT message_id FROM dialogue_events e WHERE e.dialogue_id = d.dialogue_id AND e.author = 'alexander' ORDER BY sequence DESC LIMIT 1) AS last_reply_id
    FROM dialogues d WHERE conversation_id IN (${conversations.map(() => '?').join(',')})`).bind(...conversations).all()).results;
  return new Map(rows.map(row => [row.conversation_id, row]));
}
export function dialogueAccessGate(access) {
  return { sql: 'EXISTS (SELECT 1 FROM dialogue_access WHERE access_id = ? AND revoked_at IS NULL)', args: [access.access_id] };
}
export function dialogueActiveGate(dialogueId) {
  return { sql: 'EXISTS (SELECT 1 FROM dialogue_access WHERE dialogue_id = ? AND revoked_at IS NULL)', args: [dialogueId] };
}
export function dialogueAbsentGate(conversation) { return { sql: 'NOT EXISTS (SELECT 1 FROM dialogues WHERE conversation_id = ?)', args: [conversation] }; }
export function prepareDialogue(db, { id, contactId, conversation, time, incomingId, isTest }, gate) {
  return db.prepare(`INSERT INTO dialogues (dialogue_id, contact_id, conversation_id, created_at, last_incoming_at, latest_incoming_id, self_reported_test)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${gate.sql}`).bind(id, contactId, conversation, time, time, incomingId, isTest ? 1 : 0, ...gate.args);
}
export function dialogueExistsGate(id) { return { sql: 'EXISTS (SELECT 1 FROM dialogues WHERE dialogue_id = ?)', args: [id] }; }
export function prepareAccess(db, access, time, gate) {
  return db.prepare(`INSERT INTO dialogue_access (access_id, dialogue_id, token_hash, cursor_key, created_at)
    SELECT ?, ?, ?, ?, ? WHERE ${gate.sql}`).bind(access.access_id, access.dialogue_id, access.token_hash, access.cursor_key, time, ...gate.args);
}
export function prepareRevoke(db, dialogueId, time, gate) {
  return db.prepare(`UPDATE dialogue_access SET revoked_at = ? WHERE dialogue_id = ? AND revoked_at IS NULL AND ${gate.sql}`).bind(time, dialogueId, ...gate.args);
}
export function prepareMessage(db, message, gate) {
  return db.prepare(`INSERT INTO dialogue_events (message_id, dialogue_id, sequence, author, body, source_contact_id, in_reply_to_message_id, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${gate.sql}`).bind(message.id, message.dialogue, message.sequence, message.author,
    message.body ?? null, message.contact ?? null, message.inReplyTo ?? null, message.time, ...gate.args);
}
export function prepareDialogueState(db, dialogueId, { author, time, id }, gate) {
  return db.prepare(`UPDATE dialogues SET status = ?${author === 'visitor' ? ', last_incoming_at = ?, latest_incoming_id = ?' : ''} WHERE dialogue_id = ? AND ${gate.sql}`)
    .bind(author === 'visitor' ? 'awaiting_alexander' : 'awaiting_visitor', ...(author === 'visitor' ? [time, id] : []), dialogueId, ...gate.args);
}
export async function findMessage(db, dialogueId, id, author) {
  return db.prepare('SELECT * FROM dialogue_events WHERE dialogue_id = ? AND message_id = ? AND author = ?').bind(dialogueId, id, author).first();
}
export async function listMessages(db, dialogueId, after = 0, limit = 51, author = null) {
  return (await db.prepare(`SELECT * FROM dialogue_events WHERE dialogue_id = ? AND sequence > ? ${author ? 'AND author = ?' : ''} ORDER BY sequence LIMIT ?`)
    .bind(dialogueId, after, ...(author ? [author] : []), limit).all()).results;
}
export async function readPublicSnapshot(db, access, after, sentId) {
  // Snapshot the actor, latest incoming and selected reply together, including a fresh revocation check.
  const rows = await db.batch([
    db.prepare('SELECT d.* FROM dialogues d JOIN dialogue_access a USING(dialogue_id) WHERE a.access_id = ? AND a.revoked_at IS NULL').bind(access.access_id),
    db.prepare("SELECT * FROM dialogue_events WHERE dialogue_id = ? AND author = 'alexander' AND sequence > ? ORDER BY sequence LIMIT 2").bind(access.dialogue_id, after),
    db.prepare("SELECT e.message_id FROM dialogue_events e JOIN dialogues d USING(dialogue_id) WHERE e.dialogue_id = ? AND e.author = 'visitor' AND e.message_id = COALESCE(?, d.latest_incoming_id)")
      .bind(access.dialogue_id, sentId ?? null),
  ]);
  if (!rows[0].results.length) throw new OwnerError('dialogue_unavailable');
  if (!rows[2].results.length) throw new OwnerError('message_unavailable');
  return { dialogue: rows[0].results[0], messages: rows[1].results, sentId: rows[2].results[0].message_id };
}
export async function readDialogueNotification(db, id) {
  return db.prepare(`SELECT d.contact_id, d.conversation_id, e.message_id, e.body AS summary, e.created_at FROM dialogue_events e JOIN dialogues d USING(dialogue_id)
    WHERE e.message_id = ? AND e.author = 'visitor' AND d.self_reported_test = 0`).bind(id).first();
}
export async function publicReplay(db, access, input) {
  const hash = await contentHash({ body: input.body, in_reply_to_message_id: input.in_reply_to_message_id ?? null });
  const row = await db.prepare('SELECT * FROM dialogue_operations WHERE access_id = ? AND submission_id = ?').bind(access.access_id, input.submission_id).first();
  if (row && row.payload_hash !== hash) throw new OwnerError('submission_conflict');
  return { hash, result: row ? JSON.parse(row.result_json) : null };
}
export function preparePublicOperation(db, access, input, replay, result, time, gate) {
  const id = 'do_' + crypto.randomUUID();
  return { id, statement: db.prepare(`INSERT INTO dialogue_operations (operation_id, dialogue_id, access_id, submission_id, payload_hash, result_json, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${gate.sql} AND NOT EXISTS(SELECT 1 FROM dialogue_operations WHERE access_id = ? AND submission_id = ?)`)
    .bind(id, access.dialogue_id, access.access_id, input.submission_id, replay.hash, JSON.stringify(result), time, ...gate.args, access.access_id, input.submission_id),
    gate: { sql: 'EXISTS (SELECT 1 FROM dialogue_operations WHERE operation_id = ?)', args: [id] } };
}
