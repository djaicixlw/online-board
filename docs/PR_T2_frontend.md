# T2: Фронтенд доски (`/b/:id`, WebSocket-клиент `collab`, курсоры с интерполяцией, режим пера, экспорт)

Ветка: `task/T2-frontend` → `main` (обновлено с учётом всех 12 пунктов код-ревью, см. [`docs/REVIEW_FIXES_REPORT.md`](./REVIEW_FIXES_REPORT.md))

## Что сделано

1. **Маршрут `/b/:id` и полноэкранный холст Excalidraw (`web/src/App.tsx`, `web/src/collab/nick.ts`)**:
   - Реализован разбор маршрута `/b/:id` (`parseBoardRoute`) с проверкой 22-символьного `base62` идентификатора доски (`^[0-9A-Za-z]{22}$`) и защитой `try / catch` вокруг `decodeURIComponent` от `URIError` при некорректном `%`-кодировании. При заходе на корень `/` выполняется переход на сгенерированный адрес `/b/<22-символа>`, а при некорректном ID выводится русскоязычный экран ошибки с кнопкой открытия новой доски.
   - Холст [@excalidraw/excalidraw](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation) развёрнут на весь экран (`100vw × 100vh`) с русским интерфейсом (`langCode="ru-RU"`).

2. **Диалог ввода и смены ника (`localStorage["board.nick"]`)**:
   - При первом входе (если ключ `board.nick` в `localStorage` отсутствует или некорректен) открывается модальный диалог «Как вас зовут на доске?» (`1–32` символа, без управляющих символов).
   - Пока ник не задан, WebSocket-соединение не открывается (`status = "idle"`).
   - Клиент `BoardCollabClient` инициализируется один раз на `boardId` (начальный ник передаётся через `initialNickRef`), а при сабмите диалога вызывается `collabClientRef.current?.setNick(cleaned)` — это открывает ровно одно соединение при первом входе и штатно отправляет обновлённый `hello {client_id, nick}` при смене имени без разрыва активного WebSocket.

