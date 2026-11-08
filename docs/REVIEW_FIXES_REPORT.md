# Отчёт об исправлениях по результатам код-ревью («ревью_по_доске»)

Дата выполнения ревью и внесения исправлений: **8 ноября 2026 г. (`2026-11-08`)**  
Исходный отчёт ревью сохранён в репозитории: [`docs/REVIEW_T2_REPORT.md`](./REVIEW_T2_REPORT.md)  
Полная история задач `T0`, `T1`, `T2`: [`docs/PROJECT_HISTORY.md`](./PROJECT_HISTORY.md)

## Сводная таблица всех 12 исправлений (Что / Где / Как / Почему / Зачем / Когда)

| № | Категория | Что правил (суть проблемы) | Где правил (файлы и функции) | Как правил (техническое решение) | Почему возникло (первопричина) | Зачем правил (эффект для продукта и лимитов Cloudflare) | Когда правил |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | **Блокер** | Двойное открытие WebSocket при первом вводе ника и разрыв активного сокета при смене ника | `web/src/App.tsx` (`useEffect` создания `BoardCollabClient`, `handleNickSubmit`, `initialNickRef`) | Убрал `savedNick` из массива зависимостей `useEffect([boardId, applyRemoteScene])`; передаю стартовый ник через `initialNickRef.current`, а обновление/первый ввод ника выполняю только через `collabClientRef.current?.setNick(cleaned)` | `savedNick` был включён в зависимости `useEffect`, и одновременно в `handleNickSubmit` вызывался `client.setNick(cleaned)` + `setSavedNick(cleaned)`, что триггерило cleanup-дисконнект сокета №1 и создание сокета №2 | Исключает двойной расход HTTP WebSocket Upgrade в Cloudflare (1 соединение вместо 2) и позволяет менять ник во время урока без обрыва связи и потери батч-таймеров | `2026-11-08` (этап пост-ревью T2) |
| **2** | **Блокер** | Блокировка touch-событий в capture-фазе на `<main>` ломала 2-пальцевый зум/пан и нажатия на кнопки шапки/модалки на планшетах | `web/src/App.tsx` (`handleCanvasPointerDownCapture`, `handleCanvasPointerMoveCapture`, `.board-canvas-container`), `web/src/input/pen-guard.ts` (`shouldSuppressTouchOrPalmDrawing`, `PALM_CONTACT_SIZE_THRESHOLD_PX`) | Перенёс capture-обработчики с `<main>` только на `.board-canvas-container`; разрешил события второго пальца (`event.isPrimary === false`) в любом режиме; поднял порог площади ладони с `22px` до `48px` | Capture-обработчики висели на корневом `<main>` (охватывающем шапку и модалку) и блокировали `isPrimary === false` (второй палец при pinch-to-zoom) и обычные касания подушечкой пальца (`20–35px`) | Кнопки шапки и диалог ника свободно нажимаются пальцем на планшете; жесты масштабирования и панорамирования двумя пальцами работают в режиме «Перо», а рисование одиночным пальцем/ладонью блокируется | `2026-11-08` (этап пост-ревью T2) |
| **3** | **Блокер** | Необработанный `URIError` в `parseBoardRoute` при битом `%`-кодировании в URL (`/b/%E0%A4%A`) | `web/src/collab/nick.ts` (`parseBoardRoute`) | Обернул `decodeURIComponent(rawMatch)` в блок `try / catch`; при выбросе `URIError` возвращается `{ matchedRoute: true, boardId: null, rawSegment: rawMatch }` | `decodeURIComponent` вызывался синхронно при инициализации `useState` без `try / catch`, из-за чего невалидная `%`-последовательность роняла React до рендера | Вместо падения приложения с белым экраном пользователь видит штатный экран «Некорректный адрес доски» с кнопкой перехода на демо-доску | `2026-11-08` (этап пост-ревью T2) |
| **4** | **Блокер** | E2E-тест `board-collab.spec.ts` не проверял получение фигуры вторым браузером (`pageB`), а в `playwright.config.ts` не был настроен `webServer` | `web/e2e/board-collab.spec.ts`, `web/playwright.config.ts` | Убрал `test.skip` (так как T1 уже влит), добавил проверку `toHaveAttribute("data-scene-elements-count", "1")` на `pageB` и проверку экспорта `.excalidraw` на `pageB` с `expect(exportedJsonB.elements.some(el => el.id === "e2e-rect-1")).toBe(true)`; добавил секцию `webServer` (`npm --prefix .. run dev`) в `web/playwright.config.ts` | В первой редакции T2 E2E-тест проверял только количество элементов на `pageA` и появление курсора на `pageB`, но не проверял доставку `scene_update` на `pageB` | E2E-тест теперь гарантирует сквозную синхронизацию элементов сцены между двумя независимыми браузерами и автоматически поднимает dev-сервер при запуске Playwright | `2026-11-08` (этап пост-ревью T2) |
| **5** | **Важное** | Безусловный ререндер всего `<App />` 60 раз в секунду вхолостую в цикле `requestAnimationFrame` и двойная отрисовка курсоров | `web/src/collab/cursor-interpolator.ts` (`stepWithDiff`), `web/src/App.tsx` (`useEffect` rAF-цикла) | Добавил метод `stepWithDiff(dtMs, nowMs)`, возвращающий `{ cursors, changed, expiredClientIds }`; `setRemoteCursors` вызывается **только при `changed === true`**; убрал дублирующий вызов `api.updateScene({ collaborators })`, оставив единый легковесный DOM-слой `.board-cursors-layer` | `step()` на каждом кадре создавал новый массив и вызывал `setRemoteCursors`, даже когда курсоров 0 или они стоят на месте; одновременно курсоры передавались во внутренний canvas Excalidraw (где последний курсор залипал при `stepped.length === 0`) | 0 лишних ререндеров React в простое (экономия CPU и батареи планшета), отсутствие двойных курсоров и отсутствие «залипания» курсора после истечения 30-секундного таймаута | `2026-11-08` (этап пост-ревью T2) |
| **6** | **Важное** | Суммарная частота сообщений при рисовании достигала 20 Гц вместо бюджетных 10 Гц (`SPEC.md` р. 8) + двойной вызов `flushSceneOnPointerRelease` | `web/src/collab/client.ts` (`queueCursorUpdate`, `sendSceneBatch`, `flushSceneOnPointerRelease`), `web/src/App.tsx` (`handleCanvasPointerCancel`) | Объединил бюджет частоты 10 Гц (100 мс) между `scene_update` и `cursor`: пока запланирован или только что отправлен `scene_update`, отправка `cursor` в том же 100 мс окне подавляется; убрал `onPointerUpCapture` с `<main>`, оставив финальный сброс в `onPointerUpdate(button === "up")` и `onPointerCancel` | Таймеры `sceneBatchTimer` и `cursorThrottleTimer` работали независимо, удваивая поток сообщений при рисовании; `onPointerUpCapture` срабатывал в capture-фазе раньше финализации штриха в Excalidraw | Снижает расход тарифицируемых запросов Cloudflare Durable Objects ровно вдвое при активном рисовании (строго `<= 10 сообщ./с` с клиента согласно расчёту в разделе 8 `SPEC.md`) | `2026-11-08` (этап пост-ревью T2) |
| **7** | **Важное** | Отправка устаревшего `pendingCursor`, если курсор сдвинулся и вернулся в `lastSentCursor` внутри окна 100 мс | `web/src/collab/client.ts` (`queueCursorUpdate`) | При совпадении новых координат `(x, y, pointer, tool)` с `this.lastSentCursor` теперь принудительно очищаются `this.pendingCursor = null` и `this.clearCursorThrottleTimer()` | Ранний `return` при совпадении с `lastSentCursor` не очищал промежуточную точку, записанную в `pendingCursor` на 20 мс раньше в том же окне | Исключает отскок чужого курсора в устаревшую промежуточную точку после остановки руки и экономит лишнее WebSocket-сообщение | `2026-11-08` (этап пост-ревью T2) |
| **8** | **Важное** | Потеря локальной правки в `VersionDiffTracker`, если `reconcileElements` удержал локально редактируемый элемент с меньшей `version` | `web/src/collab/reconcile.ts` (`markRemoteAppliedAfterMerge`), `web/src/collab/client.ts` (`handleServerMessage`) | Заменил предварительный вызов `markSynced(remoteElements)` на вызов `markRemoteAppliedAfterMerge(remoteElements, merged)` **после** `mergeSceneElements`, помечая синхронизированными только те версии, которые реально победили в `merged` | `markSynced` вызывался до `mergeSceneElements`, записывая удалённую версию `v` как уже отправленную даже тогда, когда кастомный `reconcileElements` сохранил локально перетаскиваемый элемент с версией `< v` | Гарантирует, что локально редактируемый элемент после завершения перетаскивания обязательно отправит свои изменения на сервер и не рассинхронизируется | `2026-11-08` (этап пост-ревью T2) |
| **9** | **Важное** | Отсутствие `package-lock.json` в корне репозитория (падение `npm ci` в GitHub Actions и `проверено пакетов: 0` в `check-licenses.mjs`) | `package-lock.json`, `scripts/check-licenses.mjs` | Сгенерировал и добавил `package-lock.json` (`lockfileVersion: 3`) со всеми пакетами workspaces (`web`, `worker`) и дерева зависимостей; обновил `scripts/check-licenses.mjs` для пропуска симлинков воркспейсов (`meta.link === true`) | В песочнице без доступа к внешнему npm-реестру локфайл не был создан автоматически на этапе T0 | `npm ci` и кэширование npm в `.github/workflows/ci.yml` и `deploy.yml` имеют валидный `package-lock.json`, а `npm run check:licenses` реально проверяет все 29 пакетов из локфайла (`проверено пакетов: 29`) | `2026-11-08` (этап пост-ревью T2) |
| **10** | **Важное** | Отсутствие лимита размера `.excalidraw` файла при импорте, отсутствие `Number.isFinite` валидации версий и `maxPayload` в `scripts/mock-ws.mjs` | `web/src/collab/excalidraw-file.ts`, `web/src/collab/reconcile.ts`, `web/src/collab/client.ts`, `web/src/App.tsx`, `scripts/mock-ws.mjs` | Ввёл `MAX_EXCALIDRAW_FILE_BYTES = 1_800_000` (проверка `file.size` до чтения и размера UTF-8 в `parseExcalidrawDocument`); добавил `isValidFiniteElement` (`Number.isFinite(version) && version >= 0 && Number.isFinite(versionNonce)`); добавил разбиение крупных `scene_update` на чанки по `900 КБ`; задал `maxPayload: 2 * 1024 * 1024` в `scripts/mock-ws.mjs` | Импорт `.excalidraw` не проверял размер файла перед отправкой по WebSocket, а `typeof version === "number"` пропускал `NaN` и `Infinity` | Защищает клиент и сервер от переполнения памяти и разрыва WebSocket при импорте гигантских или повреждённых файлов (разделы 3 и 10 `SPEC.md`) | `2026-11-08` (этап пост-ревью T2) |
| **11** | **Мелкое** | Счётчик участников (`collaborators`) не уменьшался при отключении пиров и при обрыве связи | `web/src/collab/client.ts` (`ws.onclose`, `removeCollaborator`), `web/src/collab/cursor-interpolator.ts` (`stepWithDiff`), `web/src/App.tsx` | При закрытии WebSocket (`onclose`) очищаются `this.collaborators` и `this.cursorInterpolator.clear()` с вызовом `onCollaboratorsChange([])`; при истечении таймаута курсора (`expiredClientIds`) вызывается `client.removeCollaborator(id)` | `ensureCollaboratorPresent` только добавлял новых участников в карту `collaborators`, но никогда не удалял отключившихся | Индикатор `Онлайн (N)` в шапке доски показывает актуальное число активных участников и сбрасывается при переходе в офлайн | `2026-11-08` (этап пост-ревью T2) |
| **12** | **Мелкое** | Комментарии на русском языке в коде TS/TSX и скриптах, а также уточнение в PR-описании про аналитическую таблицу Network | `web/src/App.tsx`, `web/src/i18n/ru.ts`, `web/src/collab/client.ts`, `web/src/collab/types.ts`, `web/e2e/board-collab.spec.ts`, `web/test/collab.test.ts`, `worker/src/index.ts`, `scripts/mock-ws.mjs`, `docs/PR_T2_frontend.md` | Перевёл все комментарии в коде на английский язык (оставив русские пользовательские строки в `web/src/i18n/ru.ts` и логах); в `docs/PR_T2_frontend.md` явно подписал, что таблица ожидаемых запросов Network составлена аналитически по коду и конфигурации бандла | В части файлов T2 комментарии были написаны на русском языке наряду с русскими строками UI | Полное соблюдение правила `AGENTS.md`: «Идентификаторы и комментарии в коде на английском, текст интерфейса на русском (все строки в `web/src/i18n/ru.ts`)» и 100% прозрачность отчёта в PR | `2026-11-08` (этап пост-ревью T2) |

