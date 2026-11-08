# Онлайн-доска для уроков

Собственная бесплатная онлайн-доска для проведения уроков 1-на-1 и в малых группах (до 5 человек) на базе [Excalidraw](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation) (лицензия MIT) и [Cloudflare Workers](https://developers.cloudflare.com/workers/).

Архитектура построена вокруг одного Worker-приложения, которое раздаёт собранную статику фронтенда через [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), отвечает на REST API (`/api/*`) и координирует комнаты досок через [Durable Objects на базе SQLite](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/). Метаданные преподавателей, учеников и досок хранятся в [Cloudflare D1](https://developers.cloudflare.com/d1/get-started/). Полная спецификация и ограничения бесплатных тарифов зафиксированы в `SPEC.md`, правила разработки — в `AGENTS.md`.

## Документация выполненных задач и ревью (`docs/`)

В папке [`docs/`](./docs/) собрана полная документация всех этапов разработки и код-ревью:
- [`docs/PROJECT_HISTORY.md`](./docs/PROJECT_HISTORY.md) — сводная хронологическая документация по всему проекту (`T0`, `T1`, `T2` и исправления по код-ревью).
- [`docs/REVIEW_T2_REPORT.md`](./docs/REVIEW_T2_REPORT.md) — прикреплённый отчёт код-ревью по задаче T2 («ревью_по_доске»).
- [`docs/REVIEW_FIXES_REPORT.md`](./docs/REVIEW_FIXES_REPORT.md) — подробный отчёт по всем 12 пунктам ревью: **что, где, как, почему, зачем и когда** было исправлено.
- [`docs/PR_T0_scaffold.md`](./docs/PR_T0_scaffold.md) — отчёт и описание PR по задаче **T0** («Каркас проекта»).
- [`docs/PR_T1_board_room.md`](./docs/PR_T1_board_room.md) — отчёт и описание PR по задаче **T1** («Комната доски», Durable Object `Board` на SQLite).
- [`docs/PR_T2_frontend.md`](./docs/PR_T2_frontend.md) — отчёт и описание PR по задаче **T2** («Фронтенд доски», с учётом внесённых исправлений по ревью).

## Структура репозитория

Репозиторий организован как монорепозиторий на базе npm workspaces:

```text
.
├── .github/
│   └── workflows/
│       ├── ci.yml                  # Проверки на каждый Pull Request (лицензии, типы, линтер, тесты, сборка)
│       └── deploy.yml              # Автоматический деплой в Cloudflare при слиянии в ветку main
├── docs/
│   ├── PROJECT_HISTORY.md          # Полная история выполненных работ (T0, T1, T2 и пост-ревью)
│   ├── REVIEW_T2_REPORT.md         # Исходный отчёт код-ревью («ревью_по_доске»)
│   ├── REVIEW_FIXES_REPORT.md      # Подробный отчёт об исправлениях (что, где, как, почему, зачем, когда)
│   ├── PR_T0_scaffold.md           # Описание PR задачи T0
│   ├── PR_T1_board_room.md         # Описание PR задачи T1
│   └── PR_T2_frontend.md           # Описание PR задачи T2
├── scripts/
│   ├── check-licenses.mjs          # Скрипт проверки лицензий зависимостей (SPDX allowlist + исключения)
│   ├── dev.mjs                     # Скрипт одновременного локального запуска web и worker
│   ├── mock-ws.mjs                 # Локальный WebSocket мок-сервер для автономной проверки фронтенда
│   └── ws-smoke.mjs                # Дымовой тест совместного рисования 3 клиентов по WebSocket
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
│   │   │   └── pen-guard.ts        # Режим пера для стилуса и защита от касаний ладонью с сохранением 2-finger зума
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
├── worker/                         # Бэкенд: Cloudflare Worker (TypeScript, strict)
│   ├── src/
│   │   ├── board.ts                # Класс Durable Object «Board» (SQLite, WebSocket Hibernation, чанки <= 900 КБ)
│   │   ├── env.ts                  # Типы привязок окружения (ASSETS, BOARD, DB, переменные)
│   │   └── index.ts                # Точка входа Worker (GET /api/health, GET /ws/:id и раздача статики)
│   ├── test/
│   │   ├── board.test.ts           # 11 интеграционных тестов Durable Object Board (протокол, чанки, GC, лимиты)
│   │   ├── cloudflare-workers-shim.ts # Тестовый харнесс SQLite + WebSocket Hibernation для Node
│   │   ├── health.test.ts          # Тесты маршрута GET /api/health
│   │   └── licenses.test.ts        # Тесты фильтра лицензий
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   └── wrangler.toml               # Конфигурация Wrangler (Static Assets, Durable Object, переменные, шаблон D1)
├── .dev.vars.example               # Пример локальных переменных разработки (SAVE_INTERVAL_MS, ALLOW_ANY_BOARD_ID)
├── .gitignore
├── .prettierignore
├── .prettierrc.json
├── AGENTS.md                       # Обязательные правила для всех разработчиков и ИИ-агентов
├── eslint.config.mjs               # Конфигурация ESLint 9 (strict TypeScript)
├── license-exceptions.json         # Список разрешённых транзитивных исключений с пояснениями
├── package.json                    # Корневой манифест npm workspaces и общие скрипты
├── package-lock.json               # Локфайл npm workspaces (для npm ci и проверки лицензий)
├── SPEC.md                         # Спецификация архитектуры, протокола и лимитов проекта
├── THIRD_PARTY_NOTICES.md          # Перечень прямых зависимостей, их лицензий и копирайт Excalidraw
└── tsconfig.base.json              # Базовая конфигурация TypeScript в режиме strict
```

## Как запустить локально

### 1. Требования

- Установленный **Node.js** версии `20.x` или `22.x LTS` (вместе с `npm >= 10`).
- Доступ в интернет при первой установке пакетов (`npm ci` / `npm install`), после чего приложение работает полностью локально без обращения к внешним CDN.

### 2. Установка и запуск одной командой

Клонируйте репозиторий и выполните в корне проекта:

```bash
npm ci
npm run dev
```

Что делает `npm run dev`:
1. Если файл `worker/.dev.vars` ещё не существует, автоматически создаёт его из шаблона `.dev.vars.example` с параметрами для локальной разработки (`SAVE_INTERVAL_MS=10000` и `ALLOW_ANY_BOARD_ID=true`).
2. Копирует локальные шрифты из пакета `@excalidraw/excalidraw` в `web/public/fonts/`, чтобы браузер загружал все ресурсы исключительно со своего локального сервера (`window.EXCALIDRAW_ASSET_PATH = "/"`).
3. Параллельно поднимает:
   - **Cloudflare Worker (`wrangler dev`)** на `http://localhost:8787` — обрабатывает API-запросы (например, `http://localhost:8787/api/health`) и WebSocket-комнаты досок (`/ws/:id?nick=...`) в локальном Durable Object `Board`.
   - **Vite dev-сервер (`web`)** на `http://localhost:5173` — открывает полноэкранный холст Excalidraw (`/b/:id`) на русском языке и автоматически проксирует запросы `/api/*` и `/ws/*` на локальный Worker (`127.0.0.1:8787`).

### 3. Проверка работоспособности локально

- Откройте в браузере `http://localhost:5173/b/0123456789abcdefghijkl` — появится диалог выбора ника «Как вас зовут на доске?», после чего загрузится холст Excalidraw на весь экран с русским интерфейсом и установится WebSocket-соединение. Во вкладке **Network** инструментов разработчика (F12) все запросы идут только на `localhost` (0 запросов к внешним доменам и CDN).
- Проверьте эндпоинт здоровья Worker через браузер или терминал:
  ```bash
  curl http://localhost:8787/api/health
  # Ответ: {"ok":true,"version":"0.1.0"}
  ```
- Запустите дымовой тест совместной работы 3 клиентов по WebSocket:
  ```bash
  npm run smoke:ws
  ```

## Список команд

Все основные команды запускаются из корня монорепозитория:

| Команда | Описание |
| :--- | :--- |
| `npm run dev` | Запускает локально одновременно `web` (Vite на `:5173`) и `worker` (Wrangler на `:8787`) одной командой |
| `npm run mock:ws` | Запускает автономный WebSocket мок-сервер (`scripts/mock-ws.mjs` на `:8788`) |
| `npm run smoke:ws` | Запускает дымовой сценарий совместного рисования 3 клиентов (`scripts/ws-smoke.mjs`) |
| `npm run build` | Собирает статику фронтенда в `web/dist` (включая локальные шрифты Excalidraw) и проверяет сборку Worker (`wrangler deploy --dry-run`) |
| `npm run test` | Запускает все модульные и интеграционные тесты [Vitest](https://vitest.dev/) в `worker` и `web` |
| `npm run test:e2e` | Запускает E2E-тест двух браузеров в Playwright (`web/e2e/board-collab.spec.ts`) |
| `npm run lint` | Проверяет весь код с помощью ESLint (`strict`) и форматирование через Prettier |
| `npm run format` | Автоматически форматирует файлы проекта с помощью Prettier |
| `npm run typecheck` | Запускает строгую проверку типов TypeScript (`tsc --noEmit`) во всех пакетах (`web` и `worker`) |
| `npm run check:licenses` | Проверяет лицензии всех зависимостей по `package-lock.json` и `node_modules` (разрешены `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`; исключения — в `license-exceptions.json`) |

## Привязка базы данных Cloudflare D1 (`DB`)

В соответствии с задачей T0 база данных D1 пока не создаётся в облаке (схема таблиц `teachers`, `students`, `boards` и миграции реализуются в задаче T3), но в проекте уже подготовлена типизированная привязка `DB` (`env.DB` типа `D1Database` в `worker/src/env.ts`) и заготовка в `worker/wrangler.toml`.

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

## Первый деплой, пошагово (для человека без опыта с серверами)

Деплой настроен так, чтобы вам **не нужно было ничего настраивать вручную на серверах**: при каждом слиянии изменений (merge) в ветку `main` GitHub сам собирает проект и публикует его в Cloudflare через официальное действие [cloudflare/wrangler-action](https://github.com/cloudflare/wrangler-action) ([документация Cloudflare по GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)).

Ниже приведена подробная пошаговая инструкция, которую нужно выполнить **один раз** при запуске проекта.

### Шаг 1. Зарегистрируйте бесплатный аккаунт Cloudflare и активируйте поддомен `workers.dev`

1. Перейдите на [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) и создайте бесплатный аккаунт (подтвердите почту). Банковская карта для бесплатного плана **Workers Free** не требуется.
2. В левом меню панели управления откройте раздел **Compute (Workers)** → **Workers & Pages**.
3. Если вы открываете этот раздел впервые, Cloudflare предложит выбрать бесплатный поддомен вида `<ваше-имя>.workers.dev`. Придумайте короткое имя и сохраните его — на этом поддомене будет работать ваша доска (`https://online-board.<ваше-имя>.workers.dev`).

### Шаг 2. Скопируйте ваш `CLOUDFLARE_ACCOUNT_ID`

1. Оставаясь в панели управления Cloudflare (в разделе **Workers & Pages** или на главной странице аккаунта), посмотрите на правую боковую панель (или адресную строку браузера: `https://dash.cloudflare.com/<32-символьный-код>/...`).
2. Найдите поле **Account ID** (длинный код из 32 букв и цифр) и нажмите **Copy** ([инструкция Cloudflare: Find account and zone IDs](https://developers.cloudflare.com/fundamentals/setup/find-account-and-zone-ids/)). Сохраните его во временную заметку — это ваш `CLOUDFLARE_ACCOUNT_ID`.

### Шаг 3. Создайте API-токен Cloudflare с минимально необходимыми правами (`CLOUDFLARE_API_TOKEN`)

Чтобы GitHub Actions мог загружать собранный сайт и Worker в ваш аккаунт Cloudflare, но не имел лишнего доступа к другим настройкам аккаунта, создайте токен по принципу минимальных привилегий ([документация по правам и шаблонам API-токенов Cloudflare](https://developers.cloudflare.com/fundamentals/api/reference/template/) и [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/)):

1. В панели управления Cloudflare нажмите на значок профиля в правом верхнем углу → **Profile** → **API Tokens** (или перейдите в **Manage Account** → **Account API Tokens**).
2. Нажмите синюю кнопку **Create Token**.
3. Выберите один из двух способов настройки:
   - **Способ А (самый простой — по шаблону Cloudflare):** напротив шаблона **Edit Cloudflare Workers** нажмите **Use template**. Чтобы сузить права до минимума (так как R2 и KV мы не используем согласно разделу 3 `SPEC.md`), в списке **Permissions** вы можете удалить строки `Workers R2 Storage` и `Workers KV Storage`, оставив только:
     - `Account` → `Workers Scripts` → `Edit` (позволяет создавать и обновлять Worker, Static Assets и привязки Durable Objects);
     - `Account` → `Account Settings` → `Read` (нужно утилите Wrangler для проверки аккаунта при деплое);
     - `User` → `User Details` → `Read` и `User Memberships` → `Read` (если создаёте User API Token).
     *(Примечание: когда в задаче T3 вы будете выполнять миграции базы D1 из CI, при необходимости добавьте также `Account` → `D1` → `Edit`; для самого деплоя Worker с привязками по [документации Cloudflare](https://developers.cloudflare.com/workers/authorization/workers/#bindings) отдельных прав на D1 не требуется).*
   - **Способ Б (через Create Custom Token):** нажмите **Get started** рядом с **Create Custom Token**, назовите токен `github-actions-online-board-deploy` и задайте ровно 2 разрешения уровня аккаунта:
     - `Account` — `Workers Scripts` — `Edit`
     - `Account` — `Account Settings` — `Read`
4. В блоке **Account Resources** выберите `Include` → **ваш конкретный аккаунт** (вместо `All accounts`).
5. В блоке **Zone Resources** (если он отображается, а своего домена пока нет) можно удалить строку Zone или оставить `All zones`, если вы планируете позже подключить свой домен.
6. Нажмите **Continue to summary**, затем **Create Token**.
7. **Важно:** скопируйте показанный секретный токен сразу (после закрытия страницы Cloudflare больше не покажет его целиком). Никогда не вставляйте этот токен в код или файлы репозитория!

### Шаг 4. Сохраните секреты в настройках репозитория GitHub

1. Откройте ваш приватный репозиторий на GitHub в браузере.
2. Перейдите на вкладку **Settings** (в верхнем меню репозитория).
3. В левом боковом меню раскройте **Secrets and variables** → нажмите **Actions**.
4. Нажмите зелёную кнопку **New repository secret** и добавьте по очереди **два секрета**:
   - Первый секрет:
     - **Name:** `CLOUDFLARE_ACCOUNT_ID`
     - **Secret:** вставьте скопированный на Шаге 2 идентификатор аккаунта (32 символа) → нажмите **Add secret**.
   - Второй секрет:
     - **Name:** `CLOUDFLARE_API_TOKEN`
     - **Secret:** вставьте скопированный на Шаге 3 API-токен → нажмите **Add secret**.

### Шаг 5. Запустите и проверьте успешный деплой

1. Когда изменения вливаются в ветку `main` (или если вы вручную откроете вкладку **Actions** → выберете слева workflow **Deploy** → нажмёте **Run workflow** → **Run workflow**), запустится автоматическая сборка и публикация.
2. Дождитесь зелёной галочки рядом с запуском **Deploy** во вкладке **Actions** (обычно 1–2 минуты).
3. Раскройте шаг **Deploy Worker with Static Assets to Cloudflare** в логах GitHub Actions — в конце лога Wrangler выведет опубликованный адрес вашего приложения вида:
   ```text
   https://online-board.<ваш-поддомен>.workers.dev
   ```
4. Проверьте работу опубликованного приложения в браузере:
   - Откройте `https://online-board.<ваш-поддомен>.workers.dev/api/health` — вы должны увидеть ответ:
     ```json
     {"ok":true,"version":"0.1.0"}
     ```
   - Откройте главную страницу `https://online-board.<ваш-поддомен>.workers.dev/` — откроется полноэкранная доска Excalidraw на русском языке.
   - Нажмите `F12` (инструменты разработчика) → вкладка **Network** → перезагрузите страницу (`Ctrl+R` / `Cmd+R`): убедитесь, что все скрипты, стили и шрифты загружаются только с вашего домена `online-board.<ваш-поддомен>.workers.dev` со статусом `200`, и нет ни одного обращения к сторонним доменам.
