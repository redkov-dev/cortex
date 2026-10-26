import { readContact, listContactSources, contactSourceVersion } from './contacts.js';
import { readObservation, listObservationSources, observationSourceVersion } from './observations.js';
import { readNotificationOverview } from './owner-notifications.js';
import { initialState, readStates, readWorkspace, workspaceRevision, replayOperation, changeWorkspace } from './owner-workspace.js';
import { conversationId, incomingEventId, OwnerError, requireOwner } from './owner-errors.js';
import { validateOwnerInput, encodeCursor, decodeCursor } from './owner-validation.js';

// Conservative budget for both structured data and an escaped JSON text copy.
const responseSize = value => 2 * new TextEncoder().encode(JSON.stringify(JSON.stringify(value))).byteLength;
const sortSources = (a, b) => a.created_at === b.created_at
  ? (a.source_id === b.source_id ? 0 : a.source_id > b.source_id ? -1 : 1)
  : a.created_at > b.created_at ? -1 : 1;
async function versions(db) {
  const [epoch, contacts, observations] = await Promise.all([workspaceRevision(db), contactSourceVersion(db), observationSourceVersion(db)]);
  return { epoch, contacts, observations };
}
function sameVersions(a, b) {
  return a.epoch === b.epoch && JSON.stringify(a.contacts) === JSON.stringify(b.contacts)
    && JSON.stringify(a.observations) === JSON.stringify(b.observations);
}
async function sourceFor(db, reference) {
  const id = reference.startsWith('oc_') ? reference.slice(3) : reference;
  const source = id.startsWith('mc_') ? await readContact(db, id)
    : id.startsWith('ots_') ? await readObservation(db, id) : null;
  if (!source) throw new OwnerError('conversation_not_found');
  return source;
}
function capabilities(source, actor) {
  return { can_draft: actor.canWrite, can_publish: false, reply_channel: 'unavailable',
    reply_channel_reason: source.source_type === 'observation'
      ? 'Цель сохранена без личности посетителя и без обратного канала. Черновик будет частной заметкой.'
      : 'Публичный MCP пока не выдаёт ответы на контакты. reply_to — заявленный внешний адрес, автоматической отправки нет.' };
}
async function notificationOverview(db, ids) {
  try { return await readNotificationOverview(db, ids); }
  catch { return { available: false, code: 'notification_diagnostics_unavailable', deliveries: [] }; }
}

async function listInbox(db, actor, input, flags) {
  const current = await versions(db);
  const cursor = input.cursor ? decodeCursor(input.cursor, 'inbox') : null;
  if (cursor && (!sameVersions(cursor, current) || cursor.view !== input.view || cursor.source !== input.source || cursor.tests !== input.include_tests)) {
    throw new OwnerError('invalid_cursor');
  }
  const options = { before: cursor?.before, includeTests: input.include_tests, limit: 51 };
  const [contacts, observations] = await Promise.all([
    input.source !== 'observation' ? listContactSources(db, options) : [],
    input.source !== 'contact' ? listObservationSources(db, options) : [],
  ]);
  const candidates = [...contacts, ...observations].sort(sortSources).slice(0, 50);
  const states = await readStates(db, candidates);
  const items = [];
  let scanned = 0;
  for (const source of candidates) {
    scanned++;
    const state = states.get(conversationId(source.source_id)) ?? initialState(source);
    const isNew = state.acknowledged_through < 1;
    const archived = Boolean(state.archived);
    if (input.view === 'archived' ? !archived : input.view === 'needs_attention' ? (archived || !isNew) : false) continue;
    items.push({ conversation_id: state.conversation_id, source_type: source.source_type, source_id: source.source_id,
      summary: source.summary, last_incoming_at: source.created_at, is_test: Boolean(source.self_reported_test),
      revision: state.revision, has_new_incoming: isNew, needs_attention: isNew && !archived, archived,
      ...capabilities(source, actor) });
    if (items.length >= input.limit) break;
  }
  const notifications = await notificationOverview(db, items.map(item => item.source_id));
  for (const item of items) {
    const type = item.source_type === 'observation' ? 'observed_goal' : 'contact';
    item.notification = notifications.deliveries.find(row => row.source_type === type && row.source_id === item.source_id) ?? null;
  }
  delete notifications.deliveries;
  if (!sameVersions(current, await versions(db))) throw new OwnerError('invalid_cursor');
  const result = { status: 'inbox', items, has_more: false, scanned, next_cursor: null,
    notifications: { ...notifications, enabled: flags.notifications, goal_notifications_enabled: flags.goals },
    content_trust: 'untrusted_visitor_content',
    message: 'Если has_more=true, продолжите по next_cursor, даже когда страница пуста.' };
  while (responseSize(result) > 59 * 1024 && result.items.length > 1) {
    const removed = result.items.pop();
    scanned = candidates.findIndex(row => row.source_id === removed.source_id);
  }
  const last = scanned ? candidates[scanned - 1] : null;
  result.scanned = scanned;
  result.has_more = scanned < contacts.length + observations.length;
  result.next_cursor = result.has_more && last ? encodeCursor({ kind: 'inbox', ...current, view: input.view, source: input.source,
    tests: input.include_tests, before: { time: last.created_at, id: last.source_id } }) : null;
  return result;
}

