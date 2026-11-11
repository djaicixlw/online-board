# PR: Задача T2.5 / T2.5b — Стабилизация перед пилотом (`task/T2.5-stabilize`)

## 1. Сводка изменений по пунктам T2.5 и доработки T2.5b

### Раздел A. Восстановление строгих проверок и конфигурации (пункты 1–4)
1. **`tsconfig.base.json` (`exactOptionalPropertyTypes: true`)**:
   - Возвращена опция `"exactOptionalPropertyTypes": true` в `tsconfig.base.json`.
   - Во всех интерфейсах с опциональными свойствами (`worker/src/env.ts`, `worker/src/board.ts`, `web/src/collab/types.ts`, `web/src/collab/client.ts`, `web/src/input/pen-guard.ts`) типы приведены к точной совместимости с `exactOptionalPropertyTypes: true`.
2. **`eslint.config.mjs` (возврат правил `@typescript-eslint/no-non-null-assertion` и `@typescript-eslint/no-invalid-void-type`)**:
   - Оба правила возвращены в конфигурацию ESLint (`tseslint.configs.strict` без переопределений `"off"`), удалён ignore `**/artifacts/**` (каталог `artifacts/` является служебным каталогом рабочей среды ВМ вне Git-репозитория).
   - Из всех файлов кода и тестов (`worker/src/board.ts`, `worker/test/board.test.ts`, `worker/test/board.runtime.test.ts`, `web/test/collab.test.ts`) устранены операторы non-null assertion (`!`).
3. **Удаление рукописных `.d.ts`-заглушек**:
   - Удалены файлы `worker/src/cloudflare-workers.d.ts`, `worker/test/node-ambient.d.ts`, `scripts/check-licenses.d.ts` и `scripts/gen-board-id.d.ts`.
   - В `worker/tsconfig.json` задано `"types": ["@cloudflare/workers-types", "node"]`, а в `tsconfig.base.json` включено `"allowJs": true` для штатной работы с пакетами из `node_modules`.
4. **`license-exceptions.json` и `scripts/check-licenses.mjs`**:
   - Удалены добавленные по памяти исключения `MPL-2.0` (`axe-core`, `lightningcss`) и `pako` / `tweetnacl` / `mdn-data`. Оставлены только базовые 8 пермиссивных исключений (`0BSD`, `CC-BY-4.0`, `CC-BY-3.0`, `CC0-1.0`, `Python-2.0`, `BlueOak-1.0.0`).
   - Из `scripts/check-licenses.mjs` убрана поддержка подстановочного символа `"*"` (`loadExceptions` явно отклоняет `"*"`).

---

### Раздел B. Архитектурные и продуктовые доработки перед пилотом (пункты 5–11)
5. **Надёжный сброс снимка при любом закрытии или ошибке WebSocket (`worker/src/board.ts`, `closeSessionInternal`)**:
   - Ранее сброс при закрытии срабатывал только при `remainingActive === 0`. В реальной среде Cloudflare Workers закрывающийся сокет в момент вызова `webSocketClose` может ещё числиться в `ctx.getWebSockets()`, из-за чего при выходе последнего участника условие `remainingActive === 0` не выполнялось.
   - Теперь в `closeSessionInternal`, `webSocketClose` и `webSocketError` при `this.dirty === true` сброс `this.flushSnapshot("connection_close", nowMs)` выполняется **безусловно и немедленно**, а отложенный `alarm` отменяется.
6. **Потолок размера доски (`MAX_BOARD_ELEMENTS = 20_000`, `MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024`)**:
   - В `worker/src/board.ts` добавлен контроль числа элементов (не более `20 000`) и расчётного байтового размера JSON снимка (не более `20 МиБ`).
   - При превышении любого из двух порогов `scene_update` отклоняется без изменения состояния в памяти, клиенту отправляется `{"type":"error","code":"board_too_large"}`, а в лог пишется событие `board_too_large_rejected`.
   - На клиенте (`web/src/collab/client.ts`, `web/src/App.tsx`, `web/src/i18n/ru.ts`) сообщение `{"type":"error","code":"board_too_large"}` обрабатывается колбэком `onServerError` и выводит русскоязычную плашку `RU_STRINGS.boardTooLargeError` (`data-testid="board-error-banner"`).
