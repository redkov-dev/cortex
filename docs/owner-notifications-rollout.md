# Telegram-уведомления MAGNT: включение и проверка

Базовый выпуск сообщает Александру о новых обращениях `propose_contact`.
Уведомления о целях `search_shared_experience` включаются отдельно по
[инструкции расширения](goal-notifications-rollout.md).
Он использует существующий Worker `magnt-observer` и D1 `magnt-contacts`.
Приём обращений работает независимо от Telegram. Ответы из ChatGPT и публичный
проектный диалог относятся к следующим выпускам.

Код по умолчанию ничего не отправляет: необходимы явное включение, миграция,
токен бота, адресат и дата начала уведомлений. Доступа ассистента к Cloudflare
для этих шагов не требуется.

## 1. Создать бота и определить адресата

1. В Telegram открой [@BotFather](https://t.me/BotFather), выполни `/newbot`.
   Название можно выбрать `MAGNT Owner`; уникальное имя должно оканчиваться на `bot`.
2. Сохрани выданный токен для поля Secret в Cloudflare.
3. Открой нового бота со своего личного Telegram-аккаунта и нажми **Start**.
   Используется личный чат, не группа и не канал.
4. Определи свой числовой Telegram ID — это адрес личного чата с ботом.
   С телефона можно получить его у стороннего [@userinfobot](https://t.me/userinfobot),
   отправив `/start`: нужен только результат `Id`, без передачи токена MAGNT.
   Итоговая тестовая отправка ниже проверит, что адресат выбран верно.

Альтернатива без стороннего бота: на компьютере с Python 3 запусти из каталога
`cloudflare/magnt-observer`:

```sh
python3 scripts/telegram-chat-id.py
```

Скрипт скрыто запросит токен, покажет имя бота и случайную контрольную команду.
Отправь её своему боту и нажми Enter. Скрипт читает официальный Telegram Bot API
и выводит только подтверждённый личный `TELEGRAM_OWNER_CHAT_ID`. Токен не
сохраняется в файлы, историю команд или вывод. Постоянный webhook не нужен.

## 2. Применить миграцию D1

Cloudflare → D1 → **magnt-contacts** → **Console**.

Открой [0004_owner_notifications.sql](../cloudflare/magnt-observer/migrations/0004_owner_notifications.sql),
скопируй весь SQL и выполни. Миграция создаёт очередь и одну служебную таблицу
для даты старта, адресата, блокировки параллельных запусков и пауз Telegram.
Повторное применение не удаляет данные и не сбрасывает состояние.

Проверка:

```sql
SELECT name FROM sqlite_master
WHERE type = 'table' AND name IN (
  'owner_notification_state', 'owner_notification_outbox'
);
```

Результат должен содержать обе таблицы. Если это новая, пустая D1,
сначала применяются предыдущие миграции, включая `0001_contacts.sql`.
Для разработчика альтернативная команда — `npm run db:migrate` с настроенным
Cloudflare-доступом. Обычная сборка Worker сама SQL-миграции не выполняет.

## 3. Задать настройки Worker

Открой **Workers & Pages → magnt-observer → Settings → Variables and Secrets**.

| Имя | Тип | Значение |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Secret | Токен, выданный BotFather |
| `TELEGRAM_OWNER_CHAT_ID` | Text | Твой числовой ID без пробелов и без `@` |
| `TELEGRAM_NOTIFICATIONS_ENABLED` | Text | Сначала `false` |
| `NOTIFY_FROM` | Text | Фиксированная дата начала, полученная запросом ниже |
| `TELEGRAM_PREVIEW_MODE` | Text, необязательно | `summary` — фрагмент до 300 символов; `metadata_only` — только идентификатор и время |

Получить дату начала в UTC можно в консоли D1:

```sql
SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS notify_from;
```

Скопируй результат целиком в `NOTIFY_FROM`. Дата остаётся прежней при следующих
выкладках и выключениях. Код закрепляет её в D1 при первом включении, поэтому
случайное изменение не запускает рассылку старых обращений. Адресат также
закрепляется: при несовпадении настроек отправка прекращается с понятным кодом.

Нажми сохранение/развёртывание настроек. `keep_vars: true` в конфигурации Wrangler
сохраняет эти текстовые переменные при сборках из GitHub. Секрет в репозиторий
не записывается. Если флаг включения отсутствует или отличается от точного
значения `true`, уведомления выключены.

Необязательные параметры повторов для разработчика:
`TELEGRAM_MAX_ATTEMPTS` — целое от 1 до 50, по умолчанию 12;
`TELEGRAM_RETRY_DELAYS_SECONDS` — возрастающий список пауз, например
`60,300,900,3600`. Последняя пауза повторяется. Указанный Telegram `retry_after`
может увеличить паузу и применяется ко всему каналу, включая новые сообщения.

## 4. Проверить именно твой Telegram-канал

В консоли D1 добавь отдельное тестовое уведомление:

```sql
INSERT INTO owner_notification_outbox
  (notification_id, source_type, source_id, created_at)
VALUES (
  'mn_test_' || lower(hex(randomblob(16))),
  'admin_test',
  lower(hex(randomblob(16))),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
```

Этот запрос не создаёт контакт или наблюдение спроса. Повтор запроса означает
новый отдельный тест. Сообщение в Telegram будет начинаться с **MAGNT · ТЕСТ**.

Теперь установи `TELEGRAM_NOTIFICATIONS_ENABLED=true` и сохрани настройки.
В конфигурации Worker уже предусмотрен Cron `* * * * *` — раз в минуту.
В разделе расписаний/триггеров проверь его наличие. Cloudflare предупреждает,
что первоначальное распространение изменения расписания может занять до
15 минут; после активации при небольшой очереди уведомление ожидается в
течение двух минут.

Проверь результат в D1:

```sql
SELECT notification_id, source_type, status, attempts,
       telegram_message_id, sent_at, last_error_code
FROM owner_notification_outbox
ORDER BY created_at DESC, notification_id DESC LIMIT 10;
```

Успех: в своём Telegram ты видишь тест, у строки `status=sent` и заполнен
`telegram_message_id`. Это подтверждение отправки Bot API, не измерение прочтения.
После этого новые обычные обращения будут уведомлять тебя автоматически.

Первую обычную проверку полного маршрута разработчик выполняет в изолированной
D1: настоящее сохранение через MCP, повтор с тем же `submission_id`, Cron и
перехваченный Telegram-вызов. В production искусственные обращения помечаются
`is_test=true` и не отправляются как обычные уведомления.

## 5. Читать обращение

В уведомлении есть `contact_id`. Полное обращение открывается в таблице
`contacts`, либо запросом с заменой ID:

```sql
SELECT contact_id, created_at, summary, intent, what_you_need_from_human,
       agent_identity, operator, reply_to, previous_contact_id
FROM contacts WHERE contact_id = 'mc_REPLACE_WITH_ID';
```

`reply_to` — заявленный отправителем канал, а `previous_contact_id` — заявленная
связь с другим обращением. Они не подтверждают личность или права доступа.
В этой версии ответ возможен вручную по подходящему каналу. Сообщения своему
Telegram-боту не становятся ответами посетителям.

## 6. Диагностика без выгрузки всех HTTP-событий

Состояния: `pending` — ждёт; `sending` — выполняется попытка; `retry` — ждёт
повтора; `sent` — подтверждено Telegram; `failed` — нужны действия владельца.

```sql
SELECT status, COUNT(*) AS notifications,
       MIN(created_at) AS oldest_source_time
FROM owner_notification_outbox GROUP BY status;
```

```sql
SELECT notify_from, last_run_at, last_outcome, last_error_code,
       datetime(next_send_at / 1000, 'unixepoch') AS next_send_utc
FROM owner_notification_state WHERE destination = 'owner';
```

Для ожидающей очереди:

```sql
SELECT notification_id, status, attempts, last_error_code,
       CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) AS age_seconds
FROM owner_notification_outbox
WHERE status IN ('pending', 'sending', 'retry')
ORDER BY created_at, notification_id LIMIT 20;
```

В Observability фильтруй `event_type=owner_notifications` для проходов Cron,
`event_type=owner_notification_delivery` — для результатов отправки.
В логах только служебные идентификаторы, счётчики и безопасные коды; текста
обращений, токена и полного ответа Telegram там нет. Выключенная функция не
пишет собственное событие каждую минуту. `last_run_at` в D1 относится к последнему
завершённому проходу с захваченной очередью; во время паузы смотри также Cron-логи.

Автоматические traces отключены в конфигурации при сохранении обычных логов:
Telegram передаёт токен в пути API-запроса. Не включай запись исходящих URL в
traces без отдельного удаления токена из таких записей. Редиректы Telegram
не выполняются, сырые сетевые исключения не выводятся.

| Код | Что делать |
| --- | --- |
| `invalid_bot_token` | Проверить формат Secret `TELEGRAM_BOT_TOKEN` |
| `invalid_owner_chat_id` | Указать положительный числовой ID личного чата |
| `invalid_notify_from` | Скопировать дату UTC целиком, включая `Z` |
| `invalid_notification_options` | Проверить режим фрагмента и параметры повторов |
| `notification_configuration_changed` | Сверить `NOTIFY_FROM` и ID с уже закреплёнными в D1 значениями |
| `storage_unavailable` | Проверить binding `CONTACTS`, наличие миграции и доступность D1 |
| `telegram_http_401`, `telegram_http_404` | Проверить действительность токена в BotFather |
| `telegram_http_400`, `telegram_http_403` | Проверить ID, нажать Start у своего бота, снять его блокировку |
| `telegram_rate_limited` | Дождаться сохранённого срока следующей попытки |
| `telegram_server_error`, `telegram_network_error`, `telegram_timeout` | Автоматические повторы; после исчерпания попыток — ручной повтор |
| `telegram_unconfirmed_response`, `delivery_unconfirmed` | Подтверждения нет; сообщение могло уже попасть в Telegram |
| `telegram_redirect_refused` | Получен неожиданный редирект API; проверить интеграцию перед повтором |
| `source_unavailable` | Исходное обращение или наблюдение удалено либо переведено в тестовые |
| `delivery_lease_lost` | Состояние отправки изменилось во время попытки; проверить очередь перед ручным повтором |

`busy_or_backoff` — штатный пропуск: другой обработчик занят либо действует
пауза канала. Постоянная ошибка Telegram завершает текущую строку как `failed`
и приостанавливает канал минимум на час, чтобы не расходовать очередь на
повторение той же ошибки. Сохранение новых контактов продолжается.

## 7. Повтор после исправления и отключение

После исправления токена/чата отключи отправку и дождись завершения текущего
прохода (до двух минут). Повтори **конкретную** ошибочную строку по её ID:

```sql
UPDATE owner_notification_outbox
SET status = 'retry', attempts = 0, next_attempt_at = 0,
    lease_token = NULL, lease_until = 0, last_error_code = NULL
WHERE notification_id = 'mn_REPLACE_WITH_ID' AND status = 'failed';

UPDATE owner_notification_state SET next_send_at = 0
WHERE destination = 'owner' AND lease_until <= unixepoch() * 1000;
```

Включи отправку снова. Если Telegram уже принял предыдущую попытку, повтор
может создать дубль с тем же идентификатором события. Гарантии «ровно один раз»
при потере сетевого подтверждения нет.

Если нужен именно новый личный чат, останови отправку, дождись окончания
прохода, заново определи свой ID, согласованно измени ID в переменной и строке
`owner_notification_state`, затем проведи административный тест. `notify_from` сохраняется, доставленные записи не
очищаются. Изменение адресата — отдельное административное действие; обычная
выкладка его не выполняет.

Для паузы достаточно `TELEGRAM_NOTIFICATIONS_ENABLED=false`. Контакты продолжают
сохраняться. После включения обработчик найдёт накопленное от прежней даты
старта. Не удаляй очередь для её очистки: без записи о доставке старый контакт
снова будет обнаружен. Историческая рассылка до `NOTIFY_FROM` не выполняется
автоматически.

## Технические ограничения пилота

Один проход обнаруживает до 100 новых контактов и пытается отправить до пяти
уведомлений с интервалом не менее 1,1 секунды. Новые проходы продолжают очередь.
Время работы ограничено, захват освобождается после завершения или по сроку.
Две служебные таблицы позволяют сохранить паузу и блокировку между запусками
без отдельного сервера или брокера сообщений.

Функция не подписывается на HTTP-логи, поисковые цели или общую память.
Новые контакты без `submission_id` могут быть независимыми повторными
обращениями; их смысловая дедупликация не выполняется.

Реализация считается включённой после миграции, настройки, deployment и
полученного владельцем теста. Написанный код и успешные локальные проверки
сами по себе не подтверждают production-доставку.

Источники: [Telegram Bot API](https://core.telegram.org/bots/api),
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[Wrangler: сохранение переменных](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth).
