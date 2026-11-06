import { readContact, listContactSources, listDialogueContactSources, contactSourceVersion } from './contacts.js';
import { readObservation, listObservationSources, observationSourceVersion } from './observations.js';
import { readNotificationOverview } from './owner-notifications.js';
import { initialState, readStates, readWorkspace, workspaceRevision, replayOperation, changeWorkspace } from './owner-workspace.js';
import { conversationId, incomingEventId, OwnerError, requireOwner } from './owner-errors.js';
import { validateOwnerInput, encodeCursor, decodeCursor } from './owner-validation.js';
import { dialogueEnabled, dialogueWritable } from './dialogue-common.js';
import { readDialogueMetadata, findDialogue, listMessages, findMessage } from './dialogues.js';
import { readReceipts, readStatus, markMessagesRead, readReceiptOverview } from './message-reads.js';
import { publishReply, manageDialogueAccess } from './dialogue-workflow.js';

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
function capabilities(source, actor, env, dialogue) {
  if (dialogueEnabled(env) && dialogue?.active_access) return {
    can_draft: actor.canWrite, can_publish: actor.canWrite && dialogueWritable(env), reply_channel: 'mcp_dialogue',
    dialogue_id: dialogue.dialogue_id, access_status: 'active',
    reply_channel_reason: 'Клиент получает опубликованные ответы через get_dialogue с секретным токеном.' };
  return { can_draft: actor.canWrite, can_publish: false, reply_channel: 'unavailable',
    ...(dialogueEnabled(env) ? { access_status: dialogue ? 'revoked' : 'not_enabled' } : {}),
    reply_channel_reason: source.source_type === 'observation'
      ? 'Цель сохранена без личности посетителя и без обратного канала. Черновик будет частной заметкой.'
      : 'Публичный MCP пока не выдаёт ответы на контакты. reply_to — заявленный внешний адрес, автоматической отправки нет.' };
}
async function metadataFor(db, sources) {
  const ids = sources.map(source => conversationId(source.source_id));
  const dialogues = await readDialogueMetadata(db, ids);
  const reads = await readReceiptOverview(db, ids, [...dialogues.values()].map(d => d.last_reply_id).filter(Boolean));
  return { dialogues, reads };
}
function readMetadata(source, metadata) {
  const id = conversationId(source.source_id), dialogue = metadata.dialogues.get(id);
  const unread = Math.max(0, (dialogue?.incoming_count ?? 1) - (metadata.reads.ownerCounts.get(id) ?? 0));
  const reply = dialogue?.last_reply_id ?? null, time = reply ? metadata.reads.replies.get(reply) ?? null : null;
  return { has_unread_incoming: unread > 0, unread_incoming_count: unread,
    latest_incoming_message_id: dialogue?.latest_incoming_id ?? incomingEventId(source.source_id),
    last_reply_message_id: reply, last_reply_read_status: reply ? time ? 'read' : 'unread' : null, last_reply_read_at: time };
}
const hasNew = state => state.acknowledged_through < 1 && (state.acknowledged_sequence ?? 0) < (state.latest_incoming_sequence ?? 1);
async function notificationOverview(db, ids) {
  try { return await readNotificationOverview(db, ids); }
  catch { return { available: false, code: 'notification_diagnostics_unavailable', deliveries: [] }; }
}

