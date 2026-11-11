# PR: Задача T2.5 / T2.5b / T2.5c — Стабилизация перед пилотом (`task/T2.5-stabilize`)

## 1. Сводка изменений по пунктам T2.5, T2.5b и T2.5c

### Раздел A. Восстановление строгих проверок и разделение `tsconfig` (пункты A.1–A.4 и T2.5c п. 3)
1. **`tsconfig.base.json` (`exactOptionalPropertyTypes: true`)**:
   - Возвращена опция `"exactOptionalPropertyTypes": true` в `tsconfig.base.json`.
   - Все интерфейсы в `worker/` и `web/` приведены в полное соответствие с `exactOptionalPropertyTypes: true`.
2. **`eslint.config.mjs` (возврат правил `@typescript-eslint/no-non-null-assertion` и `@typescript-eslint/no-invalid-void-type`)**:
   - Оба правила возвращены в конфигурацию ESLint (`tseslint.configs.strict` без переопределений `"off"`), убран ignore `**/artifacts/**` (каталог `artifacts/` — внутренний каталог рабочей среды ВМ вне Git-репозитория).
   - Из всех файлов кода и тестов устранены операторы non-null assertion (`!`).
3. **Удаление рукописных `.d.ts`-заглушек и разделение `worker/tsconfig.json` vs `worker/tsconfig.test.json` (T2.5c п. 3)**:
   - Удалены файлы `worker/src/cloudflare-workers.d.ts`, `worker/test/node-ambient.d.ts`, `scripts/check-licenses.d.ts` и `scripts/gen-board-id.d.ts`.
   - Чтобы глобальные типы `@cloudflare/workers-types` и `@types/node` (`fetch`, `Request`, `Response`, `WebSocket`) никогда не конфликтовали при проверке исходников Worker, конфигурация разделена:
     - `worker/tsconfig.json` проверяет `src/**/*.ts` строго с `"types": ["@cloudflare/workers-types"]`;
     - `worker/tsconfig.test.json` проверяет `test/**/*.ts` с `"types": ["@cloudflare/workers-types", "node"]`;
     - скрипт `typecheck` в `worker/package.json` запускает оба (`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit`).
4. **`license-exceptions.json` и `scripts/check-licenses.mjs`**:
   - Удалены добавленные по памяти исключения `MPL-2.0` (`axe-core`, `lightningcss`) и `pako` / `tweetnacl` / `mdn-data`. Оставлены только базовые 8 пермиссивных исключений (`0BSD`, `CC-BY-4.0`, `CC-BY-3.0`, `CC0-1.0`, `Python-2.0`, `BlueOak-1.0.0`).
   - Из `scripts/check-licenses.mjs` убрана поддержка подстановочного символа `"*"`.

---

### Раздел B и T2.5c. Архитектурные и продуктовые доработки перед пилотом
5. **Надёжный сброс снимка при любом закрытии или ошибке WebSocket (`worker/src/board.ts`, `closeSessionInternal`)**:
   - При любом вызове `closeSessionInternal`, `webSocketClose` или `webSocketError`, если `this.dirty === true`, сброс `this.flushSnapshot("connection_close", nowMs)` выполняется немедленно без пересчёта `remainingActive`.
6. **Потолок размера доски (`MAX_BOARD_ELEMENTS = 20_000`, `MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024`)**:
   - При превышении 20 000 элементов или 20 МиБ JSON снимка `scene_update` отклоняется, клиенту отправляется `{"type":"error","code":"board_too_large"}`, а клиент выводит плашку `RU_STRINGS.boardTooLargeError`.
7. **Повреждённый снимок (`snapshot_backup`, продолжение работы при успешном бэкапе и `board_not_saved` при сбое бэкапа — T2.5c п. 2)**:
   - При ошибке разбора JSON в `loadSnapshotFromSqlite()` старые куски из `snapshot` копируются в `snapshot_backup (chunk_idx INTEGER PRIMARY KEY, data BLOB, backed_up_at INTEGER)`.
   - Если резервная копия в `snapshot_backup` записана успешно (логируется `snapshot_corrupted_backup_saved` один раз), объект стартует с пустой сценой (`this.snapshotSaveBlocked = false`, `this.persistedChunkDigests.clear()`) и дальше сохраняет новые правки как обычно.
   - Запись блокируется (`this.snapshotSaveBlocked = true`) **только если записать резервную копию в `snapshot_backup` не удалось** (`snapshot_corrupted_backup_failed`): в этом случае при `hello` клиенту отправляется `{"type":"error","code":"board_not_saved"}`, а клиент показывает постоянную плашку «Доска повреждена, изменения не сохраняются. Сообщите преподавателю». В `README.md` описан порядок восстановления данных из `snapshot_backup`.
