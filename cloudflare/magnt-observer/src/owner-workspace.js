import { OwnerError, contentHash, conversationId, requireOwner } from './owner-errors.js';

// Owns only owner_* workspace tables. Source content is resolved by the workflow.
export async function workspaceRevision(db) {
  const row = await db.prepare('SELECT revision FROM owner_workspace_state WHERE singleton = 1').first();
  if (!row) throw new OwnerError('storage_unavailable');
  return row.revision;
}
export function initialState(source) {
  return { conversation_id: conversationId(source.source_id), source_type: source.source_type,
    source_id: source.source_id, revision: 1, last_sequence: 1, acknowledged_through: 0, archived: 0 };
}
export async function readStates(db, sources) {
  if (!sources.length) return new Map();
  const ids = sources.map(s => conversationId(s.source_id));
  const rows = (await db.prepare('SELECT * FROM owner_inbox WHERE conversation_id IN (' + ids.map(() => '?').join(',') + ')')
    .bind(...ids).all()).results;
  return new Map(rows.map(row => [row.conversation_id, row]));
}
export async function readWorkspace(db, source, { after = 0, limit = 51 } = {}) {
  const id = conversationId(source.source_id);
  const result = await db.batch([
    db.prepare('SELECT * FROM owner_inbox WHERE conversation_id = ?').bind(id),
    db.prepare('SELECT * FROM owner_replies WHERE conversation_id = ? AND sequence > ? ORDER BY sequence LIMIT ?').bind(id, after, limit),
  ]);
  return { state: result[0].results[0] ?? initialState(source), replies: result[1].results };
}

function resultFromRow(row, hash) {
  if (row.payload_hash !== hash) throw new OwnerError('submission_conflict');
  return JSON.parse(row.result_json);
}
export async function replayOperation(db, actor, input, operation) {
  requireOwner(actor, true);
  const hash = await contentHash({ operation, input });
  const row = await db.prepare('SELECT payload_hash, result_json FROM owner_operations WHERE actor = ? AND submission_id = ?')
    .bind(actor.id, input.submission_id).first();
  return { hash, result: row ? resultFromRow(row, hash) : null };
}

export async function changeWorkspace(db, actor, source, input, operation, replay) {
  requireOwner(actor, true);
  const id = conversationId(source.source_id);
  const operationId = 'op_' + crypto.randomUUID();
  const time = new Date().toISOString();
  const writing = operation === 'write_reply';
  const replyId = writing ? (input.reply_id ?? 'or_' + crypto.randomUUID()) : null;
  const result = { status: writing ? 'draft_saved' : 'inbox_updated', conversation_id: id,
    revision: input.expected_revision + 1, updated_at: time,
    ...(writing ? { reply_id: replyId, reply_status: 'draft', can_publish: false,
      message: 'Черновик сохранён. Посетителю не отправлен.' } : { action: input.action }) };
  const guard = " AND NOT EXISTS (SELECT 1 FROM owner_operations WHERE actor = ? AND submission_id = ?)";
  let update, params;
  if (writing) {
    update = 'UPDATE owner_inbox SET revision = revision + 1, last_sequence = last_sequence + ? WHERE conversation_id = ? AND revision = ?' + guard;
    params = [input.reply_id ? 0 : 1, id, input.expected_revision, actor.id, input.submission_id];
    if (input.reply_id) {
      update += " AND EXISTS (SELECT 1 FROM owner_replies WHERE reply_id = ? AND conversation_id = ? AND status = 'draft')";
      params.push(replyId, id);
    }
  } else {
    const change = input.action === 'acknowledge' ? 'acknowledged_through = 1'
      : input.action === 'archive' ? 'archived = 1' : 'archived = 0';
    update = 'UPDATE owner_inbox SET revision = revision + 1, ' + change + ' WHERE conversation_id = ? AND revision = ?' + guard;
    params = [id, input.expected_revision, actor.id, input.submission_id];
  }
  const statements = [
    db.prepare('INSERT INTO owner_inbox (conversation_id, source_type, source_id) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO NOTHING')
      .bind(id, source.source_type, source.source_id),
    db.prepare(update).bind(...params),
    db.prepare('INSERT INTO owner_operations (operation_id, actor, submission_id, operation, conversation_id, payload_hash, result_json, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1')
      .bind(operationId, actor.id, input.submission_id, operation, id, replay.hash, JSON.stringify(result), time),
  ];
  if (writing) {
    statements.push(input.reply_id
      ? db.prepare("UPDATE owner_replies SET body = ?, updated_at = ? WHERE reply_id = ? AND conversation_id = ? AND status = 'draft' AND EXISTS (SELECT 1 FROM owner_operations WHERE operation_id = ?)")
        .bind(input.body, time, replyId, id, operationId)
      : db.prepare("INSERT INTO owner_replies (reply_id, conversation_id, sequence, body, created_at, updated_at) SELECT ?, conversation_id, last_sequence, ?, ?, ? FROM owner_inbox WHERE conversation_id = ? AND EXISTS (SELECT 1 FROM owner_operations WHERE operation_id = ?)")
        .bind(replyId, input.body, time, time, id, operationId));
  }
  statements.push(db.prepare('UPDATE owner_workspace_state SET revision = revision + 1 WHERE singleton = 1 AND EXISTS (SELECT 1 FROM owner_operations WHERE operation_id = ?)').bind(operationId));
  statements.push(db.prepare('SELECT payload_hash, result_json FROM owner_operations WHERE actor = ? AND submission_id = ?').bind(actor.id, input.submission_id));
  const batch = await db.batch(statements);
  const saved = batch.at(-1).results[0];
  if (saved) return resultFromRow(saved, replay.hash);
  if (writing && input.reply_id && !await db.prepare('SELECT reply_id FROM owner_replies WHERE reply_id = ? AND conversation_id = ?').bind(replyId, id).first()) {
    throw new OwnerError('reply_not_found');
  }
  throw new OwnerError('revision_conflict');
}
