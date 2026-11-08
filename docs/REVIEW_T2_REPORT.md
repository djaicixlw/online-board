# Отчёты код-ревью по проекту «Онлайн-доска для уроков» (итерации 1 и 2)

> Документ содержит полный текст обоих проведённых код-ревью: **Итерация 1** («ревью_по_доске», 12 замечаний) и **Итерация 2** (повторное ревью обновлённого архива `T0 + T1 + T2`, 5 замечаний). Подробный отчёт о том, что, где, как, почему, зачем и когда было исправлено по обоим ревью, находится в файле [`docs/REVIEW_FIXES_REPORT.md`](./REVIEW_FIXES_REPORT.md).

---

## Итерация 2 — Повторное ревью обновлённого архива (T0 + T1 + T2 + фиксы ревью)

**Вердикт по обновлённому архиву (T0 + T1 + T2 + фиксы ревью): почти готово, но нужны 3 быстрые правки (регрессии коммита `95cc90a`) перед слиянием**

Архитектура T0, серверная комната T1 (`worker/src/board.ts`) и логика всех 12 исправлений по T2 сделаны отлично: все 23 модульных и интеграционных теста (`health`, `licenses`, `board`, `collab`) и дымовой тест `scripts/ws-smoke.mjs` проходят, а `check-licenses.mjs` теперь реально проверяет все 29 пакетов из `package-lock.json`. Однако в коммите `95cc90a` при правке `ru.ts`, `collab/index.ts` и `board-collab.spec.ts` появились 2 блокирующие регрессии сборки и 1 расхождение `data-testid` в E2E-тесте, а в T1 нашлась одна тонкость с WebSocket Hibernation.

### 1. Статус 12 замечаний прошлого ревью T2

| № | Замечание из первого ревью | Статус | Комментарий по реализации |
| :--- | :--- | :--- | :--- |
| 1 | Двойное открытие/разрыв WebSocket при вводе и смене ника | **Исправлено** | `savedNick` убран из зависимостей `useEffect` (`web/src/App.tsx:206`), используется `initialNickRef` + `client.setNick()`. |
| 2 | Блокировка touch-событий на `<main>` и 2-пальцевого зума | **Исправлено** | Перехват перенесён на `.board-canvas-container` (`web/src/App.tsx:559-563`), `isPrimary === false` всегда пропускается, порог ладони поднят до 48 px (`web/src/input/pen-guard.ts:15, 50`). |
| 3 | Необработанный `URIError` в `parseBoardRoute` | **Исправлено** | `decodeURIComponent` обёрнут в `try / catch` (`web/src/collab/nick.ts:59-67`), покрыто тестом. |
| 4 | Проверка синхронизации сцены на `pageB` в E2E и `webServer` | **Исправлено во 2-й итерации** | Проверка `e2e-rect-1` на `pageB` и `webServer` добавлены, селекторы `data-testid` выровнены (`nick-submit-button`, `excalidraw-file-input`). |
| 5 | Холостой ререндер 60 FPS в rAF и дублирование курсоров | **Исправлено** | Добавлен `stepWithDiff` (`web/src/collab/cursor-interpolator.ts:83-126`), `setRemoteCursors` вызывается только при `changed === true`, дублирующий `updateScene({ collaborators })` убран. |
| 6 | Суммарный поток 20 Гц при рисовании и двойной `flushSceneOnPointerRelease` | **Исправлено** | `scene_update` и `cursor` делят общее окно 100 мс (`web/src/collab/client.ts:399-401, 470-476`), `onPointerUpCapture` убран. |
| 7 | Отправка устаревшего `pendingCursor` при возврате в `lastSentCursor` | **Исправлено** | При совпадении с `lastSentCursor` очищаются `pendingCursor` и таймер (`web/src/collab/client.ts:458-460`). |
| 8 | Потеря локальной правки в `VersionDiffTracker` после `reconcileElements` | **Исправлено** | Введён `markRemoteAppliedAfterMerge` после `mergeSceneElements` (`web/src/collab/reconcile.ts:156-182`). |
| 9 | Отсутствие `package-lock.json` | **Исправлено** | Локфайл добавлен в корень, `check-licenses.mjs` проверяет 29 пакетов. |
| 10 | Лимит размера `.excalidraw`, `Number.isFinite` и `maxPayload` | **Исправлено** | Введены `MAX_EXCALIDRAW_FILE_BYTES = 1_800_000`, `MAX_SCENE_UPDATE_BATCH_BYTES = 900_000`, `isValidFiniteElement` и `maxPayload: 2 МБ`. |
| 11 | Очистка `collaborators` при дисконнекте и таймауте курсора | **Исправлено** | Очищается в `onclose` и через `removeExpiredCollaborators(expiredClientIds)` (`web/src/collab/client.ts:174-193`). |
| 12 | Комментарии на английском и пометка об аналитической таблице Network | **Исправлено** | Все комментарии в коде на английском, примечание в `docs/PR_T2_frontend.md` добавлено. |

