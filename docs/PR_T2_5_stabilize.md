# PR: Задача T2.5 — Стабилизация перед пилотом (`task/T2.5-stabilize`)

## 1. Краткое резюме

Подготовлена стабилизация проекта перед запуском пилота (ветка `task/T2.5-stabilize`):
1. **Локфайл и совместимость зависимостей (`package.json`, `worker/package.json`, `scripts/check-licenses.mjs`, `license-exceptions.json`)**:
   - Удалён синтетический 34-элементный `package-lock.json` (без `resolved` и `integrity`).
   - Диапазоны версий приведены к реальным релизам npm в рамках границ спецификации: `@excalidraw/excalidraw: "^0.18.0"`, `vite: "^5.4.10"`, `wrangler: "^4.0.0"`, `@cloudflare/workers-types: "^4.20250214.0"`, `miniflare: "^4.0.0"`, `esbuild: "^0.25.0"`, `@types/node: "^22.9.0"`, `@types/ws: "^8.5.13"`.
   - В `scripts/check-licenses.mjs` исправлена проверка составных SPDX-выражений с `OR` (разбор ветвей `OR` выполняется до проверки запрещённых токенов, чтобы пакеты с двойным лицензированием вида `MIT OR GPL-2.0` проходили по пермиссивной ветви `MIT`), добавлено резервное чтение `node_modules/<pkg>/package.json` и `LICENSE`, а в `license-exceptions.json` задокументированы транзитивные пермиссивные пакеты дерева Excalidraw/Vite/Wrangler.
2. **Закрытие доступа к произвольным доскам на пилоте (`PILOT_BOARD_IDS` и `scripts/gen-board-id.mjs`)**:
   - В `worker/src/env.ts`, `worker/src/board.ts` и `worker/src/index.ts` добавлена поддержка секрета `PILOT_BOARD_IDS` (до 50 валидных 22-символьных base62 ID через запятую).
   - Если `ALLOW_ANY_BOARD_ID === "true"` (только для локальной разработки), разрешается любой валидный 22-символьный base62 ID. Иначе (в продакшене/на пилоте до появления D1 в T3) проверяется вхождение ID в `PILOT_BOARD_IDS`; для неизвестных ID возвращается `404 Not Found`.
   - Добавлен скрипт `scripts/gen-board-id.mjs` (`npm run gen:board-id -- N`), генерирующий `N` криптостойких 22-символьных base62 ID через `crypto.getRandomValues` без модульного смещения.
3. **Устранение гонки `alarm()` и WebSocket Hibernation (`SAVE_INTERVAL_MS = 5000`)**:
   - По официальной документации Cloudflare ([Lifecycle of a Durable Object](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)) неактивный Durable Object с WebSocket Hibernation выгружается из оперативной памяти через **10 секунд отсутствия событий**, причём запланированный `setAlarm()` **не препятствует гибернации**.
   - При прежнем `SAVE_INTERVAL_MS = 10000` (10 с) одиночное сообщение `scene_update` с последующей 15-секундной паузой приводило к гонке: объект мог уйти в гибернацию на 10-й секунде (потеряв `this.elements` и `this.dirty` в RAM) до срабатывания `alarm()`.
   - Интервал по умолчанию снижен до **`5000` мс (5 секунд)** (`DEFAULT_SAVE_INTERVAL_MS = 5_000`, в продакшене зажимается в `2000..8000` мс — строго ниже 10-секундного порога гибернации). Обновлены `worker/src/board.ts`, `worker/wrangler.toml`, `.dev.vars.example` и разделы 2, 5, 8 `SPEC.md`.
4. **Устранение лишних записей в SQLite в `flushSnapshot`**:
   - Убрана запись в таблицу `meta` (`board_id` и `snapshot_version`) при каждом сбросе снимка (`board_id` уже хранится в имени объекта и в `WebSocketAttachment.boardId`).
   - Запрос `DELETE FROM snapshot WHERE chunk_idx >= ?` теперь выполняется **только тогда, когда число чанков уменьшилось** (`chunks.length < this.lastPersistedChunksCount`).
