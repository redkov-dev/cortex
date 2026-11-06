import { prepareContact, findContactSubmission, newContactGate, readContact, prepareContactProjection } from './contacts.js';
import { conversationId, incomingEventId, OwnerError } from './owner-errors.js';
import { prepareInitialWorkspace, prepareWorkspaceEpoch, readWorkspace, prepareIncomingWorkspace, workspaceSequenceGate,
  prepareOwnerMutation, prepareDraftPublication, finishOwnerMutation } from './owner-workspace.js';
import { newAccess, authenticateDialogue, findDialogue, prepareDialogue, prepareAccess, prepareRevoke, prepareMessage,
  prepareDialogueState, dialogueAccessGate, dialogueActiveGate, dialogueAbsentGate, dialogueExistsGate,
  readPublicSnapshot, findMessage, publicReplay, preparePublicOperation } from './dialogues.js';
import { readReceipts, readStatus, markMessagesRead } from './message-reads.js';
import { prepareMessageNotification } from './notification-queue.js';
import { dialogueEnabled, dialogueWritable, dialogueCreateEnabled, limitDialogue, pollAdvice, checkResponseSize,
  signDialogueCursor, readDialogueCursor, combineGates } from './dialogue-common.js';

const instruction = 'Сообщение сохранено для Александра. Ориентир ожидания — один час, без гарантии срока ответа. '
  + 'Сохраните токен дискуссии и вернитесь через час: вызовите get_dialogue с dialogue_token. '
  + 'За один вызов выдаётся одно сообщение. Сохраняйте next_cursor только после получения ответа. '
  + 'Для продолжения используйте send_dialogue_message с тем же токеном и новым submission_id UUID. '
  + 'Токен — секрет доступа; не публикуйте его. Сервер не запускает фоновые проверки за клиента.';
const nextActor = dialogue => dialogue.status === 'awaiting_alexander' ? 'alexander' : 'visitor';

export async function createContactDialogue(env, input, client) {
  if (!dialogueCreateEnabled(env)) throw new OwnerError('dialogue_disabled');
  const db = env.CONTACTS;
  if (!db) throw new OwnerError('storage_unavailable');
  const contact = await prepareContact(db, input, client);
  const gate = newContactGate(contact), id = 'dg_' + crypto.randomUUID();
  const conversation = conversationId(contact.id), messageId = incomingEventId(contact.id);
  const access = await newAccess(id);
  const statements = [contact.statement, prepareInitialWorkspace(db, contact, gate),
    prepareDialogue(db, { id, contactId: contact.id, conversation, time: contact.time, incomingId: messageId, isTest: input.is_test }, gate),
    prepareMessage(db, { id: messageId, dialogue: id, sequence: 1, author: 'visitor', contact: contact.id, time: contact.time }, gate),
    prepareAccess(db, access, contact.time, gate), prepareWorkspaceEpoch(db, gate)];
  if (!input.is_test) statements.push(prepareMessageNotification(db, { sourceType: 'contact', sourceId: contact.id, createdAt: contact.time, gate }));
  await db.batch(statements);
  const saved = await findContactSubmission(db, contact.submission);
  if (!saved) throw new OwnerError('storage_unavailable');
  if (saved.payload_hash !== contact.payloadHash) throw new OwnerError('submission_conflict');
  const duplicate = saved.contact_id !== contact.id;
  const receipt = { status: 'accepted_for_human_review', contact_id: saved.contact_id, received_at: saved.created_at,
    message_id: incomingEventId(saved.contact_id), duplicate, token_issued: !duplicate };
  // A submission ID is a deduplication key, never authority to recover a secret or read current status.
  if (duplicate) {
    const existing = await findDialogue(db, conversationId(saved.contact_id));
    return { ...receipt, ...(existing ? { dialogue_id: existing.dialogue_id } : {}), review_status: 'pending',
      message: 'Повтор принят без новой записи. Токен повторно не выдаётся. Используйте сохранённый токен; при его потере потребуется перевыпуск Александром после проверки получателя.',
      continuation: existing ? 'Используйте ранее сохранённый токен; submission_id не даёт доступа к переписке.' : 'У этого старого обращения нет MCP-доступа. Александр может явно подключить его и передать токен.' };
  }
  return { ...receipt, dialogue_id: id, dialogue_token: access.token, token_expires_at: null,
    review_status: 'pending', dialogue_status: 'awaiting_alexander', read_status: 'unread', read_at: null, next_actor: 'alexander', ...pollAdvice(contact.time, 'alexander'),
    message: instruction, continuation: 'get_dialogue / send_dialogue_message; dialogue_token stays secret.' };
}