7. **Защита от затирания повреждённого снимка (`snapshot_backup`)**:
   - В `loadSnapshotFromSqlite()` при ошибке разбора JSON (`snapshot_load_error`) старые куски из таблицы `snapshot` копируются в резервную таблицу `snapshot_backup (chunk_idx INTEGER PRIMARY KEY, data BLOB, backed_up_at INTEGER)`, в лог пишется отдельное событие `snapshot_corrupted_backup_saved`, и поднимается флаг `this.snapshotCorrupted = true`.
   - Пока `this.snapshotCorrupted === true`, метод `flushSnapshot()` блокирует перезапись таблицы `snapshot` (логирует `snapshot_flush_skipped_corrupted` и возвращает `null`), чтобы пустая сцена не затёрла данные до разбирательства владельца.
8. **Запись только изменившихся кусков (`computeChunkDigest` в `flushSnapshot`)**:
   - Объект `Board` хранит карту дайджестов каждого записанного куска `persistedChunkDigests` (`Map<number, string>`, инициализируется при чтении из SQLite и обновляется при сбросе).
   - При очередном `flushSnapshot()` запрос `INSERT OR REPLACE INTO snapshot (chunk_idx, data) VALUES (?, ?)` выполняется **только для тех кусков, чей дайджест изменился**, а `DELETE FROM snapshot WHERE chunk_idx >= ?` — только при уменьшении числа кусков (`chunks.length < this.lastPersistedChunksCount`).
9. **Корень `/` и кнопка «Открыть новую доску» в продакшене (`web/src/App.tsx`, `web/src/i18n/ru.ts`)**:
   - Автоматический редирект с `/` на случайный `/b/<id>` и кнопка «Открыть новую доску» (`generateBoardId()`) оставлены **только для режима разработки** (`import.meta.env.DEV`).
   - В продакшене корень `/` показывает карточку «Откройте ссылку на доску, которую вам прислал преподаватель» (`data-testid="prod-root-screen"`), а кнопка создания случайной доски скрыта.
10. **Авто-режим пера и разблокировка тулбара для касаний пальцем (`web/src/App.tsx`, `web/src/input/pen-guard.ts`)**:
    - По умолчанию `penMode` выключен (`false` — режим «Режим пера: авто»), чтобы на планшете без стилуса можно было сразу рисовать пальцем.
    - При первом касании экрана пером (`pointerType === "pen"`) `penMode` автоматически включается (`true`) и остаётся переключаемым вручную кнопкой в шапке.
    - В `shouldSuppressTouchOrPalmDrawing` добавлена проверка `isExcalidrawUiTarget(event.target)`: касания пальцем по тулбарам, меню и кнопкам Excalidraw (`.App-toolbar`, `.App-menu`, `.Island`, `.layer-ui__wrapper`, `button`, `input`, `label`) никогда не гасятся даже при включённом `penMode`. Защита от касания ладонью по площади контакта (`width >= 48` или `height >= 48` px) и пропуск второго пальца (`isPrimary === false`) для 2-пальцевого зума/пана сохранены.
11. **Дымовой скрипт `scripts/ws-smoke.mjs`**:
    - Полностью убраны пути песочницы (`/usr/share/nodejs`), `@babel/core` и встроенный шим-сервер.
    - Скрипт импортирует `WebSocket` напрямую из пакета `ws` (`node_modules`) и подключается к запущенному `wrangler dev` по адресу `WS_SMOKE_URL` (по умолчанию `ws://localhost:8787`). В `README.md` описан запуск в двух терминалах (`npm run dev` + `npm run smoke:ws`).

---

### Раздел C. Тесты реального рантайма (`worker/test/board.runtime.test.ts` и CI)
12. **Отказ от тихого перехода на шим в `worker/test/board.runtime.test.ts`**:
    - Из `board.runtime.test.ts` полностью удалён fallback на `cloudflare-workers-shim`.
    - Если задана переменная окружения `CI` или `REQUIRE_RUNTIME=1` (добавлена в `.github/workflows/ci.yml` и `.github/workflows/deploy.yml`), при отсутствии или ошибке запуска `Miniflare` тест **падает с ошибкой**.
    - Без `REQUIRE_RUNTIME=1` (при локальном запуске до установки `miniflare`) тест выводит предупреждение `[WARN]` в консоль и помечается как **пропущенный (`ctx.skip()`)**, а не как пройденный.
