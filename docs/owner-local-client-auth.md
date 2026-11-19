# MAGNT Owner: локальные MCP-клиенты — проект решения для совместного ревью

Статус: **proposal / design review**, 20.11.2026. Связано с [Issue #18](https://github.com/redkov-dev/cortex/issues/18). Этот PR **только документирует** решение: флаги, схема БД и код не меняются. Адресат ревью — MultiTool Home (автор issue подписался «MultiTool»; тождество требует подтверждения).

## 1. Цель и границы

Александр должен иметь возможность из локального MCP-клиента читать частные обращения через `list_inbox` и `read_conversation` без копирования bearer-токена из ChatGPT. Целевая модель — несколько независимых экземпляров ИИ-клиентов, у каждого своё явно выданное, ограниченное и отзывное разрешение **действовать от имени владельца**, а не становиться владельцем.

Не делаем: публичную регистрацию людей, аутентификацию ИИ по самоназванию, общий секрет для всех агентов, передачу GitHub-токена в агент, автономные записи в Owner, изменение публичных `propose_contact` / `get_dialogue`, новый внешний сервис и платную инфраструктуру.

Существующие границы B.1 остаются: `magnt-owner-gateway` → Service Binding `OwnerApi` → закрытый `magnt-core`; D1/OAuth KV и GitHub secret — только в ядре; числовой GitHub owner ID, `OWNER_AUTH_EPOCH`, точный `resource=https://owner.magnt.ru/mcp`, разделение read/write scopes и общий флаг записи — обязательны. `OWNER_MCP_ENABLED=false` по-прежнему закрывает все Owner-вызовы.

## 2. Выбор протокола

**Решение: OAuth Authorization Code + PKCE S256 + loopback redirect; read-only в первой версии.** Без персональных токенов (PAT) на старте. Доступ выдаёт человек в браузере после проверки своего GitHub ID, а клиент сохраняет собственные OAuth credentials и refresh-токен в локальном защищённом хранилище, не передавая их между агентами.

MCP 2026-07-28 предпочитает pre-registration или Client ID Metadata Documents (CIMD); DCR оставлен как fallback. Для реального локального клиента сначала проверяем: (1) умеет ли он принять явный client_id, (2) умеет ли CIMD с размещённым HTTPS metadata, (3) умеет ли DCR. **Практическая реализация для первого несовместимого с первыми двумя клиента — узко ограниченный DCR только для loopback.** Не включаем общий DCR для произвольных клиентов. Если локальный клиент уже поддерживает статически выданный client_id, используем предварительную регистрацию вместо DCR, с той же политикой grant/revoke.

Никаких привилегий из поля `client_name` / `agent_identity`; это только непроверенные отображаемые подписи. Авторизация выдаётся **человеку** и привязывается к конкретному зарегистрированному OAuth-клиенту/гранту.

## 3. Протокол и политика

1. Локальный клиент настраивает `https://owner.magnt.ru/mcp`. Сервер возвращает 401 + Protected Resource Metadata; клиент обнаруживает issuer и начинает OAuth. В запросах на авторизацию и обмен токена `resource` должен точно совпадать с Owner MCP (RFC 8707). Нет resource → отказ с явной безопасной ошибкой, не fallback.
2. Для локального клиента разрешён `http://127.0.0.1:<port>/mcp/oauth/callback`; `[::1]` добавляем, только если реальный клиент использует IPv6. Допустимый числовой порт 1–65535, чтобы не нарушать RFC 8252 (произвольный порт loopback); порт может различаться между запусками, остальные части URI сравниваются точно. Не разрешать `localhost`, другие IP, userinfo, query, fragment, percent-encoding обходы, пути с `..`/encoded separators, дополнительные callback-пути без отдельного ревью. Регистрация, /authorize и /oauth/token должны использовать одну нормализацию и проверку URI с обязательной привязкой к client_id. Не путать проверку «адрес loopback» с доказательством идентичности приложения.
3. DCR принимает только public native client с `token_endpoint_auth_method=none`, `grant_types=[authorization_code,refresh_token]`, `response_types=[code]`, 1–2 разрешённых loopback redirect, лимитом длины/полей, `application_type=native` при наличии. При регистрации клиент не получает Owner scope и не становится доверенным. Регистрируемого клиента допускает только отдельный `OWNER_LOCAL_DCR_ENABLED=true`, по умолчанию false; существующий `OWNER_DCR_ENABLED` для ChatGPT не расширять. Существующие OAuth rate limits дополнить бюджетом DCR/ограничением количества регистраций: не допускать исчерпания KV бесплатного тарифа.
4. `/authorize`: проверить, что client_id реально признан OAuth-библиотекой, зарегистрированный redirect соответствует авторизационному (кроме допустимой вариации порта), PKCE `S256`, `state`, точный `resource`, scopes — только `magnt.owner.read` и опционально `offline_access`. `magnt.owner.write` для локального класса **отклоняется и при запросе, и при выдаче**; отдельное разрешение записи потребует нового design review. В интерфейсе показать правдивое имя/тип клиента и прямое предупреждение: «доступ ко всем частным входящим MAGNT; открытие полного сообщения отмечает его прочитанным». Владелец может отказаться.
5. Только после согласия — существующий GitHub OAuth upstream и проверка `OWNER_GITHUB_ID`. Новый owner не регистрируется. `completeAuthorization` выдаёт только **одобренные** scopes; обязательно протестировать снятие галочек `write` и `offline_access` для ChatGPT: сейчас `owner-login.js` передаёт `scope: original.scope`; нужно проверить, не теряется ли выбор из формы.
6. Access token — 1 час. По умолчанию первый локальный grant получает read + offline_access с refresh до **7 суток абсолютного срока**, после чего новое согласие; если клиент не поддерживает безопасное хранение refresh, выдавать read-only access без refresh, с повторной авторизацией. Если версия pinned OAuth-библиотеки не обеспечивает такой per-client TTL, **не выпускать refresh** до успешных тестов/реализации. ChatGPT: существующая политика 30 дней без изменений.
7. При каждом Owner MCP вызове и обновлении токена проверять owner ID, `OWNER_AUTH_EPOCH`, scope, audience/resource, неотозванный grant и срок его действия. Для write-методов остаётся действующая серверная проверка `OWNER_MCP_WRITE_ENABLED`. Любой отказ grant storage — fail closed; ошибки наружу без секретов. MCP SDK должен получать только установленный после проверки `actor`, не client-supplied идентичность.
8. Локальные токены и состояние OAuth хранить в OS keychain/эквиваленте, не в GitHub, чате, markdown, shared memory, общих конфигах или логах. Если сам клиент не умеет защищённо хранить refresh, пилот только с коротким access и без refresh. Вредоносное ПО на устройстве остаётся неустранимым этой схемой риском.

## 4. Гранты и отзыв

Потребуется *additive* миграция `0008_owner_grants.sql` в существующую D1 (сначала сохранить backup). Концептуальная таблица `owner_grants`: `grant_id` (случайный opaque ID, PK), `owner_subject`, `client_id`, `label` (текст только для UI), `scope`, `resource`, `epoch`, `issued_at`, `expires_at`, `revoked_at`, `last_used_at`. **Не хранить access/refresh токены**, PKCE verifier или коды. Использовать native OAuth KV для токенов; `grant_id` как привязку в `props`, которую ядро сверяет с D1 при resource access и refresh. Создание grant перед выпуском code допускает неактивированные orphan-записи, которые безопасно чистятся по TTL; никогда не выпускать действующий токен без проверяемого grant.

Предусмотреть два Owner-only метода: `list_owner_grants` (только безопасные метаданные, без секретов) и `revoke_owner_grant` (по ID, явное указание Александра, `magnt.owner.write`, идемпотентная операция). Не переиспользовать `manage_dialogue_access`, который управляет **публичным** диалогом, а не полномочиями Owner. Экстренный механизм остаётся `OWNER_AUTH_EPOCH` / `OWNER_MCP_ENABLED`; **всегда** сохраняем возможность глобального отключения без доступного OAuth UI. `last_used_at` записывать с троттлингом, не на каждый MCP запрос, ради бесплатного D1.

Вариант без per-grant проверки не годится для длительного refresh: глобальный epoch отзовёт одновременно ChatGPT и все локальные инстансы.

## 5. Места изменений

- `owner-auth.js`: отдельная функция `isAllowedLoopbackRedirect`, класс локальных клиентов и scope policy; действующие правила ChatGPT не менять.
- `owner-oauth.js`: gated регистрация локального клиента; проверка scope/resource/token exchange/refresh по `grant_id`; metadata discovery; сохранение политики текущих ChatGPT-клиентов.
- `owner-login.js`: /authorize, /callback и consent с локальным loopback; не менять pinned GitHub identity; проверить действительное уменьшение scopes при снятии галочек; CSP/Origin для локального возврата только по проверенному URI.
- `owner-http.js`, `owner-gateway.js`: использовать прежние path/body/rate limits; не вводить открытый proxy и новые публичные пути, кроме строго необходимых для управления grant через Owner MCP.
- `owner-mcp.js` и Owner workflow: management endpoints только для владельца; проверку grant делать до вызова domain tools. Изменение `ownerActor` на async/другой безопасный адаптер при необходимости для D1.
- Тесты, миграция, отдельная инструкция выпуска с флагами default-off, локальная проверка браузерного loopback, реальный end-to-end и план rollback. Публичный MAGNT и Telegram не изменять.

## 6. Критерии готовности / тесты

1. Локальный клиент соединяется через browser → GitHub owner → loopback → code exchange → `list_inbox`, без передачи ручного токена; после рестарта соединение работает в пределах срока grant.
2. Неверный GitHub ID, истёкший/поддельный state, недействительный PKCE → отказ.
3. 127.0.0.1 и допустимый меняющийся порт работают; `localhost`, адрес LAN, внешний host, чужой path, query/fragment, encoded bypass → отказ.
4. Нельзя подменить зарегистрированный redirect через новый порт/путь в другом client_id; обмен code требует тот же client/resource.
5. Без явного `resource`, с public MAGNT resource или чужим audience → отказ.
6. Local client не получает `magnt.owner.write` ни через запрос, ни через consent, ни через refresh, ни через прямой tool call.
7. Отказ от `offline_access` действительно не выдаёт refresh; снятие `write` в обычном ChatGPT consent действительно уменьшает выданные scopes.
8. `revoke_owner_grant` отказывает resource access и refresh именно этому клиенту, сохраняя ChatGPT; epoch инвалидирует всё.
9. Хранилище грантов недоступно → отказ, без выдачи приватного inbox; журнал не содержит credentials, URL query, содержимое сообщений.
10. Чтение `list_inbox` не помечает сообщения прочитанными; `read_conversation` сохраняет существующую семантику read receipts.
11. Обычное ChatGPT-подключение (CIMD, OAuth refresh, read/write) продолжает работать с прежними URL и правилами.
12. DCR закрыт до явного включения; регистрационный флуд ограничен; нагрузка и D1/KV/CPU проверены на бесплатном плане; rollback не удаляет историю.

**Release gate:** без зелёных unit/integration/regression tests, отрицательных security-тестов и реального теста с клиентом MultiTool Home никаких флагов в production не включать. PR с кодом — отдельный; этот документ не разрешает выкладку.

## 7. Вопросы Мультитулу Хоум

1. У твоего локального клиента есть настройка заранее выданного `client_id`? Поддерживается ли собственный HTTPS CIMD? Или **обязательно** DCR?
2. Подтверди точный callback (сейчас заявлен `http://127.0.0.1:19876/mcp/oauth/callback`), может ли порт меняться и способен ли клиент автоматически открыть системный браузер.
3. Подаёт ли клиент `resource` при authorization и token exchange и использует ли PKCE S256? Есть ли у него реальные логи этих этапов **без токенов и кодов**?
4. Где он хранит refresh credentials: OS keychain или обычный plaintext config? Возможен ли безопасный режим без refresh?
5. Достаточно ли начального scope **read-only** на 7 дней с отдельным отзывом? Какие предположения этого дизайна неверны для твоего harness?

Ожидаемый результат ревью: конкретные совместимые URI/клиентский flow, список возражений с источниками в коде, согласованная реализация и тестовый план. **Не нужно реализовывать решение до обмена ревью и согласования owner.**

### Основания

Текущее устройство MAGNT: [owner-security-decision.md](owner-security-decision.md), [owner-mcp-design.md](owner-mcp-design.md), `src/owner-auth.js`, `src/owner-oauth.js`, `src/owner-login.js`; [Issue #18](https://github.com/redkov-dev/cortex/issues/18). Внешние стандарты: [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252), [MCP client registration 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration), [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707).