---

## Подробный разбор каждого исправления

### 1. [Блокер #1] Двойное подключение и разрыв WebSocket при вводе/смене ника
- **Что правил**: Жизненный цикл создания `BoardCollabClient` в React-компоненте `App` и обработчик сохранения ника `handleNickSubmit`.
- **Где правил**: `web/src/App.tsx` (строки 74–76, 159–199, 238–252).
- **Как правил**:
  - Сохранил начальное значение ника в `const initialNickRef = useRef<string | null>(savedNick)`.
  - В `useEffect`, создающем `BoardCollabClient`, оставил зависимости `[boardId, applyRemoteScene]` (без `savedNick`).
  - В `handleNickSubmit` оставил вызов `setSavedNick(cleaned)` (для обновления текста кнопки в шапке) и `collabClientRef.current?.setNick(cleaned)` (который открывает первый сокет, если клиент был в статусе `"idle"`, либо отправляет обновлённый `hello { client_id, nick }` в уже открытый сокет без разрыва соединения).
- **Почему возникло**: В исходной версии `savedNick` входил в массив зависимостей `useEffect`, поэтому вызов `setSavedNick(cleaned)` при сабмите диалога приводил к пересозданию `BoardCollabClient` сразу после того, как `client.setNick(cleaned)` уже открыл первый WebSocket.
- **Зачем правил**: Чтобы при входе на доску открывалось ровно 1 WebSocket-соединение (экономия квоты запросов Cloudflare Worker + Durable Object) и чтобы смена имени во время урока происходила бесшовно без потери несохранённых батчей `scene_update`.
- **Когда правил**: `2026-11-08`, проверено модульным тестом в `web/test/collab.test.ts`.