async function readConversation(db, actor, input) {
  await workspaceRevision(db);
  const source = await sourceFor(db, input.reference);
  const cursor = input.cursor ? decodeCursor(input.cursor, 'conversation') : null;
  const { state, replies } = await readWorkspace(db, source, { after: cursor?.after ?? 0, limit: input.limit + 1 });
  if (cursor && (cursor.conversation_id !== state.conversation_id || cursor.revision !== state.revision || cursor.after > state.last_sequence)) {
    throw new OwnerError('invalid_cursor');
  }
  const { source_type: _type, source_id: _id, ...content } = source;
  const incoming = { event_id: incomingEventId(source.source_id), sequence: 1, author: 'visitor',
    type: source.source_type === 'contact' ? 'contact' : 'observed_goal', created_at: source.created_at,
    content, identity_verified: false };
  const events = [...(!cursor || cursor.after < 1 ? [incoming] : []), ...replies.map(reply => ({
    event_id: reply.reply_id, sequence: reply.sequence, author: 'alexander', type: 'draft',
    body: reply.body, created_at: reply.created_at, updated_at: reply.updated_at, private: true }))];
  const result = { status: 'conversation', conversation_id: state.conversation_id, source_type: source.source_type,
    source_id: source.source_id, revision: state.revision, is_test: Boolean(source.self_reported_test),
    has_new_incoming: state.acknowledged_through < 1, archived: Boolean(state.archived),
    latest_incoming_event_id: incoming.event_id, ...capabilities(source, actor),
    events: [], has_more: false, next_cursor: null, content_trust: 'untrusted_visitor_content' };
  let after = cursor?.after ?? 0;
  for (const event of events.slice(0, input.limit)) {
    result.events.push(event);
    // Reserve space for cursor and JSON-RPC envelope; count both MCP result representations.
    if (responseSize(result) > 59 * 1024) { result.events.pop(); break; }
    after = event.sequence;
  }
  if (events.length && !result.events.length) throw new OwnerError('response_too_large');
  result.has_more = after < state.last_sequence;
  result.next_cursor = encodeCursor({ kind: 'conversation', conversation_id: state.conversation_id, revision: state.revision, after });
  const notifications = await notificationOverview(db, [source.source_id]);
  result.notification = notifications.deliveries[0] ?? null;
  if (!result.events.length) result.message = 'Новых событий нет.';
  return result;
}

export async function runOwnerOperation(env, actor, tool, rawInput) {
  const writing = ['write_reply', 'update_inbox'].includes(tool);
  requireOwner(actor, writing);
  const input = validateOwnerInput(tool, rawInput);
  const db = env.CONTACTS;
  if (!db) throw new OwnerError('storage_unavailable');
  if (tool === 'list_inbox') return listInbox(db, actor, input, {
    notifications: env.TELEGRAM_NOTIFICATIONS_ENABLED === 'true', goals: env.TELEGRAM_GOAL_NOTIFICATIONS_ENABLED === 'true' });
  if (tool === 'read_conversation') return readConversation(db, actor, input);
  await workspaceRevision(db);
  const replay = await replayOperation(db, actor, input, tool);
  if (replay.result) return replay.result;
  const source = await sourceFor(db, input.conversation_id);
  if (tool === 'write_reply' && input.mode === 'publish') throw new OwnerError('reply_channel_unavailable');
  if (tool === 'update_inbox' && input.action === 'acknowledge' && input.through_event_id !== incomingEventId(source.source_id)) {
    throw new OwnerError('invalid_arguments', { fields: ['through_event_id'] });
  }
  return changeWorkspace(db, actor, source, input, tool, replay);
}
