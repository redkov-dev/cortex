const messages = {
  invalid_arguments: 'Проверьте названные поля запроса.',
  invalid_cursor: 'Список или история изменились. Начните чтение без курсора.',
  conversation_not_found: 'Обращение или цель не найдены.',
  reply_not_found: 'Черновик не найден в этой беседе.',
  reply_channel_unavailable: 'Канал ответа посетителю ещё не подключён. Можно сохранить частный черновик; публикация не выполнена.',
  revision_conflict: 'Беседа изменилась. Перечитайте её, сохраните подготовленный текст и повторите действие с новой версией.',
  submission_conflict: 'Этот submission_id уже использован для другого действия или содержимого.',
  storage_unavailable: 'Хранилище не подтвердило операцию. Повторите запись с тем же submission_id и содержимым.',
  forbidden: 'Это действие не разрешено для текущего доступа.',
  response_too_large: 'Событие слишком велико для одного ответа. Оно не было обрезано.',
};
export class OwnerError extends Error {
  constructor(code, details = {}) { super(code); this.code = code; this.details = details; }
}
export function ownerFailure(error) {
  const code = error instanceof OwnerError && Object.hasOwn(messages, error.code) ? error.code : 'storage_unavailable';
  return { status: 'error', code, message: messages[code], ...(error instanceof OwnerError ? error.details : {}) };
}
export function requireOwner(actor, write = false) {
  if (!actor?.verified || !actor.id || (write && !actor.canWrite)) throw new OwnerError('forbidden');
}
export async function contentHash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}
export const conversationId = sourceId => 'oc_' + sourceId;
export const incomingEventId = sourceId => 'in_' + sourceId;