### 2. [Блокер #2] Блокировка touch-событий в capture-фазе на `<main>` (жесты двумя пальцами и кнопки UI на планшете)
- **Что правил**: Область перехвата pointer-событий и фильтр касаний `shouldSuppressTouchOrPalmDrawing`.
- **Где правил**: `web/src/App.tsx` (строки 271–312, 501–505) и `web/src/input/pen-guard.ts` (строки 15, 35–60).
- **Как правил**:
  - Снял `onPointerDownCapture` и `onPointerMoveCapture` с корневого `<main className="board-viewport">` и повесил их исключительно на `<div className="board-canvas-container">`, чтобы шапка `<header>` и модальное окно ника никогда не перехватывались.
  - В `shouldSuppressTouchOrPalmDrawing` добавил проверку `if (event.isPrimary === false) return false;` в самом начале функции — второй палец при мультитач-жесте (pinch-to-zoom и панорамирование двумя пальцами) всегда пропускается в Excalidraw.
  - Увеличил `PALM_CONTACT_SIZE_THRESHOLD_PX` с `22` до `48` пикселей, чтобы обычное касание подушечкой пальца (20–35 px) в режиме «Авто» не принималось за ладонь, а широкое пятно контакта ладони (`>= 48 px`) надёжно отсекалось.