13. & 14. **Проверка реального `alarm` (>= 2,5 с), сброса при закрытии и 15 секунд тишины в `board.runtime.test.ts`**:
    - В `board.runtime.test.ts` ожидание срабатывания `alarm` при продакшен-зажиме `SAVE_INTERVAL_MS="2000"` увеличено до `2 600` мс при открытых сокетах.
    - Добавлена проверка немедленного сброса при закрытии вкладки (`wsA.close()` через 40 мс после `scene_update` при открытом `wsB`) и проверка сохранения элемента после **15 секунд полной тишины** при `SAVE_INTERVAL_MS="5000"` с последующим перезапуском экземпляра `Miniflare`.

---

## 2. Таблица записей в SQLite за один сброс `flushSnapshot`: «До и После»

| Операция при сбросе (`flushSnapshot`) | До T2.5 (`T1`) | После T2.5 / T2.5b (`task/T2.5-stabilize`) |
| :--- | :--- | :--- |
| `INSERT OR REPLACE INTO meta ('board_id', ?)` | 1 запрос на 1-м сбросе | **0 запросов** (`boardId` хранится в `WebSocketAttachment`) |
| `INSERT OR REPLACE INTO meta ('snapshot_version', ?)` | 1 запрос на каждом сбросе | **0 запросов** |
| `INSERT OR REPLACE INTO snapshot (chunk_idx, data)` (1 чанк `< 900 КБ`) | 1 строка на каждом сбросе | **1 строка** (только если дайджест чанка изменился) |
| `INSERT OR REPLACE INTO snapshot (chunk_idx, data)` (доска `> 900 КБ`, изменился 1 из N чанков) | `N` строк (перезаписывались все чанки) | **1 строка** (переписывается только изменившийся чанк по `computeChunkDigest`) |
| `DELETE FROM snapshot WHERE chunk_idx >= ?` | Вызывался на каждом сбросе | **Вызывается только при `chunks.length < lastPersistedChunksCount`** |
| **Итого `rowsWritten` за 5 сбросов (100 `scene_update` за 5 с, 1 чанк)** | **11 строк** (`3 + 4×2`) | **5 строк** (`5×1`) |

*(Внимание: при прогоне в среде с `wrangler dev` вставьте ниже фактический лог `snapshot_flush` из вывода реального рантайма `workerd`).*

---

## 3. Чек-лист ручной проверки ввода стилусом и пальцем на планшете (пункт B.10)

1. **Старт в режиме «Режим пера: авто» (`penMode = false`) и нажатие пальцем по тулбару**:
   - Откройте доску `/b/<id>` на планшете и введите ник.
   - Убедитесь, что в верхней панели горит кнопка `Режим пера: авто`.
   - Нажмите одиночным пальцем по инструментам на панели Excalidraw (Выбор, Прямоугольник, Стрелка, Карандаш) — инструменты переключаются с первого касания.
2. **Рисование пальцем при выключенном `penMode` (`Режим пера: авто`)**:
   - Выберите пальцем инструмент «Карандаш» (`Freedraw`) и проведите одним пальцем по холсту — линия свободно рисуется и уходит второму участнику.
3. **Автоматическое включение `penMode` при первом касании пером (стилусом)**:
   - Коснитесь холста стилусом (`pointerType === "pen"`) и нарисуйте штрих.
   - Кнопка в шапке автоматически переключится в состояние `Режим пера: вкл`, после чего одиночные касания пальцем по холсту перестанут оставлять случайные штрихи, но нажатия пальцем по кнопкам тулбара Excalidraw и шапки продолжат работать.
4. **Защита от касания ладонью (Palm Rejection)**:
   - Приложите ребро ладони к экрану (ширина/высота пятна контакта `>= 48px`) во время письма пером и при переключённом вручную режиме — ладонь не оставляет точек и штрихов на холсте.
5. **Жест двух пальцев (Pinch-to-Zoom и Pan)**:
   - При включённом `Режим пера: вкл` поставьте на холст два пальца и разведите/сведите их — масштаб и панорамирование холста плавно изменяются (`isPrimary === false` не блокируется).