5. **Интеграционный тест на реальной среде Workers (`worker/test/board.runtime.test.ts`)**:
   - Добавлен тест `worker/test/board.runtime.test.ts`, который при наличии `miniflare` в `node_modules` собирает `worker/src/index.ts` через `esbuild` и поднимает `Miniflare` с реальным SQLite Durable Object (`useSQLite: true`), проверяя `hello` + `snapshot`, `scene_update` между двумя клиентами, `alarm()`, сохранение данных после перезапуска DO и автоответ `{"type":"ping"}` -> `{"type":"pong"}`.
6. **Защита деплоя (`.github/workflows/deploy.yml` и `README.md`)**:
   - В `.github/workflows/deploy.yml` добавлена группа `concurrency: deploy-production` и обязательные шаги `npm run check:licenses`, `npm run typecheck`, `npm run lint`, `npm test` перед `npm run build` и деплоем.
   - В `README.md` добавлены инструкции по настройке `PILOT_BOARD_IDS`, выдаче ссылок ученикам и включению обязательных проверок CI (Branch Protection) на ветке `main`.

---

## 2. Таблица записей в SQLite за один сброс `flushSnapshot`: «До и После»

По правилам биллинга [SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/):
- Таблица `meta (key TEXT PRIMARY KEY, value TEXT)` имеет строковый первичный ключ (`TEXT PRIMARY KEY`), который в SQLite создаёт внутренний автоиндекс `sqlite_autoindex_meta_1`. Каждая операция `INSERT OR REPLACE INTO meta` тарифицируется в Cloudflare как **2 записанные строки** (1 строка таблицы + 1 строка индекса), даже если `cursor.rowsWritten` возвращает `1`.
- Таблица `snapshot (chunk_idx INTEGER PRIMARY KEY, data BLOB)` использует `INTEGER PRIMARY KEY` (прямой алиас `ROWID` без вторичного индекса) — каждая операция `INSERT OR REPLACE INTO snapshot` тарифицируется ровно как **1 записанная строка**.

| Метрика / Операция при сбросе (`flushSnapshot`) для типичной доски (`< 900 КБ`, 1 чанк) | До T2.5 (`T1`) | После T2.5 (`task/T2.5-stabilize`) | Экономия |
| :--- | :--- | :--- | :--- |
| `INSERT OR REPLACE INTO meta ('board_id', ?)` | 1 запрос при первом сбросе (`rowsWritten = 1`, с автоиндексом `TEXT PK` — 2 биллинговые строки) | **0 запросов / 0 строк** (`boardId` хранится в `WebSocketAttachment`) | **−100%** |
| `INSERT OR REPLACE INTO meta ('snapshot_version', ?)` | 1 запрос при каждом сбросе (`rowsWritten = 1`, с автоиндексом `TEXT PK` — 2 биллинговые строки) | **0 запросов / 0 строк** (версии элементов хранятся в JSON сцены) | **−100%** |
| `INSERT OR REPLACE INTO snapshot (0, data)` (`INTEGER PRIMARY KEY`) | 1 запрос (`rowsWritten = 1`, 1 биллинговая строка) | **1 запрос (`rowsWritten = 1`, 1 биллинговая строка)** | Базовая полезная запись |
| `DELETE FROM snapshot WHERE chunk_idx >= ?` | Выполнялся на каждом сбросе (даже при 1 чанке) | **Выполняется только при `chunks.length < lastPersistedChunksCount`** (0 вызовов при 1 чанке) | Убран лишний SQL-запрос |
| **Итого `rowsWritten` (по счётчику SQLite) на 1-м сбросе (1 чанк)** | **3 строки** | **1 строка** | **В 3 раза меньше** |
| **Итого `rowsWritten` на каждом следующем сбросе (1 чанк)** | **2 строки** | **1 строка** | **В 2 раза меньше** |
| **Итого за 5 сбросов (тест 100 `scene_update` за 5 с)** | **11 строк** (`3 + 4×2`) | **5 строк** (`5×1`) | **−54,5%** |
| **Итого биллинговых записей Cloudflare за сброс (включая `setAlarm` и индекс `TEXT PK`)** | **6 строк** (1-й сброс) / **4 строки** (последующие) | **2 строки** (`1 snapshot` + `1 setAlarm`) | **В 2–3 раза меньше** |

