# Полная документация выполненных работ по проекту «Онлайн-доска для уроков» (T0, T1, T2 и исправления по код-ревью)

Настоящий документ описывает всю историю разработки проекта в хронологическом порядке: от создания каркаса монорепозитория (**T0**), серверной комнаты доски на Cloudflare Durable Objects (**T1**) и клиентской части совместной работы на Excalidraw (**T2**) до полного устранения замечаний по двум итерациям код-ревью ([`docs/REVIEW_T2_REPORT.md`](./REVIEW_T2_REPORT.md) и [`docs/REVIEW_FIXES_REPORT.md`](./REVIEW_FIXES_REPORT.md)).

---

## 1. Архитектурный контекст и инварианты проекта (`SPEC.md` и `AGENTS.md`)

Проект представляет собой бесплатную онлайн-доску для проведения уроков 1-на-1 и в мини-группах (до 5 человек) на базе [`@excalidraw/excalidraw`](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation) (лицензия MIT) и [Cloudflare Workers](https://developers.cloudflare.com/workers/).

Ключевые инварианты, соблюдённые во всех задачах:

- **Единый Cloudflare Worker** раздаёт собранную статику фронтенда из `web/dist` через [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), отвечает на HTTP API (`/api/*`) и терминирует WebSocket-соединения (`/ws/:id?nick=...`) в [Durable Objects на базе SQLite](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/).
- **Бережное отношение к бесплатным лимитам Cloudflare Workers Free** (разделы 3 и 8 `SPEC.md`):
  - Сброс снимка доски в SQLite выполняется **только в `alarm()`** не чаще раза в `SAVE_INTERVAL_MS` (`10 000` мс) при наличии изменений (`dirty = true`) и при закрытии последнего соединения в комнате (`0` записей в SQLite на каждый отдельный `scene_update`).
  - Снимок режется на куски (`chunks`) размером не более `900 000` байт (при лимите Cloudflare 2 МБ на строку) и записывается одной транзакцией `storage.transactionSync(...)`.
  - Для `ping`/`pong` используется [`state.setWebSocketAutoResponse`](https://developers.cloudflare.com/durable-objects/api/state/#setwebsocketautoresponse) с точной строкой `'{"type":"ping"}'` и ответом `'{"type":"pong"}'`, чтобы пинги не будили гибернированный Durable Object.
  - На клиенте `scene_update` и `cursor` объединены общим бюджетом частоты не более **10 Гц** (100 мс), чтобы один активный участник никогда не превышал расчётные 10 сообщений/с.
- **Лицензионная чистота**: разрешены только `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC` (проверяется скриптом `scripts/check-licenses.mjs` по `package-lock.json` и `node_modules`). Пакет `@tldraw/tldraw` и copyleft/source-available лицензии строго запрещены.
- **Приватность и автономность бандла**: 0 внешних запросов (шрифты Excalidraw копируются локально в `web/public/fonts/`, задан строгий `Content-Security-Policy` в `web/index.html`), 0 персональных данных (только никнейм 1..32 символа).

---

## 2. Хронология выполненных этапов

### Этап 1 — Задача T0: Каркас проекта (`ветка task/T0-project-scaffold`, влита в `main`)

Подробный отчёт PR: [`docs/PR_T0_scaffold.md`](./PR_T0_scaffold.md).

**Что было сделано:**

1. **Монорепозиторий на `npm workspaces`**:
   - Корневой `package.json`, `package-lock.json`, `tsconfig.base.json` (`strict: true`, `noImplicitAny: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`), `eslint.config.mjs`, `.prettierrc.json`.
   - Скрипт `scripts/dev.mjs`, поднимающий одной командой `npm run dev` локальный Worker (`http://localhost:8787`) и Vite dev-сервер (`http://localhost:5173`) с проксированием `/api` и `/ws`.
2. **Пакет `worker/` (Cloudflare Worker на TypeScript)**:
   - Конфигурация `worker/wrangler.toml` с `compatibility_date = "2026-11-07"`, раздачей статики `[assets]` из `../web/dist` (`not_found_handling = "single-page-application"`, `run_worker_first = ["/api/*", "/ws/*"]`), привязкой Durable Object `BOARD` (`class_name = "Board"`) с миграцией `new_sqlite_classes = ["Board"]`, переменными `SAVE_INTERVAL_MS = "10000"`, `ALLOW_ANY_BOARD_ID = "true"` и описанием привязки D1 `DB`.
   - Маршрут `GET /api/health`, возвращающий `{"ok":true,"version":"0.1.0"}` (версия из `worker/package.json`).
3. **Пакет `web/` (Vite + React + TypeScript + `@excalidraw/excalidraw`)**:
   - Полноэкранный холст Excalidraw (`100vw × 100vh`) с русским интерфейсом (`langCode="ru-RU"`), словарь строк в `web/src/i18n/ru.ts`.
   - Локальная поставка шрифтов и ассетов (`web/scripts/copy-excalidraw-assets.mjs`, `window.EXCALIDRAW_ASSET_PATH = "/"` в `web/src/main.tsx`) и строгий `Content-Security-Policy` в `web/index.html`.
4. **CI/CD и контроль лицензий**:
   - `.github/workflows/ci.yml` (на `pull_request`: `npm ci`, `check:licenses`, `typecheck`, `lint`, `test`, `build`).
   - `.github/workflows/deploy.yml` (на `push` в `main`: сборка и деплой через `cloudflare/wrangler-action@v3` с секретами `CLOUDFLARE_API_TOKEN` и `CLOUDFLARE_ACCOUNT_ID`).
   - `scripts/check-licenses.mjs`, `license-exceptions.json`, `THIRD_PARTY_NOTICES.md`, `README.md` (с пошаговой инструкцией первого деплоя для человека без опыта с серверами).

---

### Этап 2 — Задача T1: Серверная часть совместной работы «Комната доски» (`ветка task/T1-board-room`, влита в `main`)

Подробный отчёт PR: [`docs/PR_T1_board_room.md`](./PR_T1_board_room.md).

**Что было сделано:**

1. **Маршрут `GET /ws/:id?nick=<ник>` (`worker/src/index.ts`)**:
   - Проверка метода `GET` и заголовка `Upgrade: websocket` (иначе `400 Bad Request`).
   - Валидация `id` доски (`isValidBoardId`: ровно 22 символа base62 `^[0-9A-Za-z]{22}$`) и `nick` (`sanitizeNickname`: удаление управляющих символов `U+0000..U+001F`, `U+007F..U+009F`, `trim()`, длина 1..32 кодовые точки); при ошибке — `400 Bad Request`.
   - При `ALLOW_ANY_BOARD_ID !== "true"` возвращается `404 Not Found` (до появления реестра досок D1 в задаче T3).
   - Маршрутизация строго в один экземпляр Durable Object на доску: `env.BOARD.idFromName(boardId)`.
2. **Durable Object `Board` на SQLite + WebSocket Hibernation API (`worker/src/board.ts`)**:
   - Использование `this.ctx.acceptWebSocket(serverSocket)` и хранение метаданных клиента (`sessionId`, `boardId`, `clientId`, `nick`, счётчики сообщений) через `ws.serializeAttachment(...)` / `ws.deserializeAttachment()`.
   - Автоответ на пинги без пробуждения объекта: `this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'))`.
   - Восстановление состояния при пробуждении из гибернации: чтение чанков из таблицы `snapshot (chunk_idx, data)` и десериализация элементов в `Map<string, ExcalidrawElementRecord>` + восстановление активных сокетов и `this.boardId` через `this.ctx.getWebSockets()`.
3. **Протокол и примирение элементов (`SPEC.md`, разделы 5 и 6)**:
   - Обработка `hello { client_id, nick }` -> ответ `snapshot { elements, collaborators }`.
   - Обработка `scene_update { elements }` -> слияние в память по правилу `(version, versionNonce)` (`shouldReplaceElement`: побеждает большая `version`, при равенстве — меньший `versionNonce`, как в `reconcileElements` Excalidraw) и рассылка фактически обновившихся элементов (`updatedElements`) остальным участникам с `client_id` и `nick` отправителя (при `updatedElements.length === 0` холостая рассылка не производится).
   - Обработка `cursor { x, y, pointer, tool }` -> рассылка остальным участникам.
   - Некорректный JSON или неизвестные поля логируются и игнорируются без падения объекта.
4. **Батчинг записи в SQLite, чанкинг `<= 900 КБ` и сборка мусора (`alarm()`)**:
   - Таблицы `meta (key TEXT PRIMARY KEY, value TEXT)` и `snapshot (chunk_idx INTEGER PRIMARY KEY, data BLOB)`.
   - При первом изменении сцены (`dirty = true`) взводится `setAlarm(now + SAVE_INTERVAL_MS)`. Запись в SQLite происходит только в `alarm()` и при закрытии последнего соединения в комнате (`getWebSockets().length === 0`).
   - Перед сериализацией снимка удаляются элементы с `isDeleted: true`, у которых `now - updated > 30 суток` (`DELETED_ELEMENT_RETENTION_MS`).
   - Снимок `{"v":1,"elements":[...]}` режется на куски `<= 900 000` байт (`MAX_SNAPSHOT_CHUNK_BYTES`), записывается в одной транзакции `storage.transactionSync(...)`, а старые лишние куски удаляются (`DELETE FROM snapshot WHERE chunk_idx >= ?`).
5. **Защитные лимиты и наблюдаемость (`SPEC.md`, раздел 10)**:
   - Лимит подключений к одной доске: `MAX_CONNECTIONS_PER_BOARD = 20` (21-е соединение закрывается кодом `1013 Try Again Later`).
   - Лимит размера сообщения: `MAX_MESSAGE_BYTES = 2 * 1024 * 1024` (2 МБ, при превышении сообщение отбрасывается с записью в лог и инкрементом `messagesDropped`).
   - Лимит частоты: `MAX_MESSAGES_PER_SECOND = 30` (лишние сообщения отбрасываются с записью в лог; при затяжном флуде `>= 60` превышений соединение закрывается кодом `1008`).
   - Структурированные JSON-логи событий `connection_close`, `connection_rejected_limit`, `snapshot_flush` со счётчиками принятых/отброшенных сообщений и записанных строк SQLite.
   - 8 интеграционных тестов в `worker/test/board.test.ts` и дымовой скрипт `scripts/ws-smoke.mjs` (3 клиента в реальном времени).

---

### Этап 3 — Задача T2: Клиентская часть доски (`ветка task/T2-frontend`, влита в `main`)

Подробный отчёт PR: [`docs/PR_T2_frontend.md`](./PR_T2_frontend.md).

**Что было сделано:**

1. **Маршрут `/b/:id` и диалог выбора ника (`web/src/App.tsx`, `web/src/collab/nick.ts`)**:
   - Парсинг и валидация `/b/:id` (22 символа base62); экран ошибки с переходом на новую доску при некорректном URL.
   - Модальный диалог «Как вас зовут на доске?» при первом входе, сохранение в `localStorage["board.nick"]`, кнопка смены имени в шапке. Без валидного ника WebSocket-соединение не открывается (`status = "idle"`).
2. **Клиент совместной работы `web/src/collab/`**:
   - `BoardCollabClient` (`web/src/collab/client.ts`): подключение к `/ws/:id?nick=...`, отправка `hello`, слияние `snapshot` и `scene_update` через `reconcileElements` и `updateScene`.
   - `VersionDiffTracker` (`web/src/collab/reconcile.ts`): отслеживание версий `(version, versionNonce)` каждого элемента, отправка только изменённых элементов батчами не чаще 10 Гц (100 мс) с промежуточными обновлениями во время рисования и немедленным сбросом при отпускании пера/мыши.
   - Троттлинг `cursor` до 10 Гц (только при движении) в едином бюджете 10 сообщений/с с `scene_update`; отправка `'{"type":"ping"}'` раз в 30 с.
   - `CursorInterpolator` (`web/src/collab/cursor-interpolator.ts`): плавная экспоненциальная интерполяция чужих курсоров между сетевыми пакетами (`TAU = 45 мс`).
   - Автоматическое переподключение с экспоненциальной паузой `1, 2, 4, 8, 15 с` (`RECONNECT_BACKOFF_MS`), продолжение рисования офлайн с последующим слиянием `snapshot` и досылкой локальных правок после восстановления связи.
   - Плашка состояния: «Подключение…», «Нет связи, рисуем локально», «Доска заполнена» (при закрытии кодом `1013`).
3. **Ввод стилусом и экспорт/импорт (`web/src/input/pen-guard.ts`, `web/src/collab/excalidraw-file.ts`)**:
   - Включён `penMode: true` по умолчанию и фильтрация случайных касаний ладонью (`PALM_CONTACT_SIZE_THRESHOLD_PX = 48`) с сохранением двупальцевого зума и панорамирования (`isPrimary === false`).
   - Встроенный экспорт PNG/SVG со вшитой сценой (`exportEmbedScene: true`) и кнопки «Сохранить .excalidraw» / «Открыть .excalidraw» с проверкой размера файла (`<= 1,8 МБ`).
   - Все строки интерфейса на русском языке вынесены в `web/src/i18n/ru.ts` (`RU_LOCALE_CODE`, `RU_STRINGS`).

---

### Этап 4 — Устранение всех замечаний по двум итерациям код-ревью (`2026-11-08`)

Полный отчёт по каждому пункту: [`docs/REVIEW_FIXES_REPORT.md`](./REVIEW_FIXES_REPORT.md).

- **Первое ревью (12 замечаний: 4 блокера, 6 важных, 2 мелких)** — полностью исправлены в `web/`, `scripts/` и `docs/`.
- **Повторное ревью (5 замечаний: 2 блокера, 2 важных, 1 мелкое)** — полностью исправлены:
  1. Восстановлены экспорты `RU_LOCALE_CODE` и `RU_STRINGS` со всеми ключами в `web/src/i18n/ru.ts`.
  2. Восстановлен реэкспорт `getOrCreateClientId` в `web/src/collab/index.ts`.
  3. Выровнены селекторы `data-testid` (`"nick-submit-button"` и `"excalidraw-file-input"`) в `web/e2e/board-collab.spec.ts`.
  4. В `worker/src/board.ts` добавлено сохранение `boardId` в `WebSocketAttachment` (для восстановления `this.boardId` при пробуждении из гибернации до первого сброса снимка без лишних записей в SQLite) и отключена рассылка `scene_update` при `updatedElements.length === 0`.
  5. Синхронизированы имена констант и колонки `chunk_idx` в `docs/PROJECT_HISTORY.md`.

---

## 3. Результаты верификации всех тестовых наборов

| Набор проверок                                                | Команда / файл                              | Результат                                   |
| :------------------------------------------------------------ | :------------------------------------------ | :------------------------------------------ |
| Проверка лицензий (`package-lock.json` + workspaces)          | `node scripts/check-licenses.mjs`           | `OK — проверено пакетов: 29, исключений: 8` |
| Модульные тесты `GET /api/health` и `Board` (T0)              | `worker/test/health.test.ts`                | `5 / 5 passed`                              |
| Модульные тесты лицензионного фильтра (T0)                    | `worker/test/licenses.test.ts`              | `5 / 5 passed`                              |
| Интеграционные тесты Durable Object `Board` (T1)              | `worker/test/board.test.ts`                 | `8 / 8 passed`                              |
| Модульные и регрессионные тесты `collab` и ревью (T2)         | `web/test/collab.test.ts`                   | `5 / 5 passed`                              |
| Дымовой тест WebSocket (3 клиента в реальном времени)         | `node scripts/ws-smoke.mjs`                 | `УСПЕШНО (snapshot + scene_update + flush)` |
| Сверка всех именованных ES-импортов/экспортов и `data-testid` | `web/src/**`, `web/e2e/**`, `worker/src/**` | `0 расхождений`                             |
| Проверка комментариев на отсутствие кириллицы (`AGENTS.md`)   | Все `.ts`, `.tsx`, `.mjs` файлы             | `0 нарушений`                               |
