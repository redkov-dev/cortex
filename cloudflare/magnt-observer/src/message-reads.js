// Read receipts own no message body. Callers authorize and select full messages first.
export async function readReceipts(db, conversation, ids) {
  if (!ids.length) return new Map();
  return new Map((await db.prepare('SELECT * FROM message_read_receipts WHERE conversation_id = ? AND message_id IN (' + ids.map(() => '?').join(',') + ')')
    .bind(conversation, ...ids).all()).results.map(row => [row.message_id + ':' + row.reader_side, row.read_at]));
}
export function readStatus(receipts, messageId, side) {
  const readAt = receipts.get(messageId + ':' + side) ?? null;
  return { read_status: readAt ? 'read' : 'unread', read_at: readAt };
}
export async function markMessagesRead(db, conversation, ids, side) {
  if (!ids.length) return new Map();
  const time = new Date().toISOString();
  const unique = [...new Set(ids)];
  const rows = await db.batch([...unique.map(id => db.prepare(`INSERT INTO message_read_receipts
    (conversation_id, message_id, reader_side, read_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(conversation_id, message_id, reader_side) DO NOTHING`).bind(conversation, id, side, time)),
  db.prepare('SELECT * FROM message_read_receipts WHERE conversation_id = ? AND message_id IN (' + unique.map(() => '?').join(',') + ')')
    .bind(conversation, ...unique),
  db.prepare('SELECT COUNT(*) AS count FROM message_read_receipts WHERE conversation_id = ? AND reader_side = ?').bind(conversation, side)]);
  const result = new Map(rows.at(-2).results.map(row => [row.message_id + ':' + row.reader_side, row.read_at]));
  result.readCount = rows.at(-1).results[0].count;
  return result;
}
export async function readReceiptOverview(db, conversations, replyIds) {
  if (!conversations.length) return { ownerCounts: new Map(), replies: new Map() };
  const placeholders = conversations.map(() => '?').join(',');
  const statements = [db.prepare(`SELECT conversation_id, COUNT(*) AS count FROM message_read_receipts
    WHERE reader_side = 'owner' AND conversation_id IN (${placeholders}) GROUP BY conversation_id`).bind(...conversations)];
  if (replyIds.length) statements.push(db.prepare(`SELECT message_id, read_at FROM message_read_receipts
    WHERE reader_side = 'visitor' AND message_id IN (${replyIds.map(() => '?').join(',')})`).bind(...replyIds));
  const result = await db.batch(statements);
  return { ownerCounts: new Map(result[0].results.map(r => [r.conversation_id, r.count])),
    replies: new Map((result[1]?.results ?? []).map(r => [r.message_id, r.read_at])) };
}
