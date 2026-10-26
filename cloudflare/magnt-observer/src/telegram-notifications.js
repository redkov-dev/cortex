const REQUEST_TIMEOUT_MS = 8_000;

function shortText(value, limit) {
  return Array.from(String(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim())
    .slice(0, limit).join('');
}

export function notificationText(row, source, preview = 'summary', ownerEnabled = false) {
  if (row.source_type === 'admin_test') {
    return `MAGNT · ТЕСТ уведомлений\nПроверка личного Telegram-канала. Это не внешнее обращение.\nСобытие: ${row.notification_id}`;
  }
  const observed = row.source_type === 'observed_goal';
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short',
  }).format(new Date(source.created_at));
  if (observed) {
    const lines = ['MAGNT · цель агента', `${time} МСК`];
    if (preview === 'summary') lines.push(`Цель: «${shortText(source.goal, 1000)}»`);
    lines.push('Получена при поиске опыта.',
      `Наблюдение: ${source.observation_id}`, `Событие: ${row.notification_id}`);
    if (ownerEnabled) lines.push(`В ChatGPT с MAGNT Owner: открой цель ${source.observation_id}.`);
    return lines.join('\n');
  }
  const lines = ['MAGNT · новое обращение', `${time} МСК`, `Контакт: ${source.contact_id}`];
  if (preview === 'summary') lines.push(`Сообщение: «${shortText(source.summary, 300)}»`);
  if (ownerEnabled) lines.push(`В ChatGPT с MAGNT Owner: открой обращение ${source.contact_id}.`,
    'Можно сохранить частный черновик. Публикация ответа пока недоступна.');
  else lines.push('Обращение сохранено. Полный текст — в D1, таблица contacts, по ID контакта.',
    'Ответ из ChatGPT пока не подключён.');
  lines.push(`Событие: ${row.notification_id}`);
  return lines.join('\n');
}

export async function sendTelegram(config, text, fetcher) {
  try {
    const response = await fetcher(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, text, link_preview_options: { is_disabled: true } }),
    });
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, retryable: false, code: 'telegram_redirect_refused' };
    }
    let body;
    try { body = await response.json(); } catch { /* Never retain Telegram's raw response. */ }
    if (response.ok && body?.ok === true && Number.isSafeInteger(body.result?.message_id)
        && body.result.message_id > 0 && String(body.result.chat?.id) === config.chatId
        && body.result.chat?.type === 'private') {
      return { ok: true, messageId: body.result.message_id };
    }
    const code = Number.isInteger(body?.error_code) ? body.error_code : response.status;
    if (code === 429) {
      const seconds = body?.parameters?.retry_after;
      return { ok: false, retryable: true, code: 'telegram_rate_limited',
        retryAfter: Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 2147483647 ? seconds * 1000 : 60_000 };
    }
    if (code >= 400 && code < 500 && ![408, 425].includes(code)) {
      return { ok: false, retryable: false, code: `telegram_http_${code}` };
    }
    return { ok: false, retryable: true,
      code: code >= 500 ? 'telegram_server_error' : 'telegram_unconfirmed_response' };
  } catch (error) {
    return { ok: false, retryable: true,
      code: ['AbortError', 'TimeoutError'].includes(error?.name) ? 'telegram_timeout' : 'telegram_network_error' };
  }
}

