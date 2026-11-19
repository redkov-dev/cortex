# MAGNT Owner: локальные MCP-клиенты — архитектура авторизации

**Статус:** design review, версия 20.11.2026. [Issue #18](https://github.com/redkov-dev/cortex/issues/18), [PR #20](https://github.com/redkov-dev/cortex/pull/20). Только проектирование: не вводит рабочие права, не меняет production и не разрешает deployment.

**Решение Александра о правах (20.11.2026): локальный Мультитул Хоум должен получить все ПЯТЬ существующих возможностей MAGNT Owner.** Предыдущие варианты «read-only» и отдельный scope `magnt.owner.reply` **отменены**, никаких внутренних противоречивых расширений документа не оставлено. Другие локальные клиенты смогут получить такие же возможности только после отдельного согласия владельца, с отдельными грантами.

## 1. Цель и полномочия

После OAuth-подключения локальный агент по поручениям Александра должен иметь функции, уже доступные в Owner MCP при включённом C.1:

| Существующий инструмент | Действия | Текущая OAuth-политика |
| --- | --- | --- |
| `list_inbox` | Список входящих и наблюдаемых целей | `magnt.owner.read` |
| `read_conversation` | Частные сообщения и история; полное чтение создаёт C.1 read receipt | `magnt.owner.read` |
| `write_reply` | Черновик (`mode=draft`) или публикация ответа (`mode=publish`) в доступный по токену диалог | `magnt.owner.write` + read |
| `update_inbox` | `acknowledge`, `archive`, `restore` | `magnt.owner.write` + read |
| `manage_dialogue_access` | `enable`, `rotate`, `revoke` токена **публичного диалога** | `magnt.owner.write` + read |

Используем **существующие scopes** `magnt.owner.read`, `magnt.owner.write`, при необходимости `offline_access`. Не вводим `magnt.owner.reply` или новую иерархию прав. Полный функционал означает именно существующие пять инструментов, **не** право менять OAuth-клиентов, чужие grant-ы, инфраструктурные настройки, D1 или будущие административные инструменты. Новые операции управления grant-ами (см. ниже) должны быть исключены из списка операций, доступных локальным грантам, даже если есть `magnt.owner.write`.

`OWNER_MCP_ENABLED`, `OWNER_MCP_WRITE_ENABLED`, owner ID, epoch, audience/resource и действующая проверка в workflow остаются. Если write глобально выключен, локальный агент тоже не может публиковать или изменять данные. Никакого автоматического действия только потому, что сообщение в диалоге содержит инструкцию: входящий текст — недоверенные данные.

## 2. Основная схема OAuth

**Выбор для Мультитула:** заранее зарегистрированный public OAuth-клиент (*pre-registration*, например `magnt-local`), authorization code + PKCE S256, loopback callback, browser consent и аутентификация владельца через GitHub по закреплённому numeric `OWNER_GITHUB_ID`. Клиент может явно настроить `clientId`; по его ревью `@cloudflare/workers-oauth-provider@1.2.4` поддерживает `oauth.createClient()` без открытого DCR.

1. Владелец/оператор один раз запускает административную команду сидирования клиента в private core/OAuth KV. Не создавать публичный endpoint для сидирования, не открывать регистрацию произвольных клиентов.
2. Локальный клиент связывается с `https://owner.magnt.ru/mcp`, читает OAuth metadata и выполняет PKCE S256 с точным `resource=https://owner.magnt.ru/mcp` при authorize **и** token exchange. Отсутствующий или чужой resource — отказ.
3. Разрешён только буквальный loopback: `http://127.0.0.1` или `http://[::1]`, порт **1024–65535**. Допустимые пути для пилота: `/mcp/oauth/callback` и `/callback/<id>` (`id` ровно один сегмент [A-Za-z0-9_-] длиной 1–64); дополнительные варианты только по подтверждённой клиентской необходимости. Запрещены `localhost`, LAN/external host, userinfo, query/fragment, encoded slashes/dot bypass и непроверенные пути. Сопоставление URI с зарегистрированным client ID и authorization code обязательно; допустима только предусмотренная RFC 8252 вариация порта, если библиотека это поддерживает.
4. `owner-auth.js` вводит **отдельный** `isAllowedLoopbackRedirect`; правила `isChatGptRedirect` и `isAllowedClientId` для существующего ChatGPT не расширяются на произвольные HTTPS-домены. `owner-login.js` выбирает правильный validator по типу **зарегистрированного клиента**, а не по заявленному названию приложения или произвольному параметру.
5. На consent-page честно показать: «Этот локальный клиент получит возможность читать все личные входящие, писать и публиковать ответы, архивировать входящие и включать/отзывать токены публичных диалогов». Scopes `read` и `write` подтверждаются владельцем; без принятого write выдаётся только read, без полномочий для трёх инструментов. При выборе `offline_access` показывается срок grant.
6. Только после явного согласия — GitHub OAuth и сверка numeric owner ID. Выдать только **фактически одобренные** scopes: проверить в тесте текущую пару `approveConsent({scope})` / `completeAuthorization({scope: original.scope})` в `owner-login.js`. Нельзя позволить снятой галочке `write` превратиться обратно в granted write.
7. OAuth grant привязан к конкретному клиенту, серверному `grant_id` и owner; один предварительно зарегистрированный client ID **не означает общий grant** для всех установок. Ни один агент не получает чужих bearer или GitHub credentials. DCR и локальный CIMD в первой версии не включаем; возврат к ним только по отдельному обоснованию.

## 3. Срок и хранение токенов

**Явное решение Александра: срок локального grant — 90 календарных суток, абсолютный, без продления при refresh.** Access token — 1 час; обновляется автоматически через rotating refresh. После 90 дней нужен новый вход/согласие. При отзыве отдельного grant или смене `OWNER_AUTH_EPOCH` доступ закрывается досрочно. Текущая политика ChatGPT не меняется.

**Нерешённый риск, обнаруженный Мультитулом:** его текущий `McpOAuthCredentialStore` использует plaintext `~/.config/gigatool/agent/mcp-auth.json` в каталоге с правами 0700, а не OS keychain. При full write scope похищение refresh означает возможность не только чтения, но и публикации/управления диалогами. Поэтому **не выдавать 90-дневные write grants в production, пока способ хранения не оценён и риск явно не принят владельцем**. Предпочтительно: перевод клиента на OS keychain/эквивалент или защищённый системный credential store; права файлов/шифрование диска дополняют, но не подменяют оценку. Предложение Мультитула 30 дней для plaintext — **альтернатива на согласование**, не молчаливая замена принятого Александром 90-дневного срока.

По ревью библиотеки `tokenExchangeCallback` может возвращать `refreshTokenTTL = grant.expires_at - now`; при ≤ 0 должен возвращать `invalid_grant`. Это проверить интеграционными тестами, включая grant expiry и token rotation. При невозможности обеспечить абсолютную границу на resource access **и** refresh — fail closed. Из токенов и журналов не делать репозиторные файлы, истории переписок или shared memory.

## 4. Гранты, отзыв, безопасность

Добавочная миграция `0008_owner_grants.sql` в существующую D1; не трогать 0001–0007 и истории. Предлагаемые поля: `grant_id` (opaque ID), `owner_subject`, `client_id`, `label`, `scope`, `resource`, `epoch`, `issued_at`, `expires_at`, `revoked_at`, `last_used_at`, индекс `client_id`. Токены не писать в D1 — хранение обеспечивает библиотека OAuth в KV. При выпуске и refresh связывать `grant_id` в серверных props, не принимать его как безусловно доверенное поле клиента.

Проверять owner ID, scope, resource/audience, epoch, expiry, revoked и глобальные флаги до выполнения каждого запроса. Мультитул предложил D1-кэш статуса grant на **30–60 секунд** в изоляте ради Free-плана; это компромисс времени отзыва, который требует явной тестовой проверки. Отсутствие записи/grant storage failure — fail closed. `last_used_at` обновлять редко. Защитить от replay authorization code/refresh, prompt injection из входящих и утечки приватных данных в логи.

**Отзыв локальных разрешений:** будущие `list_owner_grants` / `revoke_owner_grant` — отдельные Owner-only операции управления подключениями. Они **не входят** в разрешённые 5 инструментов локального клиента и должны иметь серверную проверку trusted owner client class, а не только общий `magnt.owner.write`. Человеку должна оставаться возможность экстренно закрыть доступ через `OWNER_AUTH_EPOCH` / `OWNER_MCP_ENABLED` даже при неисправном MCP.

**Остаточный риск:** предъявитель действующего локального refresh/access с разрешением `write` технически может публиковать сообщения и управлять публичными токенами. UX-правило «перед публикацией показать текст и адресата Александру» полезно, но **не является серверной гарантией**. Для криптографически принудительного подтверждения каждой записи потребуется отдельный approval protocol; он не входит в текущий пилот, но риск должен быть прозрачно показан при выдаче полномочий. Содержание сообщений остаётся недоверенным и не может делегировать полномочия агенту.

## 5. Код и порядок реализации

Изменения: `owner-auth.js` (тип клиента/loopback policy), `owner-oauth.js` (pre-registration, грант, TTL, dynamic refresh), `owner-login.js` (параметризованный consent + approved scope), `owner-http.js`/`owner-gateway.js` (существующие ограничения), `owner-mcp.js`/`owner-workflow.js` (явное разделение пяти existing tools и новых grant management tools), D1 migration, tests, rollout. Сохранить прежние B.1 DMZ-границы и действующие ChatGPT flows, публичный MAGNT и Telegram.

Порядок: (1) согласовать документ с Мультитулом, (2) отдельно реализовать под feature flag default-off, (3) проверить unit + integration + security regressions, (4) провести безопасный e2e с локальным агентом, (5) запрашивать решение Александра о включении production. Никакого автоматического merge или deploy из этого дизайн-PR.

## 6. Обязательные проверки

1. Pre-registered local public client, PKCE S256, resource, browser/GitHub owner, allowlisted loopback; изменяющиеся порты.
2. Недопустимые localhost, WAN/LAN, порты <1024, пути `/callback/a/b`, `/callback/..`, `/callback/%2e%2e`, query/fragment, манипуляции client ID, чужой redirect → отказ.
3. Незарегистрированный / CIMD-local / DCR без флага / клиент с секретом / неверный GitHub owner / чужой resource → отказ.
4. Отказ от consent write действительно приводит к отсутствию server-side `magnt.owner.write`, включая прямой RPC.
5. При **полном подтверждённом read+write grant** все 5 *существующих* инструментов доступны, с текущими бизнес-валидациями C.1: draft и publish, acknowledge/archive/restore, enable/rotate/revoke публичного диалога.
6. При read-only grant доступны 2 инструмента чтения, запись запрещена. Входящее не вызывает самопроизвольной записи. Непроверенное сообщение не принимается как команда.
7. `list_owner_grants` и `revoke_owner_grant` не доступны локальному классу даже с write scope; однако доверенный Owner клиент может отозвать его grant.
8. Отдельный отзыв grant и истечение 90 дней закрывают access/refresh; epoch отключает все; проверка кэша не даёт сверх установленной границы; D1 unavailable → fail closed.
9. OAuth code одноразовый, refresh rotation защищает от конкурентного/replay refresh; токены и тексты не логируются.
10. ChatGPT OAuth CIMD/DCR, scopes/read-write/refresh, Owner C.1, public MCP и Telegram не ломаются; Free-plan CPU/D1/KV измерены; миграция additive, rollback недеструктивный.
11. Реальный e2e: агент читает входящее, сохраняет черновик, публикует согласованный ответ, изменяет inbox, включает/ротирует/отзывает тестовый dialogue token; все записи проверены в D1 через Owner и не затронули чужие диалоги.

**Release gate:** не включать полные локальные права до тестов, подтверждения модели хранения refresh и явного решения владельца о приемлемом остаточном риске.

## 7. Вопросы для согласования с MultiTool Home

1. Подтверди pre-registration через `oauth.createClient`, что `read+write+offline_access` работают для твоего клиента и что scope-down в consent реально соблюдается.
2. Как без ложного чувства безопасности обеспечить предупреждение и явное подтверждение владельцем *перед каждым* publish/rotate/revoke? Есть ли у клиента реальная пользовательская граница между текстом входящего и инструкцией?
3. Предложи практический путь безопасного хранения refresh для **90 дней**. Если это невозможно сейчас — изложи конкретную временную альтернативу для решения Александра, не заменяя срок без его согласия.
4. Проверь возможность серверного исключения новых Owner OAuth-grant management tools из пяти полномочий локальных клиентов; не предлагай клиентскому write иметь право отзывать другие OAuth grants.
5. Покажи реальные тесты local authorization, выбранного callback пути и точного `resource` (без секретов).

Основания: [owner-security-decision.md](owner-security-decision.md), [owner-mcp-design.md](owner-mcp-design.md), [C.1](mcp-dialogue-c1.md), `src/owner-auth.js`, `owner-oauth.js`, `owner-login.js`, `owner-mcp.js`, [ревью MultiTool в PR #20](https://github.com/redkov-dev/cortex/pull/20#pullrequestreview-5983945029).