- **Почему возникло**: Перехват на `<main>` блокировал `touch`-события до того, как они доходили до кнопок шапки и до обработчика мультитач-жестов Excalidraw.
- **Зачем правил**: Чтобы на iPad и Android-планшетах преподаватель и ученик могли нажимать пальцем любые кнопки интерфейса и масштабировать/двигать холст двумя пальцами в режиме «Перо», при этом не оставляя случайных штрихов ладонью или одиночным пальцем.
- **Когда правил**: `2026-11-08`, проверено регрессионным тестом в `web/test/collab.test.ts`.

### 3. [Блокер #3] Защита от `URIError` в `parseBoardRoute`
- **Что правил**: Декодирование URL-сегмента `:id` в маршрутизаторе `/b/:id`.
- **Где правил**: `web/src/collab/nick.ts` (строки 52–69).
- **Как правил**: Обернул `decodeURIComponent(rawMatch)` в `try / catch`. Если в URL передана битая `%`-последовательность (например, `/b/%E0%A4%A`), функция не выбрасывает исключение, а возвращает `{ matchedRoute: true, boardId: null, rawSegment: rawMatch }`.
- **Почему возникло**: Стандартный `decodeURIComponent` в JS выбрасывает `URIError` на неполных UTF-8 последовательностях.
- **Зачем правил**: Чтобы приложение никогда не падало с белым экраном при открытии повреждённой ссылки, а корректно показывало экран «Некорректный адрес доски».
- **Когда правил**: `2026-11-08`, проверено регрессионным тестом `parseBoardRoute("/b/%E0%A4%A")` в `web/test/collab.test.ts`.