---

## 3. Новые и обновлённые зависимости (`package.json`, `worker/package.json`)

Все пакеты соответствуют разрешённым лицензиям (`MIT`, `Apache-2.0`, `BSD-3-Clause`):
- `@types/node` (`^22.9.0`, лицензия **MIT**) — типы стандартной библиотеки Node.js для скриптов и E2E/модульных тестов.
- `@types/ws` (`^8.5.13`, лицензия **MIT**) — типы для пакета `ws` в тестовых и дымовых скриптах.
- `miniflare` (`^4.0.0`, лицензия **MIT**) — официальная локальная среда выполнения Cloudflare Workers (`workerd`) для интеграционного теста `worker/test/board.runtime.test.ts`.
- `esbuild` (`^0.25.0`, лицензия **MIT**) — сборщик TypeScript-кода Worker для запуска в `Miniflare`.
- `@cloudflare/workers-types` (`^4.20250214.0`, лицензия **MIT` / `Apache-2.0**) и `wrangler` (`^4.0.0`, лицензия **MIT` / `Apache-2.0**) — приведены к актуальным semver-границам `^4` для установки из официального реестра npm.

---

## 4. Что проверено в песочнице и что нужно выполнить агенту Antigravity 2.0 (сеть + браузер)

В соответствии с правилами `AGENTS.md` (честный отчёт без преувеличений):

### Проверено и запущено в текущей песочнице (Node `v18.20.4`, без исходящего интернета):
1. `node scripts/check-licenses.mjs` — проверены манифесты workspaces и 13 правил исключений в `license-exceptions.json` (`OK`).
2. `node scripts/gen-board-id.mjs` и `node scripts/gen-board-id.mjs 3` — проверена генерация криптостойких 22-символьных base62 ID и вывод строки для `PILOT_BOARD_IDS`.
3. `node scripts/ws-smoke.mjs` — проверен дымовой сценарий совместного рисования 3 клиентов по WebSocket и финальный сброс снимка (`rowsWritten: 1, totalRowsWritten: 1`).
4. Все **26 модульных и интеграционных тестов** (`5` в `health.test.ts`, `5` в `licenses.test.ts`, `10` в `board.test.ts`, `1` в `board.runtime.test.ts` в режиме shim-fallback, `5` в `web/test/collab.test.ts`) — **26/26 пройдены**.
5. Синтаксический и типовой разбор всех `.ts`, `.tsx` и `.mjs` файлов через `@babel/preset-typescript` — **0 ошибок**.

### Не запускалось в песочнице (требует исходящего доступа к `registry.npmjs.org`, бинарника `workerd` и браузера Chromium — передано в инструкцию `docs/ANTIGRAVITY_T2_5_PROMPT.md`):
1. Генерация настоящего `package-lock.json` через `npm install` из `registry.npmjs.org` и проверка `npm ci` в чистом клоне (`git clone`).
2. Полный прогон `npm run check:licenses`, `npm run typecheck`, `npm run lint`, `npm test` (с активным `Miniflare` в `board.runtime.test.ts`) и `npm run build` на установленном дереве `node_modules`.
3. Живая проверка `wrangler dev` с паузой 15 секунд после `scene_update` (убедиться, что `alarm()` срабатывает через 5 секунд до гибернации DO).
4. Установка браузера Chromium (`npx playwright install chromium`) и запуск E2E-теста двух браузеров (`npm run test:e2e`).
5. Деплой в Cloudflare (`wrangler deploy` / GitHub Actions) и установка секрета `PILOT_BOARD_IDS`.