### 2. Замечания повторного ревью (все 5 устранены в текущем коммите)

1. **[Блокер #1] Импорт словаря локализации (`web/src/i18n/ru.ts`)**: восстановлены `export const RU_LOCALE_CODE = "ru-RU" as const;` и `export const RU_STRINGS = { ... } as const;` со всеми ключами, используемыми в `web/src/App.tsx` и `web/src/main.tsx`.
2. **[Блокер #2] Реэкспорт `getOrCreateClientId` (`web/src/collab/index.ts`)**: добавлен в блок `export { ... } from "./nick.js"`.
3. **[Важное #3] Совпадение `data-testid` в `web/e2e/board-collab.spec.ts` и `web/src/App.tsx`**: селекторы выровнены на `"nick-submit-button"` и `"excalidraw-file-input"`.
4. **[Важное #4] В T1 (`worker/src/board.ts`) сохранение `boardId` при WebSocket Hibernation до первого сброса снимка и подавление рассылки отвергнутых `scene_update`**: `boardId` сохранён внутри `WebSocketAttachment` и восстанавливается при чтении attachment; при `updatedElements.length === 0` рассылка `broadcastExcept` не вызывается.
5. **[Мелкое #5] Синхронизация констант в `docs/PROJECT_HISTORY.md`**: исправлены `chunk_idx`, `MAX_CONNECTIONS_PER_BOARD = 20` и `MAX_MESSAGE_BYTES = 2 * 1024 * 1024`.

---

## Итерация 1 — Первоначальный отчёт код-ревью по задаче T2 («ревью_по_доске»)

**Вердикт: нужны изменения**

Модуль совместной работы (`web/src/collab/`) и базовый сценарий T2 спроектированы аккуратно, модульные тесты и живая синхронизация через `scripts/mock-ws.mjs` проходят, однако в интеграции React-компонента (`web/src/App.tsx`), обработке touch-событий, маршрутизации и E2E-тесте есть несколько критичных и важных ошибок, которые необходимо исправить перед слиянием.

### Проверка по пунктам

1. **Соответствие задаче и контракту (`SPEC.md`, разделы 5, 6, 9, 12)**:
   * Маршрут `/b/:id` (22 символа base62), сохранение ника в `localStorage["board.nick"]`, запрет подключения без ника, формат сообщений `hello`, `snapshot`, `scene_update`, `cursor`, `ping` (`'{"type":"ping"}'`), закрытие по коду `1013` («Доска заполнена»), русский интерфейс (`langCode="ru-RU"`), `exportEmbedScene: true` и импорт/экспорт `.excalidraw` реализованы по контракту.
   * Контракт в `SPEC.md` не нарушен и не менялся.
   * При этом в `web/src/App.tsx` перехват `onPointerDownCapture` / `onPointerMoveCapture` на корневом `<main>` ломает заявленные в PR жесты двумя пальцами (pinch-to-zoom и панорамирование) и нажатия пальцем по кнопкам интерфейса.

2. **Лимиты Cloudflare (`SPEC.md`, разделы 3 и 8)**:
   * Задача T2 клиентская (SQLite Durable Object и `setAlarm` находятся в задаче T1; `worker/src/board.ts` остаётся стабом из T0 и строк в БД не пишет).
   * Однако на стороне клиента найдены **3 пути повышенного расхода запросов Cloudflare** (напоминание из раздела 3 `SPEC.md`: каждые 20 входящих WebSocket-сообщений = 1 тарифицируемый запрос DO, каждое HTTP-открытие WebSocket = 1 запрос Worker + 1 запрос DO):
     1. **Раздельные таймеры троттлинга `scene_update` (10 Гц) и `cursor` (10 Гц)** в `web/src/collab/client.ts:15-16, 298-325, 381-424`: во время активного рисования пером/мышью Excalidraw одновременно вызывает `onChange` и `onPointerUpdate`, поэтому один рисующий клиент шлёт до **20 сообщений/с** (`10 scene_update + 10 cursor + ping` раз в 30 с) вместо заложенных в расчёт бюджета раздела 8 `SPEC.md` **10 сообщений/с** на человека.
     2. **Двойное подключение и переоткрытие WebSocket при вводе/смене ника** в `web/src/App.tsx:198, 252-255`: `handleNickSubmit` вызывает `setSavedNick(cleaned)` и тут же `collabClientRef.current?.setNick(cleaned)`.
     3. **Двойной сброс `flushSceneOnPointerRelease` при отпускании кнопки/пера** в `web/src/App.tsx:324-326, 445, 603-607`.

3. **Безопасность и приватность (`SPEC.md`, раздел 10)**:
   * Секретов, ФИО, контактов и сторонней аналитики в коде нет; используются только ники (1..32 символа без управляющих символов).
   * В `web/index.html:6-9, 16` и `web/src/main.tsx:8` заданы `window.EXCALIDRAW_ASSET_PATH = "/"` и строгий `Content-Security-Policy` без внешних CDN.
   * Найдены пробелы в валидации ввода: необработанный `decodeURIComponent` в `parseBoardRoute`, отсутствие проверки размера импортируемого файла `.excalidraw` и `maxPayload` в `scripts/mock-ws.mjs`, а также проверка `typeof version === "number"` вместо `Number.isFinite`.

4. **Лицензии новых зависимостей и соответствие `AGENTS.md`**:
   * Новые зависимости: `@playwright/test` (`Apache-2.0`) и `ws` (`MIT`) разрешены правилами проекта и задокументированы в PR и `THIRD_PARTY_NOTICES.md`.
   * В репозитории отсутствовал `package-lock.json`, а в `web/src/App.tsx`, `web/e2e/board-collab.spec.ts` и `scripts/*.mjs` были комментарии на русском языке.

5. **Тесты**:
   * Модульные тесты `web/test/collab.test.ts` (5 тестов) проверяют реальную логику `BoardCollabClient`, `VersionDiffTracker`, `CursorInterpolator` и `pen-guard`.
   * E2E-тест `web/e2e/board-collab.spec.ts` требовал добавления проверки синхронизации элемента `e2e-rect-1` на `pageB` и секции `webServer` в `web/playwright.config.ts`.

6. **Честность описания PR**:
   * Таблица в разделе «Проверка вкладки Network» требовала явного указания, что она составлена аналитически по коду.

7. **Качество кода, гонки в WebSocket и поведение при переподключении**:
   * Холостой цикл `requestAnimationFrame` 60 FPS, дублирование отрисовки курсоров, гонка отправки старого `pendingCursor` при возврате курсора в прежнюю точку и рассинхронизация `VersionDiffTracker` при удержании редактируемого элемента в `reconcileElements`.