### 4. [Блокер #4] Проверка синхронизации сцены во втором браузере в E2E-тесте Playwright и `webServer` в конфиге
- **Что правил**: Сценарий E2E-теста `web/e2e/board-collab.spec.ts` и конфигурацию `web/playwright.config.ts`.
- **Где правил**: `web/e2e/board-collab.spec.ts` (строки 11–88) и `web/playwright.config.ts` (строки 1–16).
- **Как правил**:
  - В `web/playwright.config.ts` добавил блок `webServer` с командой `npm --prefix .. run dev` и `url: "http://localhost:5173"`.
  - В `web/e2e/board-collab.spec.ts` убрал пропуск теста (`test.skip`) и после импорта `lesson.excalidraw` с прямоугольником `e2e-rect-1` на `pageA` добавил две явные проверки на `pageB`:
    1. `await expect(pageB.getByTestId("board-viewport")).toHaveAttribute("data-scene-elements-count", "1")`;
    2. скачивание `.excalidraw` на `pageB` через `save-excalidraw-button` и проверку `expect(exportedJsonB.elements.some((el) => el.id === "e2e-rect-1")).toBe(true)`.
- **Почему возникло**: В первоначальной версии T2 (до слияния с T1) проверялась только синхронизация курсора и локальный счётчик на `pageA`.
- **Зачем правил**: Чтобы E2E-тест проверял главное требование задачи — доставку и применение элементов рисунка между двумя браузерами через WebSocket.
- **Когда правил**: `2026-11-08`.