async function listInbox(db, actor, input, flags, env) {
  const current = await versions(db);
  const cursor = input.cursor ? decodeCursor(input.cursor, 'inbox') : null;
  if (cursor && (!sameVersions(cursor, current) || cursor.view !== input.view || cursor.source !== input.source || cursor.tests !== input.include_tests)) {
    throw new OwnerError('invalid_cursor');
  }
  const options = { before: cursor?.before, includeTests: input.include_tests, limit: 51 };
  const [contacts, observations] = await Promise.all([
    input.source !== 'observation' ? (dialogueEnabled(env) ? listDialogueContactSources : listContactSources)(db, options) : [],
    input.source !== 'contact' ? listObservationSources(db, options) : [],
  ]);
  const candidates = [...contacts, ...observations].sort(sortSources).slice(0, 50);
  const states = await readStates(db, candidates);
  const metadata = dialogueEnabled(env) ? await metadataFor(db, candidates) : null;
  const items = [];
  let scanned = 0;
  for (const source of candidates) {
    scanned++;
    const state = states.get(conversationId(source.source_id)) ?? initialState(source);
    const isNew = hasNew(state);
    const archived = Boolean(state.archived);
    if (input.view === 'archived' ? !archived : input.view === 'needs_attention' ? (archived || !isNew) : false) continue;
    items.push({ conversation_id: state.conversation_id, source_type: source.source_type, source_id: source.source_id,
      summary: source.summary, last_incoming_at: source.created_at, is_test: Boolean(source.self_reported_test),
      revision: state.revision, has_new_incoming: isNew, needs_attention: isNew && !archived, archived,
      ...capabilities(source, actor, env, metadata?.dialogues.get(state.conversation_id)),
      ...(metadata ? readMetadata(source, metadata) : {}) });
    if (items.length >= input.limit) break;
  }
  const notifications = await notificationOverview(db, items.map(item => metadata?.dialogues.get(item.conversation_id)?.latest_incoming_id?.startsWith('dm_')
    ? item.latest_incoming_message_id : item.source_id));
  for (const item of items) {
    const continuation = item.latest_incoming_message_id?.startsWith('dm_');
    const type = item.source_type === 'observation' ? 'observed_goal' : continuation ? 'dialogue_message' : 'contact';
    item.notification = notifications.deliveries.find(row => row.source_type === type && row.source_id === (continuation ? item.latest_incoming_message_id : item.source_id)) ?? null;
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

async function readConversation(db, actor, input, env) {
  await workspaceRevision(db);
  const source = await sourceFor(db, input.reference);
  const cursor = input.cursor ? decodeCursor(input.cursor, 'conversation') : null;
  const { state, replies } = await readWorkspace(db, source, { after: cursor?.after ?? 0, limit: input.limit + 1 });
  const metadata = dialogueEnabled(env) ? await metadataFor(db, [source]) : null;
  const dialogue = metadata?.dialogues.get(state.conversation_id);
  if (cursor && (cursor.conversation_id !== state.conversation_id || cursor.revision !== state.revision || cursor.after > state.last_sequence)) {
    throw new OwnerError('invalid_cursor');
  }
  const { source_type: _type, source_id: _id, ...content } = source;
  const incoming = { event_id: incomingEventId(source.source_id), sequence: 1, author: 'visitor',
    type: source.source_type === 'contact' ? 'contact' : 'observed_goal', created_at: source.created_at,
    content, identity_verified: false };
  const messages = dialogue ? await listMessages(db, dialogue.dialogue_id, Math.max(1, cursor?.after ?? 0), input.limit + 1) : [];
  const events = [...(!cursor || cursor.after < 1 ? [incoming] : []), ...replies.map(reply => ({
    event_id: reply.reply_id, sequence: reply.sequence, author: 'alexander', type: reply.status === 'published' ? 'published_draft_reference' : 'draft',
    ...(reply.status === 'published' ? { published_event_id: reply.published_event_id } : { body: reply.body }),
    created_at: reply.created_at, updated_at: reply.updated_at, private: true })),
  ...messages.map(message => ({ event_id: message.message_id, message_id: message.message_id, sequence: message.sequence,
    author: message.author, type: 'message', body: message.body, created_at: message.created_at,
    in_reply_to_message_id: message.in_reply_to_message_id, ...(message.author === 'visitor' ? { identity_verified: false } : {}) }))]
    .sort((a, b) => a.sequence - b.sequence).slice(0, input.limit + 1);
  if (metadata) {
    const receipts = await readReceipts(db, state.conversation_id, events.map(event => event.event_id));
    for (const event of events) if (event.author === 'visitor' || event.type === 'message') {
      // Reserve the space required by the mark that will only be persisted after page selection.
      Object.assign(event, event.author === 'visitor' ? { read_status: 'read', read_at: new Date().toISOString() }
        : readStatus(receipts, event.event_id, 'visitor'));
    }
  }
  const result = { status: 'conversation', conversation_id: state.conversation_id, source_type: source.source_type,
    source_id: source.source_id, revision: state.revision, is_test: Boolean(source.self_reported_test),
    has_new_incoming: hasNew(state), archived: Boolean(state.archived),
    latest_incoming_event_id: dialogue?.latest_incoming_id ?? incoming.event_id, ...capabilities(source, actor, env, dialogue),
    ...(metadata ? readMetadata(source, metadata) : {}),
    events: [], has_more: false, next_cursor: null, content_trust: 'untrusted_visitor_content' };
  let after = cursor?.after ?? 0;
  for (const event of events.slice(0, input.limit)) {
    result.events.push(event);
    // Reserve space for cursor and JSON-RPC envelope; count both MCP result representations.
    if (responseSize(result) > 59 * 1024) { result.events.pop(); break; }
    after = event.sequence;
  }
  if (events.length && !result.events.length) throw new OwnerError('response_too_large');
  // The workspace sequence also includes dialogue events hidden while C.1 reading is paused.
  // Only offer another page when a further event is actually available in this mode.
  result.has_more = events.some(event => event.sequence > after);
  result.next_cursor = encodeCursor({ kind: 'conversation', conversation_id: state.conversation_id, revision: state.revision, after });
  const notifications = await notificationOverview(db, [dialogue?.latest_incoming_id?.startsWith('dm_') ? dialogue.latest_incoming_id : source.source_id]);
  result.notification = notifications.deliveries[0] ?? null;
  if (!result.events.length) result.message = 'Новых событий нет.';
  if (responseSize(result) > 62 * 1024) throw new OwnerError('response_too_large');
  if (metadata) {
    if ((await readWorkspace(db, source, { limit: 1 })).state.revision !== state.revision) throw new OwnerError('invalid_cursor');
    const marked = result.events.filter(event => event.author === 'visitor').map(event => event.event_id);
    const receipts = await markMessagesRead(db, state.conversation_id, marked, 'owner');
    for (const event of result.events) if (event.author === 'visitor') Object.assign(event, readStatus(receipts, event.event_id, 'owner'));
    if (marked.length) {
      result.unread_incoming_count = Math.max(0, (dialogue?.incoming_count ?? 1) - receipts.readCount);
      result.has_unread_incoming = result.unread_incoming_count > 0;
    }
  }
  return result;
}

export async function runOwnerOperation(env, actor, tool, rawInput) {
  const writing = ['write_reply', 'update_inbox', 'manage_dialogue_access'].includes(tool);
  requireOwner(actor, writing);
  const input = validateOwnerInput(tool, rawInput);
  const db = env.CONTACTS;
  if (!db) throw new OwnerError('storage_unavailable');
  if (tool === 'list_inbox') return listInbox(db, actor, input, {
    notifications: env.TELEGRAM_NOTIFICATIONS_ENABLED === 'true', goals: env.TELEGRAM_GOAL_NOTIFICATIONS_ENABLED === 'true' }, env);
  if (tool === 'read_conversation') return readConversation(db, actor, input, env);
  await workspaceRevision(db);
  const replay = await replayOperation(db, actor, input, tool);
  if (replay.result) return replay.result;
  try {
    const source = await sourceFor(db, input.conversation_id);
    if (tool === 'write_reply' && input.mode === 'publish') return await publishReply(env, actor, source, input, replay);
    if (tool === 'manage_dialogue_access') return await manageDialogueAccess(env, actor, source, input, replay);
    const options = { c1: dialogueEnabled(env), acknowledgeSequence: 1 };
    const dialogue = options.c1 ? await findDialogue(db, conversationId(source.source_id)) : null;
    options.canPublish = capabilities(source, actor, env, dialogue).can_publish;
    if (tool === 'update_inbox' && input.action === 'acknowledge') {
      if (input.through_event_id !== incomingEventId(source.source_id)) {
        const message = dialogue && input.through_event_id ? await findMessage(db, dialogue.dialogue_id, input.through_event_id, 'visitor') : null;
        if (!message) throw new OwnerError('invalid_arguments', { fields: ['through_event_id'] });
        options.acknowledgeSequence = message.sequence;
      }
    }
    return await changeWorkspace(db, actor, source, input, tool, replay, options);
  } catch (error) {
    // An identical concurrent call may have committed between receipt lookup and preflight/CAS.
    // Return its historical receipt (never its one-time secret), rather than a false conflict.
    const committed = await replayOperation(db, actor, input, tool);
    if (committed.result) return committed.result;
    throw error;
  }
}