---

## 4. Что проверено в текущей среде и что должен выполнить агент с доступом к сети и браузеру (раздел D)

### Проверено в текущей среде (офлайн-контейнер без доступа к `registry.npmjs.org` и браузеру):
- `node scripts/check-licenses.mjs` — проверены манифесты workspaces и 8 исключений в `license-exceptions.json`.
- `node scripts/gen-board-id.mjs 3` — проверена генерация 22-символьных base62 ID.
- Прогнаны модульные тесты в `worker/test/health.test.ts` (5 тестов), `worker/test/licenses.test.ts` (5 тестов), `worker/test/board.test.ts` (11 тестов, включая тесты пунктов B.5, B.6, B.7, B.8) и `web/test/collab.test.ts` (5 тестов, включая тесты B.6 и B.10). Тест `worker/test/board.runtime.test.ts` без установленного `miniflare` при отсутствии `REQUIRE_RUNTIME=1` штатно выводит предупреждение и помечается как `skip`, а при `REQUIRE_RUNTIME=1` падает с ошибкой.

### Не проверено в офлайн-контейнере (должно быть выполнено агентом на Node 22 с сетью и браузером перед открытием PR — см. `docs/ANTIGRAVITY_T2_5_PROMPT.md`):
1. `npm install` с настоящим реестром npm, коммит настоящего `package-lock.json` и проверка `npm ci` в чистом клоне (`git clone`).
2. Полный прогон на Node 22 в чистом клоне:
   - `npm run check:licenses` (на полном дереве из сотен пакетов; если потребуются проверки `npm ls axe-core lightningcss`, вынести вопрос владельцу в PR);
   - `npm run typecheck` (`tsc --noEmit` с включённым `exactOptionalPropertyTypes: true`);
   - `npm run lint` (`eslint . && prettier --check .` без отключённых правил);
   - `REQUIRE_RUNTIME=1 npm test` (включая `worker/test/board.runtime.test.ts` на реальном `Miniflare`);
   - `npm run build`;
   - `npx playwright install chromium && npm run test:e2e` + фактический список запросов из вкладки Network.
3. Живой сценарий на `wrangler dev`:
   - `npm run dev` в одном окне + `npm run smoke:ws` во втором окне;
   - одно `scene_update` -> пауза 15 секунд -> переподключение -> элемент на месте;
   - штрих -> немедленное закрытие вкладки -> повторное открытие -> элемент на месте.

---

## 5. Пошаговая инструкция по деплою для владельца проекта (раздел E)

*(Деплой и установка секретов выполняются владельцем самостоятельно после ревью и слияния PR в `main`).*

1. **Создайте API-токен Cloudflare с минимальными правами**:
   - В панели Cloudflare откройте **Profile** → **API Tokens** → **Create Token** → **Create Custom Token**.
   - Выдайте разрешения уровня аккаунта: `Account` → `Workers Scripts: Edit` и `Account` → `Account Settings: Read` (ограничьте ресурс своим аккаунтом).
2. **Добавьте секреты в GitHub Secrets**:
   - В репозитории GitHub откройте **Settings** → **Secrets and variables** → **Actions** и создайте секреты `CLOUDFLARE_ACCOUNT_ID` и `CLOUDFLARE_API_TOKEN`.
3. **Слейте PR в `main`**:
   - После зелёного прохождения всех проверок CI слейте PR в ветку `main` — автоматически запустится workflow `.github/workflows/deploy.yml`.
4. **Сгенерируйте 10 ID досок для пилота и сохраните их в секрет `PILOT_BOARD_IDS`**:
   ```bash
   npm run gen:board-id -- 10
   cd worker
   npx wrangler secret put PILOT_BOARD_IDS
   ```
   Вставьте сгенерированные 10 ID через запятую без пробелов.
5. **Проверьте опубликованный Worker**:
   ```bash
   curl https://online-board.<ваш-поддомен>.workers.dev/api/health
   # Ожидаемый ответ: {"ok":true,"version":"0.1.0"}
   ```
   Откройте в браузере `https://online-board.<ваш-поддомен>.workers.dev/b/<ОДИН_ИЗ_10_ID>` для проверки работы доски.