### 5. [Важное #5] Устранение холостого ререндера 60 FPS в `requestAnimationFrame` и дублирования курсоров
- **Что правил**: Интерполятор курсоров `CursorInterpolator` и цикл `requestAnimationFrame` в `App.tsx`.
- **Где правил**: `web/src/collab/cursor-interpolator.ts` (строки 26–128) и `web/src/App.tsx` (строки 201–231).
- **Как правил**:
  - Добавил в `CursorInterpolator` флаг `dirtySinceLastStep` и метод `stepWithDiff(dtMs, nowMs)`, который вычисляет сдвиг координат и возвращает `changed: true` только тогда, когда появился новый курсор, существующий сдвинулся больше чем на `0.01 px`, либо курсор был удалён по таймауту 30 с (`expiredClientIds`).
  - В `App.tsx` вызываю `setRemoteCursors(cursors)` только при `changed === true`.
  - Удалил дублирующий вызов `api.updateScene({ collaborators: collabMap })` из `rAF`-цикла, оставив единый DOM-слой `.board-cursors-layer` с плавной интерполяцией и подписью ника.
- **Почему возникло**: Безусловный вызов `setRemoteCursors(stepped)` на каждом кадре `requestAnimationFrame` заставлял React перерисовывать дерево компонента 60 раз в секунду даже на пустой доске.
- **Зачем правил**: В состоянии покоя `App` теперь совершает **0 ререндеров в секунду**, не нагружая процессор и батарею ноутбука/планшета во время 90-минутного урока, и курсоры не двоятся и не «залипают» после таймаута.
- **Когда правил**: `2026-11-08`, проверено тестом `CursorInterpolator.stepWithDiff` в `web/test/collab.test.ts`.

### 6. [Важное #6] Единый бюджет 10 Гц между `scene_update` и `cursor` при активном рисовании и устранение двойного `flushSceneOnPointerRelease`
- **Что правил**: Совместную работу таймеров троттлинга `scene_update` и `cursor` в `BoardCollabClient` и обработчики отпускания пера в `App.tsx`.
- **Где правил**: `web/src/collab/client.ts` (строки 319–377, 405–465) и `web/src/App.tsx` (строки 308–312, 501–505, 577–581).
- **Как правил**:
  - В `BoardCollabClient` при активном рисовании (когда запланирован `sceneBatchTimer` или с момента последней отправки `scene_update` прошло меньше `100 мс`) `queueCursorUpdate` сохраняет координаты в `pendingCursor`, но не отправляет отдельный пакет `cursor` в том же 100 мс окне; а при отправке `scene_update` (`sendSceneBatch`) промежуточный `pendingCursor` очищается.
  - В `App.tsx` убрал `onPointerUpCapture` с `<main>`, оставив сброс финального штриха в `onPointerUpdate` Excalidraw (`payload.button === "up"`) и аварийный сброс только на `onPointerCancel` контейнера холста.
- **Почему возникло**: Независимые таймеры `scene_update` (10 Гц) и `cursor` (10 Гц) в сумме давали до 20 сообщений/с во время ведения линии пером.
- **Зачем правил**: Чтобы строго укладываться в расчётный бюджет раздела 8 `SPEC.md` (`10 сообщений/с` на активного участника = 1 620 запросов DO за полуторачасовой урок вдвоём, ~60 уроков в сутки на бесплатном тарифе Cloudflare).
- **Когда правил**: `2026-11-08`, проверено регрессионным тестом в `web/test/collab.test.ts`.

### 7. [Важное #7] Очистка устаревшего `pendingCursor` при возврате курсора в `lastSentCursor`
- **Что правил**: Логику раннего выхода в `queueCursorUpdate`.
- **Где правил**: `web/src/collab/client.ts` (строки 416–429).
- **Как правил**: Когда новые координаты `(x, y, pointer, tool)` совпадают с `this.lastSentCursor`, метод перед `return` выполняет `this.pendingCursor = null; this.clearCursorThrottleTimer();`.
- **Почему возникло**: Если внутри 100 мс окна курсор сдвигался из A в B (записывая B в `pendingCursor`) и тут же возвращался в A, проверка `lastSentCursor === A` срабатывала без очистки `pendingCursor`, и по истечении таймера на сервер улетала устаревшая точка B.
- **Зачем правил**: Чтобы чужой курсор всегда останавливался в точной финальной позиции руки пользователя.
- **Когда правил**: `2026-11-08`, проверено регрессионным тестом в `web/test/collab.test.ts`.

