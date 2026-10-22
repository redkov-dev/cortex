# Запуск Shared Task Signal MVP

Цель: сохранить текущий Human Endpoint, shared task signals и добавить отдельный
слой наблюдаемого спроса: валидные вызовы `search_shared_experience` сохраняют
минимальную приватную формулировку задачи в `observed_task_signals`.
Новая база не нужна: используется `magnt-contacts`, binding `CONTACTS`.

## Ручной шаг владельца: создать таблицы

Выполнить **до слияния этой версии в production-ветку `main`**:

1. В Cloudflare открыть **Storage & databases → D1 → magnt-contacts → Console**.
   Названия разделов могут отличаться; нужна SQL-консоль уже существующей базы.
2. Убедиться, что уже применена
   [`0002_task_signals.sql`](../cloudflare/magnt-observer/migrations/0002_task_signals.sql).
3. Скопировать весь SQL из
   [`0003_observed_task_signals.sql`](../cloudflare/magnt-observer/migrations/0003_observed_task_signals.sql)
   и выполнить его. Скрипт создаёт только `observed_task_signals` и её индекс;
   существующие `contacts` и `task_signals` не изменяет. Если консоль принимает
   только один оператор, выполнить `CREATE TABLE` и `CREATE INDEX` по отдельности.
4. Проверить результат:

```sql
SELECT name FROM sqlite_master
WHERE type = 'table'
  AND name IN ('contacts', 'task_signals', 'observed_task_signals')
ORDER BY name;
```

Должны отображаться три таблицы. Пароли, токены и содержание обращений передавать
не нужно; для продолжения достаточно подтверждения успешного выполнения.

Скрипты допускают повторное применение. Ручной запуск не добавляет строку в
служебную таблицу истории Wrangler; при последующем `db:migrate` миграции
безопасно выполнятся ещё раз и будут отмечены штатным механизмом.

## Что именно теперь сохраняется при поиске

Каждый валидный `search_shared_experience` выполняет две независимые операции:

1. читает `task_signals` и ищет ранее **добровольно опубликованный** опыт;
2. best-effort сохраняет приватный `observed_task_signal` с полями `goal`,
   опциональными `blocker`/`tried`, временем и `is_test`.

`observed_task_signals` никогда не участвует в выдаче shared memory. В записи нет
IP, User-Agent, client identity, contact/submission ID, Observer `event_id` или
`search_receipt`. Каждая валидная поисковая попытка считается отдельным наблюдением;
дедупликации и восстановления личности нет. В Observer telemetry допускается лишь
булевый `observed_task_saved`; ID наблюдения и текст задачи туда не попадают.

Если таблица `observed_task_signals` временно недоступна, сам поиск по уже
существующим `task_signals` продолжает работать; telemetry показывает
`observed_task_saved: false`. Это позволяет безопасно откатить/докатить миграцию,
не ломая прежнюю функцию поиска.

## Публикация и проверка

После подтверждения миграции:

1. Слить проверенную рабочую ветку в `main`.
2. Дождаться успешной проверки **Workers Builds: magnt-observer** для нового
   коммита. Проверка GitHub Pages сама по себе не подтверждает деплой Worker.
3. Проверить `/__magnt_probe`: `mcp_door_version = 0.2.0`,
   `shared_memory_version = 0.2.0`, оба storage-флага равны `true`.
   Эти флаги подтверждают наличие binding, а не исправность таблиц.
4. Из `cloudflare/magnt-observer` выполнить:

```sh
npm run smoke -- https://magnt.ru/mcp --shared-memory-test --submit-test
```

Тест проверяет четыре инструмента, профиль, чтение до/после явной записи,
идемпотентность, изоляцию тестовой записи, сохранение тестовой наблюдаемой цели и
прежний канал личных сообщений. Все записи помечены `is_test=true`, запросы —
`MAGNT-Controlled-Test/0.2`. Текст задач в отчёт теста не выводится. Только после
успешного production smoke техническая итерация считается запущенной. Это ещё не
успех внешнего эксперимента.

## Если есть настроенная CLI-авторизация Cloudflare

Вместо ручного SQL можно выполнить из каталога Worker:

```sh
npm run deploy:migrated
```

Команда последовательно выполняет все неприменённые D1 migrations и deploy; при
ошибке миграции деплой не начинается. Для автоматизации можно назначить её Deploy
command существующего Cloudflare Builds после проверки прав его токена на D1.
Простой `npx wrangler deploy` не запускает D1 SQL-миграции. Настройки Cloudflare
Builds этой версией репозитория автоматически не изменяются.

## При ошибке

Если shared tools возвращают `storage_error`, проверить наличие `task_signals`,
binding и успешность миграции 0002. Отсутствие только `observed_task_signals`
не должно ломать поиск: он продолжает отвечать, но новая цель не сохраняется.
Проверить это можно по `observed_task_saved: false` в Observer telemetry.
Старые инструменты продолжают работать независимо.

При необходимости вернуть предыдущую версию Worker и согласованные статические
документы через git revert; новые таблицы и существующие данные не удалять.

`server.json` содержит манифест версии MCP Door. Его изменение не публикует новую
версию в Official MCP Registry; публикация там проверяется отдельно и не является
условием работоспособности существующего адреса MCP.
