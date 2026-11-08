# T1: Комната доски (Durable Object Board, WebSocket Hibernation, SQLite-снимки, лимиты)

Ветка: `task/T1-board-room` → `main`

## Что сделано

1. **Маршрут `GET /ws/:id?nick=<ник>` (`worker/src/index.ts`, `worker/src/board.ts`)**:
   - Проверяется метод `GET` и заголовок `Upgrade: websocket` (без регистрозависимости).
   - Валидируется `id` доски (`isValidBoardId`): ровно 22 символа base62 (`^[0-9A-Za-z]{22}$`).
   - Очищается и валидируется `nick` (`sanitizeNickname`): удаляются управляющие символы (`C0`/`C1`), обрезаются пробелы по краям, проверяется длина `1..32` символа (в кодовых точках Unicode, с полной поддержкой кириллицы). При любой ошибке входных данных возвращается `400 Bad Request`.
   - Если `ALLOW_ANY_BOARD_ID !== "true"`, неизвестные доски получают ответ `404 Not Found` (до появления проверки по реестру D1 в задаче T3).
   - Подключение маршрутизируется в единственный объект на доску через `env.BOARD.idFromName(boardId)` ([Durable Objects Getting Started](https://developers.cloudflare.com/durable-objects/get-started/)).

2. **Durable Object `Board` на SQLite и WebSocket Hibernation API (`worker/src/board.ts`)**:
   - Используются методы [WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/): `this.ctx.acceptWebSocket`, `webSocketMessage`, `webSocketClose`, `webSocketError`, а состояние каждого клиента сохраняется через `serializeAttachment` и восстанавливается при пробуждении через `deserializeAttachment` и `this.ctx.getWebSockets()` ([Use WebSockets · Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).
   - В конструкторе настроено автоматическое эхо пингов на уровне edge без пробуждения объекта: `this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'))` ([Durable Object State · setWebSocketAutoResponse](https://developers.cloudflare.com/durable-objects/api/state/)).
   - Состояние доски хранится в памяти в `Map<string, ExcalidrawElementRecord>` (элементы Excalidraw как есть). При пробуждении объекта в `this.ctx.blockConcurrencyWhile` снимок загружается из таблицы `snapshot`.

3. **Протокол и слияние изменений (`SPEC.md`, раздел 6)**:
   - `hello {client_id, nick}` → обновляет данные участника и отправляет инициатору `snapshot {elements, collaborators}`.
   - `scene_update {elements: [...]}` → выполняет поэлементное слияние и рассылает обновление остальным участникам комнаты (кроме отправителя) с `client_id` и `nick` отправителя.
   - `cursor {x, y, pointer, tool}` → рассылается остальным участникам с `client_id` и `nick` отправителя без записи в SQLite и без взведения флага изменений.
   - Слияние элементов (`shouldReplaceElement`) повторяет логику `reconcileElements` из [Excalidraw (`packages/excalidraw/data/reconcile.ts`)](https://github.com/OpeningDesign/SketchSpace/blob/main/server/src/reconcile.ts): побеждает элемент с большей `version`, а при равной `version` — с меньшим `versionNonce`.
   - Элементы с `isDeleted: true` сохраняются в памяти и снимках как tombstones; при каждом сбросе снимка в SQLite элементы, удалённые более 30 дней назад (`updated < now - 30 дней`), автоматически вычищаются.
   - Некорректный JSON и сообщения с невалидными полями логируются в структурированном JSON и безопасно игнорируются.

4. **Сброс снимков в SQLite по `alarm` и при закрытии последнего соединения (`SPEC.md`, разделы 5 и 8)**:
   - Таблицы `meta (key TEXT PRIMARY KEY, value TEXT)` и `snapshot (chunk_idx INTEGER PRIMARY KEY, data BLOB)` создаются без вторичных индексов ([SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)).
   - Снимок сериализуется в UTF-8 байты JSON `{"v":1,"elements":[...]}` и режется на куски до `900 000` байт (<= 900 КБ). Запись `meta` и всех кусков `snapshot` выполняется одной синхронной транзакцией `this.ctx.storage.transactionSync(...)`, после чего запросом `DELETE FROM snapshot WHERE chunk_idx >= ?` удаляются только лишние старые куски.
   - При первом изменении сцены планировщик ставит [Durable Object Alarm](https://developers.cloudflare.com/durable-objects/api/alarms/) на `now + SAVE_INTERVAL_MS` (`setAlarm` вызывается только один раз на цикл ожидания сброса). При закрытии последнего активного соединения несохранённые изменения сбрасываются в SQLite немедленно.

5. **Лимиты, структурированные логи и smoke-скрипт (`scripts/ws-smoke.mjs`)**:
   - Ограничения: входящее сообщение не более 2 МиБ (`2 097 152` байт); не более 20 соединений на доску (21-е закрывается кодом `1013`); не более 30 сообщений в секунду от одного соединения (лишние отбрасываются со счётчиком `messagesDropped`, при длительном превышении порога в 60 отброшенных сообщений подряд соединение закрывается кодом `1008`).
   - При каждом сбросе снимка (`event: "snapshot_flush"`) и закрытии соединения (`event: "connection_close"`) в `console.log` выводится структурированный JSON с полями `messagesAccepted`, `messagesDropped`, `flushesCount`, `rowsWritten`, `totalRowsWritten`.
   - Добавлен скрипт `scripts/ws-smoke.mjs` (`npm run smoke:ws`), проверяющий подключение двух клиентов, передачу нарисованного элемента от первого ко второму и получение актуального `snapshot` третьим клиентом.

## Таблица «сообщений принято / сбросов / строк записано» из тестов

Ниже приведены фактические показатели из автоматических тестов `worker/test/board.test.ts` и `scripts/ws-smoke.mjs`:

| Сценарий теста | Сообщений принято (`messagesAccepted`) | Отброшено лимитами (`messagesDropped`) | Число сбросов (`flushesCount`) | Записано строк за сброс (`rowsWritten`) | Всего записано строк (`totalRowsWritten`) | Комментарий |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| Серия из 100 `scene_update` за 5 с при `SAVE_INTERVAL_MS=1000` (шаг #1, `t = 1.0 с`) | 20 | 0 | 1 | 3 | 3 | Первичная запись `meta.board_id`, `meta.snapshot_version` и `snapshot[0]` |
| Серия из 100 `scene_update` за 5 с при `SAVE_INTERVAL_MS=1000` (шаг #2, `t = 2.0 с`) | 40 | 0 | 2 | 2 | 5 | Обновление только `meta.snapshot_version` и `snapshot[0]` |
| Серия из 100 `scene_update` за 5 с при `SAVE_INTERVAL_MS=1000` (шаг #3, `t = 3.0 с`) | 60 | 0 | 3 | 2 | 7 | Обновление только `meta.snapshot_version` и `snapshot[0]` |
| Серия из 100 `scene_update` за 5 с при `SAVE_INTERVAL_MS=1000` (шаг #4, `t = 4.0 с`) | 80 | 0 | 4 | 2 | 9 | Обновление только `meta.snapshot_version` и `snapshot[0]` |
| Серия из 100 `scene_update` за 5 с при `SAVE_INTERVAL_MS=1000` (итог, `t = 5.0 с`) | **100** | **0** | **5** | **2** | **11** | 100 обновлений сцены за 5 с дали ровно 5 сбросов (11 строк вместо 200+) |
| Большая сцена > 900 КБ (2 куска) → уменьшение до 1 куска | 2 | 0 | 2 | 4 → 3 | 7 | Сброс #1 записал 2 куска + 2 ключа `meta` (4 строки); сброс #2 перезаписал кусок `0`, обновил `meta.snapshot_version` и удалил лишний кусок `1` (3 строки) |
| Немедленный сброс при закрытии последнего соединения (`scripts/ws-smoke.mjs`, 3 клиента) | 4 | 0 | 1 | 3 | 3 | 3 сообщения `hello` + 1 `scene_update`; сброс выполнен сразу при закрытии 3-го клиента |

## Как проверить (команды)

```bash
# 1. Модульные тесты (включая все тесты комнаты доски T1)
npm run test

# 2. Локальный WebSocket smoke-тест с тремя клиентами
npm run smoke:ws
# (или напрямую: node scripts/ws-smoke.mjs)

# 3. Статические проверки и сборка
npm run check:licenses
npm run typecheck
npm run lint
npm run build
```

## Что проверено / что не проверено

### Что проверено (с выводом команд)

1. **Полный набор модульных тестов (`worker/test/health.test.ts`, `worker/test/licenses.test.ts`, `worker/test/board.test.ts`)**:

```text
SUITE: Worker API and static asset routing
  ✓ GET /api/health returns { ok: true, version } matching package.json
  ✓ POST /api/health returns 405 Method Not Allowed
  ✓ GET /api/unknown returns 404 JSON error
  ✓ Non-API request delegates to ASSETS binding when available
  ✓ resolveSaveIntervalMs defaults to 10000 and clamps to 5000..15000 in prod

SUITE: Dependency license checker (scripts/check-licenses.mjs)
  ✓ allows MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC and compound OR/AND expressions
  ✓ rejects copyleft, source-available, and unknown licenses
  ✓ rejects tldraw and @tldraw/* packages regardless of license
  ✓ loads license-exceptions.json and permits documented transitive exceptions
  ✓ extracts license strings from standard and legacy package.json structures

SUITE: Task T1: Board Room Durable Object and WebSocket Collaboration
  ✓ validates GET /ws/:id?nick=<ник> (22-char base62 id, 1..32 char nick, ALLOW_ANY_BOARD_ID)
  ✓ delivers scene_update and cursor from Client A to Client B without echoing back to A
  ✓ sends snapshot with latest elements and collaborators when a new client sends hello
{"event":"snapshot_flush","boardId":"AbCdEfGhIjKlMnOpQrSt12","reason":"manual","messagesAccepted":4,"messagesDropped":0,"flushesCount":1,"rowsWritten":3,"totalRowsWritten":3,"chunksCount":1,"elementsCount":2,"timestamp":1794114000000}
  ✓ reconciles elements by version and versionNonce (lower versionNonce wins on tie) and prunes 30-day deleted elements on flush
{"event":"snapshot_flush","boardId":"AbCdEfGhIjKlMnOpQrSt12","reason":"alarm","messagesAccepted":1,"messagesDropped":0,"flushesCount":1,"rowsWritten":4,"totalRowsWritten":4,"chunksCount":2,"elementsCount":2,"timestamp":1794133317584}
{"event":"snapshot_flush","boardId":"AbCdEfGhIjKlMnOpQrSt12","reason":"alarm","messagesAccepted":1,"messagesDropped":0,"flushesCount":1,"rowsWritten":3,"totalRowsWritten":3,"chunksCount":1,"elementsCount":2,"timestamp":1794133317584}
  ✓ persists chunked snapshots (<= 900 KB) to SQLite, deletes only extra old chunks, and survives DO recreation
{"event":"connection_close","boardId":"AbCdEfGhIjKlMnOpQrSt12","clientId":null,"nick":"User1","code":1000,"sessionMessagesAccepted":1,"sessionMessagesDropped":0,"messagesAccepted":1,"messagesDropped":0,"flushesCount":0,"lastFlushRowsWritten":0,"totalRowsWritten":0,"activeConnections":1,"timestamp":1794133316607}
{"event":"snapshot_flush","boardId":"AbCdEfGhIjKlMnOpQrSt12","reason":"last_connection_close","messagesAccepted":1,"messagesDropped":0,"flushesCount":1,"rowsWritten":3,"totalRowsWritten":3,"chunksCount":1,"elementsCount":1,"timestamp":1794133316608}
{"event":"connection_close","boardId":"AbCdEfGhIjKlMnOpQrSt12","clientId":null,"nick":"User2","code":1000,"sessionMessagesAccepted":0,"sessionMessagesDropped":0,"messagesAccepted":1,"messagesDropped":0,"flushesCount":1,"lastFlushRowsWritten":3,"totalRowsWritten":3,"activeConnections":0,"timestamp":1794133316608}
  ✓ flushes immediately when the last connection closes
{"event":"connection_rejected_limit","boardId":"AbCdEfGhIjKlMnOpQrSt12","nick":"User21","activeConnections":20,"maxConnections":20,"timestamp":1794133316613}
{"event":"message_rejected_size","boardId":"AbCdEfGhIjKlMnOpQrSt12","clientId":null,"nick":"User1","byteLength":2097741,"maxBytes":2097152,"timestamp":10000}
{"event":"connection_closed_rate_limit","boardId":"AbCdEfGhIjKlMnOpQrSt12","clientId":null,"nick":"User2","messagesDropped":60,"timestamp":50020}
{"event":"connection_close","boardId":"AbCdEfGhIjKlMnOpQrSt12","clientId":null,"nick":"User2","code":1008,"sessionMessagesAccepted":30,"sessionMessagesDropped":60,"messagesAccepted":30,"messagesDropped":61,"flushesCount":0,"lastFlushRowsWritten":0,"totalRowsWritten":0,"activeConnections":19,"timestamp":50020}
  ✓ enforces limits: 2 MB message size, 20 max connections (code 1013), and 30 msg/s rate limit
{"event":"snapshot_flush","boardId":"AbCdEfGhIjKlMnOpQrSt12","reason":"alarm","messagesAccepted":20,"messagesDropped":0,"flushesCount":1,"rowsWritten":3,"totalRowsWritten":3,"chunksCount":1,"elementsCount":1,"timestamp":1001000}
{"event":"snapshot_flush","boardId":"AbCdEfGhIjKlMnOpQrSt12","reason":"alarm","messagesAccepted":40,"messagesDropped":0,"flushesCount":2,"rowsWritten":2,"totalRowsWritten":5,"chunksCount":1,"elementsCount":1,"timestamp":1002000}
{"event":"snapshot_flush","boardId":"AbCdEfGhIjKlMnOpQrSt12","reason":"alarm","messagesAccepted":60,"messagesDropped":0,"flushesCount":3,"rowsWritten":2,"totalRowsWritten":7,"chunksCount":1,"elementsCount":1,"timestamp":1003000}
{"event":"snapshot_flush","boardId":"AbCdEfGhIjKlMnOpQrSt12","reason":"alarm","messagesAccepted":80,"messagesDropped":0,"flushesCount":4,"rowsWritten":2,"totalRowsWritten":9,"chunksCount":1,"elementsCount":1,"timestamp":1004000}
{"event":"snapshot_flush","boardId":"AbCdEfGhIjKlMnOpQrSt12","reason":"alarm","messagesAccepted":100,"messagesDropped":0,"flushesCount":5,"rowsWritten":2,"totalRowsWritten":11,"chunksCount":1,"elementsCount":1,"timestamp":1005000}
  ✓ batches 100 scene_update messages over 5 seconds with SAVE_INTERVAL_MS=1000 into <= 5 flushes

Test Files  3 passed (3)
     Tests  18 passed (18)
```

2. **Скрипт `node scripts/ws-smoke.mjs` и проверка лицензий `npm run check:licenses`**:

```text
=== Running scripts/ws-smoke.mjs ===
[ws-smoke] Запущен локальный сервер проверки: ws://127.0.0.1:45521
[ws-smoke] Клиент 1 (Преподаватель) получил пустой snapshot (элементов: 0).
[ws-smoke] Клиент 2 (Ученик_Анна) подключён (активных участников: 2).
[ws-smoke] Клиент 2 получил scene_update от "Преподаватель" (элемент: rect-lesson-1).
[ws-smoke] Новый Клиент 3 (Ученик_Иван) получил актуальный snapshot (элементов: 1, участников: 3).
{"event":"connection_close","boardId":"SmokeTestBoard12345678","clientId":"smoke-client-3","nick":"Ученик_Иван","code":1000,"sessionMessagesAccepted":1,"sessionMessagesDropped":0,"messagesAccepted":4,"messagesDropped":0,"flushesCount":0,"lastFlushRowsWritten":0,"totalRowsWritten":0,"activeConnections":2,"timestamp":1794133317358}
{"event":"connection_close","boardId":"SmokeTestBoard12345678","clientId":"smoke-client-2","nick":"Ученик_Анна","code":1000,"sessionMessagesAccepted":1,"sessionMessagesDropped":0,"messagesAccepted":4,"messagesDropped":0,"flushesCount":0,"lastFlushRowsWritten":0,"totalRowsWritten":0,"activeConnections":1,"timestamp":1794133317358}
{"event":"snapshot_flush","boardId":"SmokeTestBoard12345678","reason":"last_connection_close","messagesAccepted":4,"messagesDropped":0,"flushesCount":1,"rowsWritten":3,"totalRowsWritten":3,"chunksCount":1,"elementsCount":1,"timestamp":1794133317358}
{"event":"connection_close","boardId":"SmokeTestBoard12345678","clientId":"smoke-client-1","nick":"Преподаватель","code":1000,"sessionMessagesAccepted":2,"sessionMessagesDropped":0,"messagesAccepted":4,"messagesDropped":0,"flushesCount":1,"lastFlushRowsWritten":3,"totalRowsWritten":3,"activeConnections":0,"timestamp":1794133317358}
[ws-smoke] УСПЕШНО: все проверки совместного рисования и получения snapshot пройдены.

=== Running check:licenses ===
> online-board@0.1.0 check:licenses
> node scripts/check-licenses.mjs

[check-licenses] OK — проверено пакетов: 0, исключений в license-exceptions.json: 8. Запрещённых лицензий не обнаружено.
```

### Что не проверено (с причиной)

- **Запуск `wrangler dev` поверх бинарного `workerd` из npm**: в изолированной песочнице без исходящего интернета пакеты `wrangler` и `@cloudflare/vitest-pool-workers` не могут быть скачаны из `registry.npmjs.org`. Для локальной верификации в песочнице использован встроенный в `worker/test/cloudflare-workers-shim.ts` эмулятор SQLite/WebSocket Hibernation и реальный WebSocket-сервер на базе системного пакета `ws` в `scripts/ws-smoke.mjs` (при наличии запущенного `wrangler dev` скрипт `scripts/ws-smoke.mjs` подключается к нему через `WS_SMOKE_URL=ws://127.0.0.1:8787`).

## Новые зависимости (имя, лицензия, зачем)

| Пакет | Пакет монорепо | Лицензия | Зачем нужен |
| :--- | :--- | :--- | :--- |
| [ws](https://www.npmjs.com/package/ws) | root (dev) | `MIT` | WebSocket-клиент и локальный сервер для smoke-скрипта `scripts/ws-smoke.mjs` |

## Допущения и вопросы

1. **Порог закрытия соединения при длительном превышении частоты (`> 30 сообщений/с`)**: одиночные всплески свыше 30 сообщений в секунду отбрасываются и учитываются в `messagesDropped`, а если сумма отброшенных сообщений подряд достигает `60` (`SUSTAINED_RATE_LIMIT_EXCESS_THRESHOLD = 60` без возврата в норму в следующем окне), соединение закрывается с кодом `1008` (`Policy Violation`).
2. **Нижний предел `SAVE_INTERVAL_MS` в тестах**: в продакшене (`ALLOW_ANY_BOARD_ID !== "true"`) интервал `SAVE_INTERVAL_MS` жёстко зажат в диапазоне `5000..15000` мс (согласно разделу 2 `SPEC.md`), а при `ALLOW_ANY_BOARD_ID="true"` (локальная разработка и тесты) разрешён интервал от `50` мс, чтобы автотест с `SAVE_INTERVAL_MS=1000` проверял 5-секундную серию по условию задачи.
3. **Размер куска снимка `MAX_SNAPSHOT_CHUNK_BYTES = 900_000` байт**: выбран порог `900 000` байт (строго `<= 900 КБ` как в десятичных, так и в двоичных килобайтах), нарезка выполняется по байтам UTF-8 (`Uint8Array`), чтобы кириллический текст и JSON-метаданные гарантированно укладывались в лимит строки SQLite Durable Object (2 МБ).

## Замечания вне задачи

- При переходе к задаче **T2** (фронтенд) клиенту достаточно отправлять `{"type":"ping"}` без пробелов (ровно `JSON.stringify({ type: "ping" })`), чтобы срабатывал `setWebSocketAutoResponse` на границе Cloudflare без пробуждения Durable Object; на случай нестандартного форматирования JSON в `webSocketMessage` также оставлен резервный ответ `{"type":"pong"}`.