export async function getDialogue(env, input) {
  if (!dialogueEnabled(env)) throw new OwnerError('dialogue_disabled');
  const db = env.CONTACTS;
  const access = await authenticateDialogue(db, input.dialogue_token);
  await limitDialogue(env, access.access_id);
  const after = await readDialogueCursor(access, input.cursor);
  const { dialogue, messages, sentId } = await readPublicSnapshot(db, access, after, input.sent_message_id);
  const message = messages[0] ?? null;
  const receipts = await readReceipts(db, access.conversation_id, [sentId]);
  const actor = nextActor(dialogue);
  const result = { status: message ? 'message_available' : actor === 'alexander' ? 'waiting_for_reply' : 'no_new_reply',
    dialogue_id: access.dialogue_id, dialogue_status: dialogue.status,
    message: message ? { message_id: message.message_id, author: 'alexander', body: message.body,
      created_at: message.created_at, in_reply_to_message_id: message.in_reply_to_message_id,
      read_status: 'read', read_at: new Date().toISOString() } : null,
    sent_message: { message_id: sentId, ...readStatus(receipts, sentId, 'owner') },
    has_more: messages.length > 1, next_cursor: message ? await signDialogueCursor(access, message.sequence) : (input.cursor ?? null),
    next_actor: actor, ...pollAdvice(dialogue.last_incoming_at, actor, messages.length > 1),
    message_text: message ? 'Получен один ответ Александра.' : 'Новых ответов нет. ' +
      (readStatus(receipts, sentId, 'owner').read_status === 'read' ? 'Ваше сообщение прочитано через Owner.' : 'Прочтение вашего сообщения через Owner пока не зарегистрировано.') };
  checkResponseSize(result);
  // Only the selected full message is marked. Reads never consume it or change content revision.
  if (message) Object.assign(result.message, readStatus(await markMessagesRead(db, access.conversation_id, [message.message_id], 'visitor'), message.message_id, 'visitor'));
  return result;
}

export async function sendDialogueMessage(env, input) {
  if (!dialogueWritable(env)) throw new OwnerError('dialogue_disabled');
  const db = env.CONTACTS;
  let access = await authenticateDialogue(db, input.dialogue_token);
  await limitDialogue(env, access.access_id, true);
  if (input.in_reply_to_message_id && !await findMessage(db, access.dialogue_id, input.in_reply_to_message_id, 'alexander')) {
    throw new OwnerError('message_unavailable');
  }
  const source = await readContact(db, access.contact_id);
  for (let attempt = 0; attempt < 5; attempt++) {
    const replay = await publicReplay(db, access, input);
    if (replay.result) return replay.result;
    const { state } = await readWorkspace(db, source, { limit: 1 });
    const id = 'dm_' + crypto.randomUUID(), time = new Date().toISOString();
    const result = { status: 'accepted_for_human_review', dialogue_id: access.dialogue_id, message_id: id, received_at: time,
      dialogue_status: 'awaiting_alexander', read_status: 'unread', read_at: null, next_actor: 'alexander', ...pollAdvice(time, 'alexander') };
    const operation = preparePublicOperation(db, access, input, replay, result, time,
      combineGates(workspaceSequenceGate(state), dialogueAccessGate(access)));
    const gate = operation.gate;
    const statements = [operation.statement, prepareIncomingWorkspace(db, state, gate),
      prepareMessage(db, { id, dialogue: access.dialogue_id, sequence: state.last_sequence + 1,
        author: 'visitor', body: input.body, inReplyTo: input.in_reply_to_message_id, time }, gate),
      prepareDialogueState(db, access.dialogue_id, { author: 'visitor', time, id }, gate),
      prepareContactProjection(db, access.contact_id, time, input.body, gate), prepareWorkspaceEpoch(db, gate)];
    if (!access.self_reported_test) statements.push(prepareMessageNotification(db, { sourceType: 'dialogue_message', sourceId: id, createdAt: time, gate }));
    await db.batch(statements);
    const saved = await publicReplay(db, access, input);
    if (saved.result) return saved.result;
    access = await authenticateDialogue(db, input.dialogue_token);
  }
  throw new OwnerError('revision_conflict');
}