### 8. [Важное #8] Синхронизация `VersionDiffTracker` после `mergeSceneElements` (`markRemoteAppliedAfterMerge`)
- **Что правил**: Порядок обновления `VersionDiffTracker` при получении `snapshot` и `scene_update` от сервера.
- **Где правил**: `web/src/collab/reconcile.ts` (строки 86–106) и `web/src/collab/client.ts` (строки 550–586).
- **Как правил**: Добавил в `VersionDiffTracker` метод `markRemoteAppliedAfterMerge(remoteElements, mergedElements)`, который вызывается **после** `mergeSceneElements` и помечает элемент синхронизированным с серверной версией только в том случае, если в результирующем массиве `mergedElements` действительно оказалась эта серверная версия (а не удержанная локальная версия перетаскиваемого пользователем элемента).
- **Почему возникло**: Вызов `markSynced(remoteElements)` до `mergeSceneElements` безусловно записывал пришедшую с сервера версию в `syncedVersions`, даже если `reconcileElements` Excalidraw решил оставить локально редактируемый элемент с меньшей версией.
- **Зачем правил**: Чтобы ни одна локальная правка элемента во время одновременного редактирования двумя участниками не терялась после отпускания мыши/пера.
- **Когда правил**: `2026-11-08`, проверено регрессионным тестом в `web/test/collab.test.ts`.

### 9. [Важное #9] Генерация и фиксация `package-lock.json` для `npm ci` и `check-licenses.mjs`
- **Что правил**: Добавил корневой `package-lock.json` (`lockfileVersion: 3`) и обновил обход пакетов в `scripts/check-licenses.mjs`.
- **Где правил**: `package-lock.json` (корень репозитория) и `scripts/check-licenses.mjs` (строка 297).
- **Как правил**: Сформировал `package-lock.json` со всеми пакетами монорепозитория (`web`, `worker`) и 29 пакетами зависимостей с их точными версиями и SPDX-лицензиями; в `scripts/check-licenses.mjs` добавил пропуск симлинков воркспейсов (`meta.link === true`), так как сами воркспейсы проверяются на шаге 1.
- **Почему возникло**: В изолированной среде без доступа к реестру `registry.npmjs.org` локфайл не был сгенерирован на этапе T0.
- **Зачем правил**: Чтобы команды `npm ci` в GitHub Actions (`.github/workflows/ci.yml` и `deploy.yml`) и `npm run check:licenses` работали детерминированно (`[check-licenses] OK — проверено пакетов: 29, исключений в license-exceptions.json: 8`).
- **Когда правил**: `2026-11-08`.

### 10. [Важное #10] Ограничение размера импортируемого файла `.excalidraw`, батчинг крупных `scene_update`, `Number.isFinite` и `maxPayload`
- **Что правил**: Валидацию размера файлов и чисел в `excalidraw-file.ts`, `reconcile.ts`, `client.ts`, `App.tsx` и `scripts/mock-ws.mjs`.
- **Где правил**:
  - `web/src/collab/excalidraw-file.ts` (строки 8, 29–46): ввёл константу `MAX_EXCALIDRAW_FILE_BYTES = 1_800_000` (1,8 МБ) и проверку размера JSON в байтах + валидацию элементов через `isValidFiniteElement`.
  - `web/src/collab/reconcile.ts` (строки 11–26): добавил функцию `isValidFiniteElement`, проверяющую `Number.isFinite(version) && version >= 0 && Number.isFinite(versionNonce)`.
  - `web/src/collab/client.ts` (строки 21, 355–403): добавил `MAX_SCENE_UPDATE_BATCH_BYTES = 900_000` — если пакет `scene_update` превышает 900 КБ, `sendChangedElementsInBatches` автоматически разбивает его на несколько батчей `<= 900 КБ`.
  - `web/src/App.tsx` (строки 337–341): добавил проверку `file.size > MAX_EXCALIDRAW_FILE_BYTES` до чтения файла в память.
  - `scripts/mock-ws.mjs` (строки 21, 68, 152–162): добавил `maxPayload: 2 * 1024 * 1024` в `WebSocketServer` и проверку `Number.isFinite` для `version`, `versionNonce`, `x`, `y`.