3. **Модуль совместной работы `web/src/collab/` и мок-сервер `scripts/mock-ws.mjs`**:
   - При открытии сокета `/ws/:id?nick=...` отправляется `hello {client_id, nick}`. Входящий `snapshot {elements, collaborators}` сливается с локальной сценой через `mergeSceneElements` + `reconcileElements` ([Excalidraw Reconciliation](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/App.tsx)) и применяется через `updateScene` с `CaptureUpdateAction.NEVER` ([Releases · excalidraw/excalidraw](https://github.com/excalidraw/excalidraw/releases)).
   - Отслеживание версий (`VersionDiffTracker` в `web/src/collab/reconcile.ts`): на сервер отправляются **только изменённые элементы** (`version` выше последней синхронизированной или меньший `versionNonce` при равной `version`). При входящем `snapshot` или `scene_update` вызывается `markRemoteAppliedAfterMerge(remoteElements, merged)` **после** `mergeSceneElements`, чтобы локально редактируемые элементы с меньшей версией не теряли последующую отправку.
   - Батчинг `scene_update` и `cursor` объединён общим бюджетом не более **10 Гц (`100` мс)**: во время активного рисования каждые 100 мс уходят промежуточные `scene_update` (при этом дублирующие `cursor` в том же 100 мс окне подавляются, чтобы суммарный поток от одного клиента не превышал 10 сообщений/с по разделу 8 `SPEC.md`), а при отпускании пера/мыши (`onPointerUpdate(button === "up")` или `onPointerCancel`) вызывается `flushSceneOnPointerRelease`. Крупные пакеты `scene_update` автоматически разбиваются на чанки до `900 КБ`.
   - При возврате курсора в точку `lastSentCursor` внутри 100 мс окна троттлинга `pendingCursor` и таймер очищаются.
   - Каждые **30 секунд** отправляется точная строка `'{"type":"ping"}'` (совместимая с `setWebSocketAutoResponse` из задачи T1).
   - Чужие курсоры (`CursorInterpolator.stepWithDiff` в `web/src/collab/cursor-interpolator.ts`) плавно интерполируются по экспоненциальному закону (`tau = 45` мс) и вызывают обновление состояния React только при реальном движении/изменении (`changed === true`), обеспечивая **0 холостых ререндеров в секунду** в состоянии покоя.
   - Переподключение при обрыве связи выполняется с нарастающей паузой **`1, 2, 4, 8, 15` секунд** (`RECONNECT_BACKOFF_MS`). При закрытии соединения или истечении таймаута курсора список `collaborators` синхронно очищается/обновляется.
   - Плашка состояния (`data-testid="connection-status-banner"`): отображает «Подключение…», «Нет связи, рисуем локально» и «Доска заполнена» (при закрытии сокета кодом `1013` автоматическое переподключение останавливается).

4. **Режим пера (стилуса), защита от ладони и экспорт (`web/src/input/pen-guard.ts`, `web/src/collab/excalidraw-file.ts`)**:
   - По умолчанию включён режим пера (`penMode: true`, `penDetected: true` в `initialData.appState` и переключатель «Режим пера: вкл / авто» в верхней панели). Перехватчик `shouldSuppressTouchOrPalmDrawing` повешен только на контейнер холста `.board-canvas-container` (не затрагивая шапку и модальное окно), пропускает второй палец (`event.isPrimary === false`) для жестов двупальцевого зума и панорамирования и блокирует широкие касания ладонью (`width >= 48 px` или `height >= 48 px`).
   - В `initialData.appState` включена опция `exportEmbedScene: true` ([Excalidraw types & exportEmbedScene](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/types.ts)). Кнопки «Сохранить .excalidraw» / «Открыть .excalidraw» проверяют максимальный размер файла (`MAX_EXCALIDRAW_FILE_BYTES = 1_800_000` байт) и конечность чисел (`Number.isFinite`).
   - Все строки пользовательского интерфейса вынесены в `web/src/i18n/ru.ts`, все комментарии в коде написаны на английском языке согласно `AGENTS.md`.

## Аналитическая таблица ожидаемых запросов во вкладке Network (отсутствие внешних ресурсов)

> **Примечание**: таблица ниже составлена аналитически на основе разбора HTML-шаблона `web/index.html`, настройки `window.EXCALIDRAW_ASSET_PATH = "/"` в `web/src/main.tsx`, скрипта локального копирования шрифтов `web/scripts/copy-excalidraw-assets.mjs` и `Content-Security-Policy` (`default-src 'self'; font-src 'self' data:; connect-src 'self' ws: wss:; ...`).

| №   | Ожидаемый URL запроса                                           | Тип ресурса        | Источник / Ожидаемый статус                                        |
| --- | --------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------ |
| 1   | `GET /b/<22-char-id>`                                           | `document` (HTML)  | Свой бандл (`self`, `200 OK`)                                      |
| 2   | `data:image/svg+xml,...`                                        | `favicon` (SVG)    | Встроенный `data:` URI (без сетевого запроса)                      |
| 3   | `GET /src/main.tsx` (в dev) / `GET /assets/index-*.js` (в prod) | `script` (JS)      | Свой бандл (`self`, `200 OK`)                                      |
| 4   | `GET /assets/index-*.css`                                       | `stylesheet` (CSS) | Свой бандл (`self`, `200 OK`)                                      |
| 5   | `GET /fonts/*.woff2`                                            | `font` (Woff2)     | Локальная папка `/fonts/` из `web/public/fonts` (`self`, `200 OK`) |
| 6   | `GET /ws/<22-char-id>?nick=...`                                 | `websocket` (WS)   | Свой сервер (`ws://localhost:8787`, `101 Switching Protocols`)     |

Внешних запросов к CDN (`esm.run`, `unpkg.com`, `fonts.googleapis.com`) или сторонней аналитике: **0** (любые внешние запросы дополнительно заблокированы директивой `Content-Security-Policy`).

## Что владельцу проверить руками на планшете со стилусом

1. Откройте доску `/b/AbCdEfGhIjKlMnOpQrSt12` на планшете (iPad со стилусом Apple Pencil или Android/Windows-планшет с активным пером) и убедитесь, что в правом верхнем углу горит индикатор **«Режим пера: вкл»**, а кнопки в верхней шапке («Сменить имя», «Сохранить .excalidraw») свободно нажимаются пальцем.
2. Положите ладонь на экран и проведите линию стилусом (`pointerType === "pen"`): линия от пера должна рисоваться плавно без задержек, а опора ладони и одиночные касания пальцем по холсту (`pointerType === "touch"`, `isPrimary === true`) не должны оставлять точек или штрихов.
3. Проверьте жесты двумя пальцами (масштабирование щипком и панорамирование холста): поскольку события второго пальца (`isPrimary === false`) не блокируются `pen-guard`, холст должен плавно двигаться и масштабироваться двумя пальцами.
4. Переключите кнопку в режим **«Режим пера: авто»**: рисование одним пальцем (`20–35 px`) станет доступным, широкое касание ладонью (`>= 48 px`) будет отсекаться, а при первом касании экрана стилусом приложение автоматически вернётся в режим пера.

## Как проверить (команды)

```bash
# 1. Модульные и регрессионные тесты (worker + web)
npm run test

# 2. Дымовой тест WebSocket (3 клиента против Durable Object Board)
npm run smoke:ws

# 3. Запуск автономного мок-сервера WebSocket
npm run mock:ws

# 4. Локальный запуск фронтенда и воркера
npm run dev

# 5. Проверки лицензий (по package-lock.json), типов, линтера и сборки
npm run check:licenses
npm run typecheck
npm run lint
npm run build

# 6. E2E-тест Playwright (проверяет синхронизацию элемента e2e-rect-1 между pageA и pageB)
npm run test:e2e
```

## Что проверено / что не проверено

### Что проверено (с выводом команд)

1. **Проверка лицензий по `package-lock.json` (`scripts/check-licenses.mjs`), дымовой тест `scripts/ws-smoke.mjs` и модульные/регрессионные тесты `web/test/collab.test.ts` + `worker/test/*.test.ts`**:

```text
[check-licenses] OK — проверено пакетов: 29, исключений в license-exceptions.json: 8. Запрещённых лицензий не обнаружено.

[ws-smoke] Запущен локальный сервер проверки: ws://127.0.0.1:33945
[ws-smoke] Клиент 1 (Преподаватель) получил пустой snapshot (элементов: 0).
[ws-smoke] Клиент 2 (Ученик_Анна) подключён (активных участников: 2).
[ws-smoke] Клиент 2 получил scene_update от "Преподаватель" (элемент: rect-lesson-1).
[ws-smoke] Новый Клиент 3 (Ученик_Иван) получил актуальный snapshot (элементов: 1, участников: 3).
[ws-smoke] УСПЕШНО: все проверки совместного рисования и получения snapshot пройдены.

SUITE: Task T2: Collab Module (throttling, batching, version diff, reconnect, cursors)
  ✓ does not open WebSocket connection without a valid nickname and persists board.nick in localStorage
  ✓ diffs elements by version & versionNonce and batches scene_update at most 10 Hz (100 ms), flushing final state on pointer release
  ✓ throttles cursor updates to 10 Hz (100 ms), skips unchanged coordinates, and sends exact ping every 30s
  ✓ reconnects with exponential backoff (1, 2, 4, 8, 15s), preserves local edits while offline, and stops on 1013 (board full)
  ✓ verifies review fixes: URIError safety (#3), multi-touch pinch/palm guard (#2), idle cursor diff (#5), unified 10Hz budget (#6), reconcile tracker (#8), and file size limits (#10)
ALL 5 COLLAB TESTS PASSED!
```

### Что не проверено (с причиной)

- **Ввод физическим стилусом и касание ладонью на реальном планшете / в Safari**: в среде исполнения отсутствует физический тач-экран со стилусом и macOS/Safari; логика фильтрации событий `PointerEvent` (`pointerType: "pen" | "touch" | "mouse"`, пропуск `isPrimary === false` для двупальцевого зума и порог площади контакта ладони `48 px`) покрыта модульными тестами, а сценарий ручной проверки на планшете вынесен выше.
- **Прогон браузерного бинарника Chromium в Playwright (`npm run test:e2e`)**: в песочнице отключён доступ в интернет для скачивания браузерных бинарников Playwright и внешних пакетов из `registry.npmjs.org`; синтаксис и строгая типизация `web/e2e/board-collab.spec.ts` и `web/playwright.config.ts` проверены компилятором, а синхронизация WebSocket проверена живым скриптом `scripts/ws-smoke.mjs` и модульными тестами.

## Новые зависимости (имя, лицензия, зачем)

| Пакет                                                              | Пакет монорепо | Лицензия     | Зачем нужен                                                                                         |
| ------------------------------------------------------------------ | -------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| [@playwright/test](https://www.npmjs.com/package/@playwright/test) | `web` (dev)    | `Apache-2.0` | E2E-тест синхронного рисования двух браузеров (`web/e2e/board-collab.spec.ts`) по условию задачи T2 |
| [ws](https://www.npmjs.com/package/ws)                             | root (dev)     | `MIT`        | Работа мок-сервера `scripts/mock-ws.mjs` и дымового теста `scripts/ws-smoke.mjs`                    |
