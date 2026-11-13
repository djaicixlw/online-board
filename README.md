# Онлайн-доска для уроков

Собственная бесплатная онлайн-доска для проведения уроков 1-на-1 и в малых группах (до 5 человек) на базе [Excalidraw](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation) (лицензия MIT) и [Cloudflare Workers](https://developers.cloudflare.com/workers/).

Архитектура построена вокруг одного Worker-приложения, которое раздаёт собранную статику фронтенда через [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), отвечает на REST API (`/api/*`) и координирует комнаты досок через [Durable Objects на базе SQLite](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/). Метаданные преподавателей, учеников и досок хранятся в [Cloudflare D1](https://developers.cloudflare.com/d1/get-started/). Полная спецификация и ограничения бесплатных тарифов зафиксированы в `SPEC.md`, правила разработки — в `AGENTS.md`.

## Документация выполненных задач и ревью (`docs/`)

В папке [`docs/`](./docs/) собрана полная документация всех этапов разработки, стабилизации и код-ревью:

- [`docs/SECURITY.md`](./docs/SECURITY.md) — модель угроз, защита от утечек данных, CSP, изоляция сети и остаточные риски (T2.6).
- [`docs/PROJECT_HISTORY.md`](./docs/PROJECT_HISTORY.md) — сводная хронологическая документация по всему проекту (`T0`, `T1`, `T2`, исправления по ревью и стабилизация `T2.5 / T2.5b / T2.5c`).
- [`docs/PR_T2_5_stabilize.md`](./docs/PR_T2_5_stabilize.md) — отчёт и описание PR по задаче **T2.5 / T2.5b / T2.5c** («Стабилизация перед пилотом»).
- [`docs/ANTIGRAVITY_T2_5_PROMPT.md`](./docs/ANTIGRAVITY_T2_5_PROMPT.md) — подробная инструкция и готовый промпт **T2.5b + T2.5c** для агента с доступом к интернету и браузеру (`npm install`, `npm ci`, E2E в Chromium, живые проверки на `wrangler dev`).
- [`docs/REVIEW_T2_REPORT.md`](./docs/REVIEW_T2_REPORT.md) — исходные отчёты код-ревью по задаче T2 (итерации 1 и 2).
- [`docs/REVIEW_FIXES_REPORT.md`](./docs/REVIEW_FIXES_REPORT.md) — подробный отчёт по всем 17 пунктам ревью (12 замечаний первой итерации + 5 замечаний второй итерации).
- [`docs/PR_T0_scaffold.md`](./docs/PR_T0_scaffold.md) — отчёт и описание PR по задаче **T0** («Каркас проекта»).
- [`docs/PR_T1_board_room.md`](./docs/PR_T1_board_room.md) — отчёт и описание PR по задаче **T1** («Комната доски», Durable Object `Board` на SQLite).
- [`docs/PR_T2_frontend.md`](./docs/PR_T2_frontend.md) — отчёт и описание PR по задаче **T2** («Фронтенд доски»).

## Структура репозитория

Репозиторий организован как монорепозиторий на базе npm workspaces:

```text
.
├── .github/
│   └── workflows/
│       ├── ci.yml                  # Проверки на каждый Pull Request (лицензии, типы, линтер, тесты с REQUIRE_RUNTIME=1, сборка)
│       └── deploy.yml              # Проверка, сборка и деплой в Cloudflare при слиянии в main (с concurrency и REQUIRE_RUNTIME=1)
├── docs/
│   ├── ANTIGRAVITY_T2_5_PROMPT.md  # Инструкция и промпт T2.5b/T2.5c для агента с сетью и браузером
│   ├── PR_T0_scaffold.md           # Описание PR задачи T0
│   ├── PR_T1_board_room.md         # Описание PR задачи T1
│   ├── PR_T2_frontend.md           # Описание PR задачи T2
│   ├── PR_T2_5_stabilize.md        # Описание PR задачи T2.5 / T2.5b / T2.5c («Стабилизация перед пилотом»)
│   ├── PROJECT_HISTORY.md          # Полная история выполненных работ
│   ├── REVIEW_FIXES_REPORT.md      # Подробный отчёт об исправлениях
│   └── REVIEW_T2_REPORT.md         # Исходный отчёт код-ревью («ревью_по_доске»)
├── scripts/
│   ├── check-licenses.mjs          # Скрипт проверки лицензий зависимостей (SPDX allowlist + исключения)
│   ├── dev.mjs                     # Скрипт одновременного локального запуска web и worker
│   ├── gen-board-id.mjs            # Генератор криптостойких 22-символьных base62 ID досок для пилота
│   ├── mock-ws.mjs                 # Локальный WebSocket мок-сервер для автономной проверки фронтенда
│   └── ws-smoke.mjs                # Дымовой тест 3 клиентов по WebSocket против запущенного wrangler dev (WS_SMOKE_URL)
├── web/                            # Фронтенд: Vite + React + TypeScript + @excalidraw/excalidraw
│   ├── e2e/
│   │   └── board-collab.spec.ts    # E2E-тест Playwright совместного рисования двух браузеров на /b/:id
│   ├── scripts/
│   │   └── copy-excalidraw-assets.mjs # Локальное копирование шрифтов Excalidraw в бандл (без внешних CDN)
│   ├── src/
│   │   ├── collab/                 # WebSocket-клиент, сверка версий, интерполяция курсоров, .excalidraw
│   │   ├── i18n/
│   │   │   └── ru.ts               # Русская локализация (ru-RU) и все строки интерфейса
│   │   ├── input/
│   │   │   └── pen-guard.ts        # Авто-режим пера для стилуса и защита от касаний ладонью без блокировки тулбара
│   │   ├── App.tsx                 # Полноэкранный компонент доски (/b/:id)
│   │   ├── main.tsx                # Точка входа React (с привязкой локального EXCALIDRAW_ASSET_PATH)
│   │   ├── styles.css              # Стили полноэкранного контейнера, шапки, плашки статуса и курсоров
│   │   └── vite-env.d.ts           # Типы окружения Vite
│   ├── test/
│   │   └── collab.test.ts          # Модульные и регрессионные тесты клиента совместной работы и ревью
│   ├── index.html                  # HTML-шаблон со строгим Content-Security-Policy без внешних ресурсов
│   ├── package.json
│   ├── playwright.config.ts
│   ├── tsconfig.json
│   ├── vite.config.ts              # Конфигурация Vite и проксирование /api и /ws на локальный Worker
│   └── vitest.config.ts
├── worker/                         # Бэкенд: Cloudflare Worker (TypeScript, strict + exactOptionalPropertyTypes)
│   ├── src/
│   │   ├── board.ts                # Класс Durable Object «Board» (SQLite, WebSocket Hibernation, чанки <= 900 КБ)
│   │   ├── env.ts                  # Типы привязок окружения (ASSETS, BOARD, DB, PILOT_BOARD_IDS, переменные)
│   │   └── index.ts                # Точка входа Worker (GET /api/health, GET /ws/:id и раздача статики)
│   ├── test/
│   │   ├── board.runtime.test.ts   # Интеграционный тест на реальной среде Workers (Miniflare + SQLite DO)
│   │   ├── board.test.ts           # Модульные и интеграционные тесты Durable Object Board и PILOT_BOARD_IDS
│   │   ├── cloudflare-workers-shim.ts # Тестовый харнесс SQLite + WebSocket Hibernation для модульных тестов
│   │   ├── health.test.ts          # Тесты маршрута GET /api/health и интервала SAVE_INTERVAL_MS
│   │   └── licenses.test.ts        # Тесты фильтра лицензий
│   ├── package.json
│   ├── tsconfig.json               # Проверка типов src/ строго против @cloudflare/workers-types
│   ├── tsconfig.test.json          # Проверка типов test/ против @cloudflare/workers-types и node
│   ├── vitest.config.ts
│   └── wrangler.toml               # Конфигурация Wrangler (Static Assets, Durable Object, переменные, шаблон D1)
├── .dev.vars.example               # Пример локальных переменных разработки (SAVE_INTERVAL_MS=5000, ALLOW_ANY_BOARD_ID)
├── .gitignore
├── .prettierignore
├── .prettierrc.json
├── AGENTS.md                       # Обязательные правила для всех разработчиков и ИИ-агентов
├── eslint.config.mjs               # Конфигурация ESLint 9 (strict TypeScript)
├── license-exceptions.json         # Список разрешённых транзитивных исключений с пояснениями
├── package.json                    # Корневой манифест npm workspaces и общие скрипты
├── SPEC.md                         # Спецификация архитектуры, протокола и лимитов проекта
├── THIRD_PARTY_NOTICES.md          # Перечень прямых зависимостей, их лицензий и копирайт Excalidraw
└── tsconfig.base.json              # Базовая конфигурация TypeScript в режиме strict + exactOptionalPropertyTypes
```

## Как запустить локально

### 1. Требования

- Установленный **Node.js** версии `20.x` или `22.x LTS` (вместе с `npm >= 10`).
- Доступ в интернет при первой установке пакетов (`npm install` / `npm ci`), после чего приложение работает полностью локально без обращения к внешним CDN.

### 2. Установка и запуск одной командой

Клонируйте репозиторий и выполните в корне проекта:

```bash
npm ci
npm run dev
```

Что делает `npm run dev`:

1. Если файл `worker/.dev.vars` ещё не существует, автоматически создаёт его из шаблона `.dev.vars.example` с параметрами для локальной разработки (`SAVE_INTERVAL_MS=5000` и `ALLOW_ANY_BOARD_ID=true`).
2. Копирует локальные шрифты из пакета `@excalidraw/excalidraw` в `web/public/fonts/`, чтобы браузер загружал все ресурсы исключительно со своего локального сервера (`window.EXCALIDRAW_ASSET_PATH = "/"`).
3. Параллельно поднимает:
   - **Cloudflare Worker (`wrangler dev`)** на `http://localhost:8787` — обрабатывает API-запросы (например, `http://localhost:8787/api/health`) и WebSocket-комнаты досок (`/ws/:id?nick=...`) в локальном Durable Object `Board`.
   - **Vite dev-сервер (`web`)** на `http://localhost:5173` — открывает полноэкранный холст Excalidraw (`/b/:id`) на русском языке и автоматически проксирует запросы `/api/*` и `/ws/*` на локальный Worker (`127.0.0.1:8787`).

### 3. Проверка работоспособности локально (включая `smoke:ws`)

- Откройте в браузере `http://localhost:5173/b/0123456789abcdefghijkl` — появится диалог выбора ника «Как вас зовут на доске?», после чего загрузится холст Excalidraw на весь экран с русским интерфейсом и установится WebSocket-соединение. Во вкладке **Network** инструментов разработчика (F12) все запросы идут только на `localhost` (0 запросов к внешним доменам и CDN).
- Проверьте эндпоинт здоровья Worker через браузер или терминал:
  ```bash
  curl http://localhost:8787/api/health
  # Ответ: {"ok":true,"version":"0.1.0"}
  ```
- Для запуска дымового теста совместного рисования 3 клиентов по WebSocket (`scripts/ws-smoke.mjs`):
  1. В **первом окне терминала** запустите локальный сервер разработки:
     ```bash
     npm run dev
     ```
  2. Во **втором окне терминала** выполните дымовой тест (по умолчанию подключается к `WS_SMOKE_URL=ws://localhost:8787`):
     ```bash
     npm run smoke:ws
     ```

## Список команд

Все основные команды запускаются из корня монорепозитория:

| Команда                      | Описание                                                                                                                                                                                      |
| :--------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                | Запускает локально одновременно `web` (Vite на `:5173`) и `worker` (Wrangler на `:8787`) одной командой                                                                                       |
| `npm run gen:board-id -- 10` | Генерирует `N` (по умолчанию 1, до 50) криптостойких 22-символьных base62 ID досок (`scripts/gen-board-id.mjs`)                                                                               |
| `npm run mock:ws`            | Запускает автономный WebSocket мок-сервер (`scripts/mock-ws.mjs` на `:8788`)                                                                                                                  |
| `npm run smoke:ws`           | Подключается к запущенному `wrangler dev` (`WS_SMOKE_URL`, по умолчанию `ws://localhost:8787`) и проверяет совместное рисование 3 клиентов                                                    |
| `npm run build`              | Собирает статику фронтенда в `web/dist` (включая локальные шрифты Excalidraw) и проверяет сборку Worker (`wrangler deploy --dry-run`)                                                         |
| `npm test`                   | Запускает модульные и интеграционные тесты [Vitest](https://vitest.dev/) в `web` и `worker` (при `REQUIRE_RUNTIME=1` требует `Miniflare` в `board.runtime.test.ts`)                           |
| `npm run test:e2e`           | Запускает E2E-тест двух браузеров в Playwright (`web/e2e/board-collab.spec.ts`)                                                                                                               |
| `npm run lint`               | Проверяет весь код с помощью ESLint (`strict`) и форматирование через Prettier                                                                                                                |
| `npm run format`             | Автоматически форматирует файлы проекта с помощью Prettier                                                                                                                                    |
| `npm run typecheck`          | Запускает строгую проверку типов TypeScript (`tsc --noEmit` с `exactOptionalPropertyTypes: true`) во всех пакетах (`web` и `worker`)                                                          |
| `npm run check:licenses`     | Проверяет лицензии всех зависимостей по `package-lock.json` и `node_modules` (разрешены `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`; исключения — в `license-exceptions.json`) |

## База данных Cloudflare D1 и Личный кабинет преподавателя (T3)

Личный кабинет преподавателя (`/teacher`) позволяет создавать и дублировать доски в 1 клик, привязывать их к ученикам и вести рабочие заметки. Доступ защищён секретным токеном преподавателя (в БД хранится только SHA-256 хэш).

### 1. Создание базы данных D1 и применение миграций

1. Создайте базу данных Cloudflare D1:
   ```bash
   npx wrangler d1 create online-board-db
   ```
2. Скопируйте полученный `database_id` в `worker/wrangler.toml`:
   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "online-board-db"
   database_id = "<ваш_database_id>"
   ```
3. Примените начальную миграцию схемы (`worker/migrations/0001_init.sql`):
   ```bash
   # Локально:
   npx wrangler d1 execute online-board-db --local --file=worker/migrations/0001_init.sql

   # В облаке Cloudflare:
   npx wrangler d1 execute online-board-db --remote --file=worker/migrations/0001_init.sql
   ```

### 2. Генерация токена преподавателя

Сгенерируйте новый аккаунт преподавателя с помощью скрипта:

```bash
node scripts/create-teacher.mjs --name "Иван Иванович"
```

Скрипт сгенерирует 22-значный base62 ID, криптостойкий токен (>260 бит энтропии), вычислит SHA-256 хэш и выведет готовую команду вставки:

```bash
npx wrangler d1 execute online-board-db --remote --command "INSERT INTO teachers (id, name, token_hash, created_at) VALUES (...);"
```

### 3. Работа в кабинете

1. Перейдите по адресу `/teacher` (или нажмите ссылку в верхней панели доски).
2. Введите токен доступа (он сохранится в `localStorage`).
3. Создавайте карточки учеников, пишите заметки к урокам и создавайте доски в 1 клик (ссылка сразу копируется в буфер обмена).

## Как владельцу восстановить данные из `snapshot_backup` при повреждении снимка

Если при пробуждении Durable Object `Board` обнаруживает, что JSON снимка в таблице `snapshot` повреждён (в логах Worker появляется событие `snapshot_load_error`), объект:

1. Автоматически копирует все повреждённые куски в резервную таблицу SQLite **`snapshot_backup (chunk_idx INTEGER PRIMARY KEY, data BLOB, backed_up_at INTEGER)`** и пишет в лог событие `snapshot_corrupted_backup_saved`.
2. Если резервная копия записана успешно, доска стартует с чистой сценой и продолжает штатно сохранять новые изменения в `snapshot`, не блокируя урок. (Если же записать резервную копию не удалось, запись в `snapshot` блокируется, а при подключении клиенту уходит `{"type":"error","code":"board_not_saved"}` с постоянной плашкой «Доска повреждена, изменения не сохраняются. Сообщите преподавателю»).

Чтобы извлечь и восстановить сохранённые куски из `snapshot_backup`:

1. В логах Cloudflare Workers (`Workers & Pages` → `online-board` → `Logs` / `wrangler tail`) найдите запись `snapshot_corrupted_backup_saved` и посмотрите поле `boardId`.
2. Для локальной базы `wrangler dev` откройте SQLite-файл объекта в `worker/.wrangler/state/v3/do/` и выполните:
   ```sql
   SELECT chunk_idx, hex(data), backed_up_at FROM snapshot_backup ORDER BY chunk_idx ASC;
   ```
3. Для облачного Durable Object временно добавьте диагностический админ-маршрут (либо используйте процедуру восстановления `POST /api/boards/:id/restore` из задачи T5), который склеивает `SELECT data FROM snapshot_backup ORDER BY chunk_idx ASC` в UTF-8 строку, исправляет обрезанный хвост JSON и загружает восстановленный `.excalidraw` обратно на доску через кнопку **«Открыть .excalidraw»**.

## Привязка базы данных Cloudflare D1 (`DB`)

В соответствии с задачами T0..T2.5 база данных D1 пока не создаётся в облаке (схема таблиц `teachers`, `students`, `boards` и миграции реализуются в задаче T3), но в проекте уже подготовлена типизированная привязка `DB` (`env.DB` типа `D1Database` в `worker/src/env.ts`) и заготовка в `worker/wrangler.toml`.

Когда вы перейдёте к созданию базы данных D1 (по [официальной инструкции Cloudflare D1](https://developers.cloudflare.com/d1/get-started/)):

1. Создайте базу данных через Wrangler CLI из папки `worker/`:
   ```bash
   cd worker
   npx wrangler d1 create online-board-db
   ```
2. Скопируйте выданный в терминале идентификатор `database_id` (формата UUID) и раскомментируйте секцию `[[d1_databases]]` в файле `worker/wrangler.toml`:
   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "online-board-db"
   database_id = "<ВАШ_UUID_БАЗЫ_D1>"
   ```
3. При локальном запуске (`npm run dev` / `npx wrangler dev`) Wrangler автоматически создаёт локальную SQLite-копию базы D1 в папке `worker/.wrangler/state/`, не расходуя лимиты облачной базы ([Local development · Cloudflare D1 docs](https://developers.cloudflare.com/d1/best-practices/local-development/)).

## Защита ветки `main` в GitHub (Branch Protection Rules)

В файле `.github/workflows/deploy.yml` настроена группа `concurrency: deploy-production` (чтобы два деплоя никогда не шли параллельно) и добавлены обязательные шаги проверки (`npm run check:licenses`, `npm run typecheck`, `npm run lint`, `REQUIRE_RUNTIME=1 npm test`) перед `npm run build` и публикацией в Cloudflare.

Чтобы ни один Pull Request не мог быть влит в `main` до успешного прохождения всех проверок CI:

1. Откройте репозиторий на GitHub → **Settings** → **Branches** (или **Rules** → **Rulesets**).
2. Нажмите **Add branch protection rule** для ветки `main`.
3. Включите опцию **Require a pull request before merging**.
4. Включите опцию **Require status checks to pass before merging** → **Require branches to be up to date before merging** и выберите статус-проверку **`Verify (Typecheck, Lint, Test, Build, Licenses)`** из workflow `CI` (`.github/workflows/ci.yml`).
5. Нажмите **Create** / **Save changes**.

## Безопасный деплой и подготовка к первому запуску с реальными учениками (T2.6)

Строгий порядок действий при подготовке и выкатке пилота: **секреты GitHub и окружение `production` → отзыв лишних сессий → слияние PR в `main` → генерация свежих `PILOT_BOARD_IDS` → автоматическая проверка `verify-prod.mjs` → защищённая раздача ссылок ученикам**.

### Шаг 1. Зарегистрируйте аккаунт Cloudflare и скопируйте `CLOUDFLARE_ACCOUNT_ID`

1. Перейдите на [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up), создайте аккаунт и в разделе **Compute (Workers)** → **Workers & Pages** активируйте бесплатный поддомен `<ваш-поддомен>.workers.dev`.
2. Скопируйте ваш 32-символьный **Account ID** ([инструкция Cloudflare: Find account and zone IDs](https://developers.cloudflare.com/fundamentals/setup/find-account-and-zone-ids/)).

### Шаг 2. Создайте узкий токен `CLOUDFLARE_API_TOKEN` и настройте GitHub Environment `production`

1. В панели Cloudflare откройте **Profile** → **API Tokens** → **Create Token** → **Create Custom Token** ([Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/)).
2. Назовите токен `github-actions-online-board-deploy` и задайте минимально необходимые права уровня аккаунта:
   - `Account` — `Workers Scripts` — `Edit`
   - `Account` — `Account Settings` — `Read`
3. Ограничьте **Account Resources** конкретным аккаунтом и задайте разумный срок действия (TTL). Скопируйте полученный токен (никогда не вставляйте токен в код или открытые чаты).
4. В репозитории на GitHub перейдите в **Settings** → **Environments** → нажмите **New environment** и введите имя:
   ```text
   production
   ```
5. В настройках окружения `production`:
   - Включите **Deployment branches and tags** → **Selected branches** → добавьте ветку `main` (это гарантирует, что деплойные секреты недоступны сторонним веткам и pull request'ам).
   - В блоке **Environment secrets** добавьте:
     - `CLOUDFLARE_ACCOUNT_ID`
     - `CLOUDFLARE_API_TOKEN`

### Шаг 3. Отозовите локальные сессии `wrangler login`

Если тестирование или первичный деплой производились через браузерную авторизацию `npx wrangler login` на вашем компьютере, выполните выход и отзовите сессию в профиле Cloudflare:

```bash
npx wrangler logout
```

### Шаг 4. Слейте проверенный PR в `main` и дождитесь автоматического деплоя

1. После успешного прохождения всех проверок в ветке `task/T2.6-security` слейте Pull Request в ветку `main`.
2. В GitHub Actions автоматически запустится рабочий процесс `.github/workflows/deploy.yml`, который выполнит проверку лицензий, typecheck, lint, интеграционные тесты с SQLite рантаймом, сборку фронтенда и выкатку Worker через `cloudflare/wrangler-action`.
3. Убедитесь, что Worker доступен и отдает статус 200:
   ```bash
   curl https://online-board.<ваш-поддомен>.workers.dev/api/health
   # Ответ: {"ok":true,"version":"0.1.0"}
   ```
   _(Пока секрет `PILOT_BOARD_IDS` не задан, сервер безопасно отвечает единым кодом `404` на любые попытки соединения по WebSocket к `/ws/*`)._

### Шаг 5. Сгенерируйте свежие `PILOT_BOARD_IDS` и загрузите в секреты Worker

В целях безопасности не используйте ID, которые вводились в терминале во время разработки или отладки с ИИ-агентами. Сгенерируйте чистый пул идентификаторов:

1. Запустите генератор на 10 случайных 22-символьных base62 ID:
   ```bash
   npm run gen:board-id -- 10
   ```
2. Загрузите список этих ID через запятую в секрет Worker:
   ```bash
   cd worker
   npx wrangler secret put PILOT_BOARD_IDS
   ```
   При запросе `Enter a secret value:` вставьте сгенерированную строку без пробелов (`ID1,ID2,...,ID10`) и нажмите `Enter`.

### Шаг 6. Запустите автоматическую проверку безопасности боевого сервиса

Проверьте корректность заголовков безопасности, отсутствие `'unsafe-inline'`/`'unsafe-eval'`, запрет роботов и единый 404:

```bash
node scripts/verify-prod.mjs https://online-board.<ваш-поддомен>.workers.dev
```

Все проверки в итоговой таблице отчёта должны получить статус `✅ PASS`.
Также откройте доску в Safari (macOS или iOS) и убедитесь, что соединение устанавливается штатно.

### Шаг 7. Раздайте персональные ссылки ученикам через защищённые каналы

1. Назначьте по одному сгенерированному ID каждому ученику пилота.
2. Отправляйте ссылки **строго через личные сообщения** (Telegram, личный email, защищённый мессенджер), ни в коем случае не публикуя их в открытых каналах или группах:
   ```text
   https://online-board.<ваш-поддомен>.workers.dev/b/<ID_ДОСКИ_УЧЕНИКА>
   ```
3. Подробнее о модели угроз и защите данных читайте в [`docs/SECURITY.md`](./docs/SECURITY.md).