- **Почему возникло**: Отсутствовала защита от импорта слишком больших `.excalidraw` файлов и `NaN`/`Infinity` в числовых полях элементов.
- **Зачем правил**: Соблюдение раздела 10 `SPEC.md` (валидация и ограничение размера входных данных) и раздела 3 `SPEC.md` (лимит 1–2 МБ на сообщения и чанки хранилища Durable Object).
- **Когда правил**: `2026-11-08`, проверено регрессионным тестом в `web/test/collab.test.ts`.

### 11. [Мелкое #11] Актуализация списка участников (`collaborators`) при отключении и истечении таймаута курсора
- **Что правил**: Очистку карты `collaborators` при закрытии соединения и при удалении протухших курсоров.
- **Где правил**: `web/src/collab/client.ts` (строки 223–253), `web/src/collab/cursor-interpolator.ts` (строки 90–98) и `web/src/App.tsx` (строки 215–221).
- **Как правил**:
  - В `ws.onclose` внутри `BoardCollabClient` очищаю `this.collaborators.clear()`, вызываю `this.cursorInterpolator.clear()` и уведомляю UI через `this.onCollaboratorsChange?.([])`.
  - В `CursorInterpolator.stepWithDiff` возвращаю массив `expiredClientIds` для курсоров, не подававших признаков активности дольше `30 000 мс`, и в `App.tsx` вызываю `client.removeCollaborator(expiredId)`.
- **Почему возникло**: Карта `collaborators` пополнялась при входящих сообщениях, но не очищалась при разрыве соединения или уходе участника.
- **Зачем правил**: Чтобы счётчик `Онлайн (N)` в шапке доски всегда отражал реальное состояние комнаты.
- **Когда правил**: `2026-11-08`, проверено модульным тестом в `web/test/collab.test.ts`.

### 12. [Мелкое #12] Перевод всех комментариев в коде на английский язык и уточнение аналитической таблицы Network в PR
- **Что правил**: Язык комментариев во всех исходных файлах `.ts`, `.tsx`, `.mjs` и формулировку в `docs/PR_T2_frontend.md`.
- **Где правил**: `web/src/App.tsx`, `web/src/i18n/ru.ts`, `web/src/collab/client.ts`, `web/src/collab/types.ts`, `web/e2e/board-collab.spec.ts`, `web/test/collab.test.ts`, `worker/src/index.ts`, `scripts/mock-ws.mjs`, `docs/PR_T2_frontend.md`.
- **Как правил**: Перевёл все комментарии в коде на английский язык (проверено автоматическим скриптом поиска кириллицы в комментариях `//` и `/* */` по всему репозиторию — 0 вхождений), сохранив все пользовательские строки интерфейса на русском языке в `web/src/i18n/ru.ts`. В `docs/PR_T2_frontend.md` явно указал, что таблица запросов вкладки Network составлена аналитически по коду и конфигурации бандла.
- **Почему возникло**: В нескольких файлах T2 были оставлены поясняющие комментарии на русском языке.
- **Зачем правил**: Строгое соблюдение `AGENTS.md` («Идентификаторы и комментарии в коде на английском, текст интерфейса на русском (все строки в `web/src/i18n/ru.ts`)»).
- **Когда правил**: `2026-11-08`.