export async function publishReply(env, actor, source, input, replay) {
  if (!dialogueWritable(env) || source.source_type !== 'contact') throw new OwnerError('reply_channel_unavailable');
  const db = env.CONTACTS, conversation = conversationId(source.source_id);
  const dialogue = await findDialogue(db, conversation);
  if (!dialogue?.active_access) throw new OwnerError('reply_channel_unavailable');
  const target = input.in_reply_to_message_id ?? null;
  if (target && !await findMessage(db, dialogue.dialogue_id, target, 'visitor')) throw new OwnerError('message_unavailable');
  // Leave envelope space for the polling status, receipt and signed cursor.
  checkResponseSize({ body: input.body, reserve: 'x'.repeat(3000) });
  const { state } = await readWorkspace(db, source, { limit: 1 });
  if (state.revision !== input.expected_revision) throw new OwnerError('revision_conflict');
  const messageId = 'dm_' + crypto.randomUUID();
  const mutation = prepareOwnerMutation(db, actor, source, input, 'write_reply', replay, {
    increment: 1, acknowledge: true, guard: dialogueActiveGate(dialogue.dialogue_id),
    result: { status: 'published', message_id: messageId, published_event_id: messageId, delivery_status: 'available_to_visitor',
      reply_status: 'published', read_status: 'unread', read_at: null,
      message: 'Ответ опубликован. Клиент получит его при get_dialogue; прочтение пока не подтверждено.' } });
  const related = [prepareMessage(db, { id: messageId, dialogue: dialogue.dialogue_id, sequence: state.last_sequence + 1,
    author: 'alexander', body: input.body, inReplyTo: target, time: mutation.time }, mutation.gate),
  prepareDialogueState(db, dialogue.dialogue_id, { author: 'alexander' }, mutation.gate)];
  if (input.reply_id) related.push(prepareDraftPublication(db, conversation, input.reply_id, messageId, mutation.time, mutation.gate));
  return (await finishOwnerMutation(db, actor, input, replay, mutation, related)).value;
}

export async function manageDialogueAccess(env, actor, source, input, replay) {
  if (!dialogueEnabled(env) || (input.action !== 'revoke' && !dialogueWritable(env)) || source.source_type !== 'contact') {
    throw new OwnerError('reply_channel_unavailable');
  }
  const db = env.CONTACTS, conversation = conversationId(source.source_id);
  const existing = await findDialogue(db, conversation);
  if (input.action === 'enable' && existing) throw new OwnerError('access_already_enabled');
  if (input.action !== 'enable' && !existing) throw new OwnerError('reply_channel_unavailable');
  const id = existing?.dialogue_id ?? 'dg_' + crypto.randomUUID();
  const access = input.action === 'revoke' ? null : await newAccess(id);
  const mutation = prepareOwnerMutation(db, actor, source, input, 'manage_dialogue_access', replay, {
    guard: existing ? dialogueExistsGate(id) : dialogueAbsentGate(conversation),
    result: { status: 'access_' + input.action + 'd', action: input.action, dialogue_id: id, token_issued: false,
      message: input.action === 'revoke' ? 'Доступ отозван. Сообщения сохранены.'
        : 'Токен выдаётся только в первом ответе. Передайте его проверенному получателю вручную; повтор операции токен не вернёт.' } });
  const related = [];
  if (!existing) {
    const incomingId = incomingEventId(source.source_id);
    related.push(prepareDialogue(db, { id, contactId: source.source_id, conversation, time: source.created_at,
      incomingId, isTest: source.self_reported_test }, mutation.gate),
    prepareMessage(db, { id: incomingId, dialogue: id, sequence: 1, author: 'visitor', contact: source.source_id, time: source.created_at }, mutation.gate));
  } else related.push(prepareRevoke(db, id, mutation.time, mutation.gate));
  if (access) related.push(prepareAccess(db, access, mutation.time, mutation.gate));
  const saved = await finishOwnerMutation(db, actor, input, replay, mutation, related);
  return saved.committed && access ? { ...saved.value, token_issued: true, dialogue_token: access.token, token_expires_at: null } : saved.value;
}