8. **Запись только изменившихся кусков и защита дайджестов при откате транзакции (`flushSnapshot` — B.8 и T2.5c п. 1)**:
   - В `flushSnapshot()` вычисляется дайджест каждого куска (`computeChunkDigest`) и в SQLite записываются только изменившиеся куски.
   - Новые дайджесты (`stagedDigests`), новое число кусков (`stagedChunksCount`) и флаг `stagedSchemaInitialized` собираются во временные переменные внутри `runTx` и копируются в поля объекта (`this.persistedChunkDigests`, `this.lastPersistedChunksCount`, `this.schemaInitialized`) **только после успешного завершения `transactionSync`** (добавлен модульный тест с выбросом исключения в `sql.exec` посередине сброса и последующим успешным сбросом всех кусков).
9. **Корень `/` и кнопка «Открыть новую доску» в продакшене (`web/src/App.tsx`, `web/src/i18n/ru.ts`)**:
   - Генерация случайного ID доски на `/` и кнопка «Открыть новую доску» оставлены только в режиме разработки (`import.meta.env.DEV`); в продакшене корень `/` показывает «Откройте ссылку на доску, которую вам прислал преподаватель».
10. **Авто-режим пера и разблокировка тулбара для касаний пальцем (`web/src/App.tsx`, `web/src/input/pen-guard.ts`)**:
    - По умолчанию `penMode` выключен (`false` — режим «Режим пера: авто»), включается при первом касании пером и переключается вручную; касания пальцем по тулбару Excalidraw (`isExcalidrawUiTarget`) не блокируются.
11. **Дымовой скрипт `scripts/ws-smoke.mjs`**:
    - Подключается к настоящему `wrangler dev` по `WS_SMOKE_URL` (по умолчанию `ws://localhost:8787`), используя только пакеты из `node_modules`.

---

### Раздел C и T2.5c п. 4. Тесты реального рантайма (`worker/test/board.runtime.test.ts` и CI)
12. **Отказ от тихого перехода на шим в `worker/test/board.runtime.test.ts`**:
    - При `CI` или `REQUIRE_RUNTIME=1` (добавлено в `.github/workflows/ci.yml` и `deploy.yml`) тест падает, если `Miniflare` не загрузился; без переменной выводит предупреждение и помечается как `skip`.
13. & 14. **Разделение `board.runtime.test.ts` на 2 независимых теста с тайм-аутом 60 секунд каждый (T2.5c п. 4)**:
    - **Тест 1 (`timeout: 60_000`)**: короткие проверки протокола (`hello` + `snapshot`, `scene_update` между двумя клиентами, автоответ `{"type":"ping"}` -> `{"type":"pong"}`, ожидание `2 600` мс для срабатывания продакшен-`alarm` `2 000` мс, немедленный сброс при закрытии сокета `wsA.close()`) и проверка сохранности данных на диске через `mf.dispose()` и повторный запуск `Miniflare` на том же каталоге SQLite.
    - **Тест 2 (`timeout: 60_000`)**: отдельный сценарий «15 секунд тишины» при `SAVE_INTERVAL_MS="5000"` с последующим перезапуском `Miniflare` на том же каталоге SQLite.
    - *Примечание*: вызов `mf.dispose()` и повторный запуск `Miniflare` с тем же `durableObjectsPersist` проверяют сохранность данных в SQLite на диске, а не выгрузку объекта из памяти по 10-секундному таймеру гибернации; выгрузка по таймеру проверяется отдельно на живом `wrangler dev` (пункт 17 из T2.5b).

---

## 2. Таблица записей в SQLite за один сброс `flushSnapshot`: «До и После»

| Операция при сбросе (`flushSnapshot`) | До T2.5 (`T1`) | После T2.5 / T2.5b / T2.5c (`task/T2.5-stabilize`) |
| :--- | :--- | :--- |
| `INSERT OR REPLACE INTO meta ('board_id', ?)` | 1 запрос на 1-м сбросе | **0 запросов** (`boardId` хранится в `WebSocketAttachment`) |
| `INSERT OR REPLACE INTO meta ('snapshot_version', ?)` | 1 запрос на каждом сбросе | **0 запросов** |
| `INSERT OR REPLACE INTO snapshot (chunk_idx, data)` (1 чанк `< 900 КБ`) | 1 строка на каждом сбросе | **1 строка** (только если дайджест чанка изменился) |
| `INSERT OR REPLACE INTO snapshot (chunk_idx, data)` (доска `> 900 КБ`, изменился 1 из N чанков) | `N` строк (перезаписывались все чанки) | **1 строка** (переписывается только изменившийся чанк по `computeChunkDigest`) |
| `DELETE FROM snapshot WHERE chunk_idx >= ?` | Вызывался на каждом сбросе | **Вызывается только при `chunks.length < lastPersistedChunksCount`** |
| **Итого `rowsWritten` за 5 сбросов (100 `scene_update` за 5 с, 1 чанк)** | **11 строк** (`3 + 4×2`) | **5 строк** (`5×1`) |

*(При прогоне в среде с `wrangler dev` приложите ниже фактический лог `snapshot_flush` из вывода реального рантайма `workerd`).*

---

## 3. Чек-лист ручной проверки ввода стилусом и пальцем на планшете (пункт B.10)

1. **Палец по тулбару**: откройте доску `/b/<id>`, убедитесь, что горит `Режим пера: авто`, и нажмите пальцем по инструментам на тулбаре Excalidraw — инструменты переключаются с первого касания (в том числе если вручную включить `Режим пера: вкл`).
2. **Рисование пальцем при выключенном `penMode` (`Режим пера: авто`)**: выберите инструмент «Карандаш» и проведите одним пальцем по холсту — штрих рисуется и синхронизируется.
3. **Перо (автоматическое включение `penMode`)**: коснитесь холста стилусом (`pointerType === "pen"`) — режим автоматически переключится в `Режим пера: вкл`, после чего одиночный палец перестанет рисовать на холсте, а перо продолжит рисовать.
4. **Ладонь рядом с пером**: положите ребро ладони на экран (`width/height >= 48px`) — ладонь не оставляет ложных штрихов ни в режиме `авто`, ни в режиме `вкл`.
5. **Жест двух пальцев**: поставьте на холст два пальца и выполните сведение/разведение (зум) и сдвиг (панорамирование) — жест работает плавно при любом состоянии `penMode`.

---

## 4. Что проверено в текущей среде и что должен выполнить агент с доступом к сети и браузеру (раздел D)

### Проверено в текущей среде (офлайн-контейнер без доступа к `registry.npmjs.org` и браузеру):
- `node scripts/check-licenses.mjs` — проверены манифесты workspaces и 8 исключений в `license-exceptions.json`.
- `node scripts/gen-board-id.mjs 2` — проверена генерация 22-символьных base62 ID.
- Прогнаны модульные тесты в `worker/test/health.test.ts` (5 тестов), `worker/test/licenses.test.ts` (5 тестов), `worker/test/board.test.ts` (12 тестов, включая тест отката транзакции п. 1 T2.5c и тест `snapshot_backup` / `board_not_saved` п. 2 T2.5c) и `web/test/collab.test.ts` (5 тестов) — 27 модульных тестов пройдены, а 2 runtime-теста в `worker/test/board.runtime.test.ts` без установленного `miniflare` при отсутствии `REQUIRE_RUNTIME=1` выводят предупреждение и помечаются как `skip` (при `REQUIRE_RUNTIME=1` падают с ошибкой).

### Не проверено в офлайн-контейнере (выполняется агентом на Node 22 с сетью и браузером по разделу D `docs/ANTIGRAVITY_T2_5_PROMPT.md`):
1. `npm install` с настоящим реестром npm, коммит настоящего `package-lock.json` и проверка `npm ci` в чистом клоне (`git clone`).
2. Полный прогон на Node 22 в чистом клоне:
   - `npm run check:licenses` (и проверка `npm ls axe-core lightningcss`);
   - `npm run typecheck` (`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit` в `worker/` и `tsc --noEmit` в `web/` с `exactOptionalPropertyTypes: true`);
   - `npm run lint`;
   - `REQUIRE_RUNTIME=1 npm test` (включая оба теста в `worker/test/board.runtime.test.ts` на реальном `Miniflare` и замер их фактической длительности);
   - `npm run build`;
   - `npx playwright install chromium && npm run test:e2e` + фактический список запросов браузера из вкладки Network.
3. Живой сценарий на `wrangler dev`: `npm run dev` + `npm run smoke:ws`, пауза 15 секунд после `scene_update`, и немедленное закрытие вкладки после штриха.

---

## 5. Пошаговая инструкция по деплою для владельца проекта (раздел E и T2.5c п. 5)

Строгий порядок действий для владельца: **1) секреты GitHub (`CLOUDFLARE_API_TOKEN` и `CLOUDFLARE_ACCOUNT_ID`) → 2) первый деплой (слияние PR в `main`) → 3) установка секрета `PILOT_BOARD_IDS` → 4) раздача ссылок ученикам**.

1. **Создайте API-токен Cloudflare и добавьте секреты в GitHub Secrets**:
   - В панели Cloudflare создайте токен с правами `Account -> Workers Scripts: Edit` и `Account -> Account Settings: Read`.
   - В репозитории GitHub (`Settings -> Secrets and variables -> Actions`) сохраните секреты `CLOUDFLARE_ACCOUNT_ID` и `CLOUDFLARE_API_TOKEN`.
2. **Выполните первый деплой (слейте PR в `main`)**:
   - После зелёных проверок CI слейте PR в `main` — запустится `.github/workflows/deploy.yml` и создаст Worker `online-board` (пока `PILOT_BOARD_IDS` не задан, все `/ws/*` отвечают `404`, а `/api/health` отвечает `200`).
3. **Задайте секрет `PILOT_BOARD_IDS`**:
   ```bash
   npm run gen:board-id -- 10
   cd worker
   npx wrangler secret put PILOT_BOARD_IDS
   ```
   Вставьте сгенерированные 10 ID через запятую без пробелов.
4. **Проверьте `/api/health` и раздайте ссылки ученикам**:
   - Проверьте `https://online-board.<ваш-поддомен>.workers.dev/api/health` и отправьте ученикам ссылки `https://online-board.<ваш-поддомен>.workers.dev/b/<ID>`.
