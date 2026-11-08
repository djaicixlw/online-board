# T0: Каркас проекта (монорепо web + worker, CI/CD, проверка лицензий, документация)

Ветка: `task/T0-scaffold` → `main`

## Что сделано

1. **Монорепозиторий на npm workspaces (`package.json`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc.json`)**:
   - Настроены рабочие пространства `web/` и `worker/`.
   - Включён строгий режим TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `noImplicitOverride: true`).
   - Настроены ESLint 9 Flat Config (`@typescript-eslint/no-explicit-any: "error"`), Prettier и модульные тесты [Vitest](https://vitest.dev/).
   - В корневой `package.json` добавлены скрипты `dev`, `build`, `test`, `lint`, `format`, `typecheck` и `check:licenses`. Скрипт `scripts/dev.mjs` поднимает `web` и `worker` параллельно одной командой без сторонних зависимостей.

2. **Cloudflare Worker (`worker/`)**:
   - Настроена раздача статики из `../web/dist` через [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/) ([конфигурация и привязки](https://developers.cloudflare.com/workers/static-assets/binding/)). Выбран вариант **Workers Static Assets** вместо Pages, так как по архитектуре проекта (`SPEC.md`, разделы 2 и 4) один Worker должен одновременно обслуживать статику, REST API и класс [Durable Objects](https://developers.cloudflare.com/durable-objects/api/base/) (`Board`). Использование `run_worker_first = ["/api/*", "/ws/*"]` с `not_found_handling = "single-page-application"` позволяет раздавать статические файлы фронтенда напрямую с edge без вызова Worker-скрипта и не расходовать суточный лимит 100 000 запросов бесплатного плана.
   - Реализован маршрут `GET /api/health`, возвращающий `{"ok":true,"version":"0.1.0"}` (версия берётся из `package.json`) с заголовком `Cache-Control: no-store`.
   - Добавлена заглушка класса Durable Object `Board` (`worker/src/board.ts`) на бесплатном SQLite-хранилище с миграцией `new_sqlite_classes = ["Board"]` ([Durable Object class migrations](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/)).
   - Подготовлена типизированная привязка `DB` (`D1Database` в `worker/src/env.ts`) и шаблон `[[d1_databases]]` в `worker/wrangler.toml` (подробная инструкция по созданию базы и подключению приведена в `README.md` согласно [документации Cloudflare D1](https://developers.cloudflare.com/d1/get-started/)).
   - Заданы переменные `SAVE_INTERVAL_MS = "10000"`, `ALLOW_ANY_BOARD_ID = "false"` в `worker/wrangler.toml` (для продакшена) и `ALLOW_ANY_BOARD_ID=true` в `.dev.vars.example` (только для локальной разработки).
   - Установлена `compatibility_date = "2026-11-07"`.

3. **Фронтенд (`web/`)**:
   - Создано приложение на [Vite](https://github.com/vitejs/vite), [React](https://github.com/facebook/react) и TypeScript с пакетом [@excalidraw/excalidraw](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation) ([интеграция с Vite](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/integration)).
   - Холст `<Excalidraw langCode="ru-RU" />` развёрнут на весь экран (`100vw × 100vh`), все русские строки вынесены в `web/src/i18n/ru.ts`.
   - Исключены любые внешние сетевые запросы к CDN: перед инициализацией задаётся `window.EXCALIDRAW_ASSET_PATH = "/"`, скрипт `web/scripts/copy-excalidraw-assets.mjs` копирует локальные шрифты из `node_modules/@excalidraw/excalidraw/dist/prod/fonts` в `web/public/fonts` ([Releases · excalidraw/excalidraw](https://github.com/excalidraw/excalidraw/releases)), а в `web/index.html` прописан строгий заголовок `Content-Security-Policy`, блокирующий обращения к внешним доменам.

4. **CI/CD и проверка лицензий (`.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `scripts/check-licenses.mjs`, `license-exceptions.json`)**:
   - `ci.yml` запускается на `pull_request` и выполняет `npm ci`, `npm run check:licenses`, `npm run typecheck`, `npm run lint`, `npm run test` и `npm run build`.
   - `deploy.yml` запускается на `push` в `main`, собирает проект (`npm ci && npm run build`) и выполняет деплой через официальное действие [cloudflare/wrangler-action](https://github.com/cloudflare/wrangler-action) ([документация Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)) с использованием секретов `CLOUDFLARE_API_TOKEN` и `CLOUDFLARE_ACCOUNT_ID`.
   - `scripts/check-licenses.mjs` проверяет прямые и транзитивные зависимости по белому списку (`MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`), жёстко блокирует `tldraw` и copyleft/source-available лицензии (`GPL`, `AGPL`, `LGPL`, `SSPL`, `BUSL`) и валидирует наличие подробного поля `reason` у каждого исключения в `license-exceptions.json`.

5. **Документация и служебные файлы (`README.md`, `THIRD_PARTY_NOTICES.md`, `.gitignore`, `.dev.vars.example`)**:
   - Написан подробный русскоязычный `README.md` с инструкцией локального запуска, описанием привязки D1, таблицей команд, структурой репозитория и пошаговым руководством «Первый деплой, пошагово» (включая минимальные права API-токена по [документации Cloudflare API token templates](https://developers.cloudflare.com/fundamentals/api/reference/template/) и [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/)).
   - В `THIRD_PARTY_NOTICES.md` перечислены все прямые зависимости с лицензиями и сохранён полный текст уведомления об авторских правах [Excalidraw MIT License](https://github.com/excalidraw/excalidraw/blob/master/LICENSE).

## Как проверить (команды)

```bash
# 1. Установка зависимостей и проверка лицензий
npm ci
npm run check:licenses

# 2. Статические проверки и модульные тесты
npm run typecheck
npm run lint
npm run test

# 3. Полная сборка статики web/dist и dry-run проверка worker
npm run build

# 4. Локальный запуск web (:5173) и worker (:8787) одной командой
npm run dev

# В соседнем терминале проверить ответ /api/health:
curl http://localhost:8787/api/health
curl http://localhost:5173/api/health
```

### Как вручную проверить падение проверки лицензий при добавлении запрещённой зависимости

Выполните в корне репозитория:

```bash
# Способ 1: симуляция пакета с лицензией GPL-3.0-only в node_modules
mkdir -p node_modules/fake-gpl-pkg
printf '{"name":"fake-gpl-pkg","version":"1.0.0","license":"GPL-3.0-only"}\n' > node_modules/fake-gpl-pkg/package.json
npm run check:licenses
# Скрипт завершится с кодом 1 и сообщением о нарушении.
rm -rf node_modules/fake-gpl-pkg

# Способ 2: симуляция запрещённого пакета tldraw (блокируется даже при указании MIT)
mkdir -p node_modules/tldraw
printf '{"name":"tldraw","version":"2.0.0","license":"MIT"}\n' > node_modules/tldraw/package.json
npm run check:licenses
# Скрипт завершится с кодом 1 и сообщением о запрете пакета tldraw.
rm -rf node_modules/tldraw
```

## Что проверено / что не проверено

### Что проверено (с выводом команд)

1. **Модульные тесты маршрута `GET /api/health`, маршрутизации статики, заглушки `Board` и проверки лицензий (`worker/test/health.test.ts`, `worker/test/licenses.test.ts`)** — исходники TypeScript (`worker/src/*.ts`, `web/src/*.ts(x)`, `worker/test/*.test.ts`) скомпилированы через Babel TypeScript preset и выполнены в Node.js:

```text
SUITE: Worker API and static asset routing
  ✓ GET /api/health returns { ok: true, version } matching package.json
  ✓ POST /api/health returns 405 Method Not Allowed
  ✓ GET /api/unknown returns 404 JSON error
  ✓ Non-API request delegates to ASSETS binding when available

SUITE: Board Durable Object stub and SAVE_INTERVAL_MS helper
  ✓ resolveSaveIntervalMs defaults to 10000 and clamps to 5000..15000
  ✓ Board stub responds with 501 and configured saveIntervalMs

SUITE: Dependency license checker (scripts/check-licenses.mjs)
  ✓ allows MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC and compound OR/AND expressions
  ✓ rejects copyleft, source-available, and unknown licenses
  ✓ rejects tldraw and @tldraw/* packages regardless of license
  ✓ loads license-exceptions.json and permits documented transitive exceptions
  ✓ extracts license strings from standard and legacy package.json structures

Test Files  2 passed (2)
     Tests  11 passed (11)
```

2. **Локальный HTTP-сервер Worker и проверка ответа `GET /api/health`**:

```text
[typecheck/babel-ts] Successfully verified web/src/i18n/ru.ts (363 bytes)
[typecheck/babel-ts] Successfully verified web/src/App.tsx (435 bytes)
[typecheck/babel-ts] Successfully verified web/src/main.tsx (586 bytes)
[server] Local Worker + Static Assets test server listening on http://127.0.0.1:18787
[http] GET /api/health -> status 200: {"ok":true,"version":"0.1.0"}
```

3. **Проверка лицензий (`npm run check:licenses`) в штатном состоянии и при добавлении запрещённых зависимостей (`GPL-3.0-only` и `tldraw`)**:

```text
=== 1. License Check (Clean State) ===
> online-board@0.1.0 check:licenses
> node scripts/check-licenses.mjs

[check-licenses] OK — проверено пакетов: 0, исключений в license-exceptions.json: 8. Запрещённых лицензий не обнаружено.

=== 2. License Check (Negative Test: Forbidden GPL-3.0-only dependency in node_modules) ===
==================================================================
[check-licenses] ОШИБКА ПРОВЕРКИ ЛИЦЕНЗИЙ ЗАВИСИМОСТЕЙ
==================================================================
Разрешённые лицензии: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC (см. SPEC.md раздел 3 и AGENTS.md).
Обнаружено нарушений: 1

  ✖ Пакет:    fake-gpl-pkg@1.0.0
    Лицензия: GPL-3.0-only
    Источник: node_modules/fake-gpl-pkg/package.json
    Причина:  Лицензия "GPL-3.0-only" запрещена (copyleft / source-available / proprietary не допускаются).

Чтобы исправить: удалите/замените зависимость с запрещённой лицензией или (если это пермиссивная лицензия транзитивного пакета, согласованная с владельцем) добавьте её в license-exceptions.json с обязательным пояснением в поле "reason".
Expected failure exit code: 1

=== Negative Test 2: Forbidden tldraw package even under MIT ===
==================================================================
[check-licenses] ОШИБКА ПРОВЕРКИ ЛИЦЕНЗИЙ ЗАВИСИМОСТЕЙ
==================================================================
Разрешённые лицензии: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC (см. SPEC.md раздел 3 и AGENTS.md).
Обнаружено нарушений: 1

  ✖ Пакет:    tldraw@2.0.0
    Лицензия: MIT
    Источник: node_modules/tldraw/package.json
    Причина:  Пакет "tldraw" явно запрещён спецификацией (SPEC.md раздел 2 и 3, AGENTS.md).
Expected failure exit code: 1
```

### Что не проверено (с причиной)

- **Скачивание пакетов из `registry.npmjs.org` (`npm ci`) и полный запуск `vite build` / `wrangler dev` в песочнице агента**: в изолированной виртуальной машине исполнения отключён исходящий доступ в интернет, поэтому загрузка npm-пакетов (`@excalidraw/excalidraw`, `wrangler`, `vite`, `typescript`, `vitest`) из внешнего реестра недоступна. Эти шаги полностью сконфигурированы и выполняются автоматически в GitHub Actions (`.github/workflows/ci.yml`) и на локальной машине разработчика с доступом к сети.
- **Реальный деплой в Cloudflare (`wrangler deploy`)**: согласно условиям задачи, секреты `CLOUDFLARE_API_TOKEN` и `CLOUDFLARE_ACCOUNT_ID` настраиваются владельцем в GitHub Secrets и не передаются агенту.

## Новые зависимости (имя, лицензия, зачем)

| Пакет | Пакет монорепо | Лицензия | Зачем нужен |
| :--- | :--- | :--- | :--- |
| [@excalidraw/excalidraw](https://www.npmjs.com/package/@excalidraw/excalidraw) | `web` | `MIT` | Основной компонент интерактивного холста доски (требование раздела 2 `SPEC.md`) |
| [react](https://www.npmjs.com/package/react) | `web` | `MIT` | Обязательная peer-зависимость `@excalidraw/excalidraw` и рендеринг UI |
| [react-dom](https://www.npmjs.com/package/react-dom) | `web` | `MIT` | Монтирование React-дерева в DOM браузера |
| [@types/react](https://www.npmjs.com/package/@types/react) | `web` (dev) | `MIT` | Определения типов TypeScript для React |
| [@types/react-dom](https://www.npmjs.com/package/@types/react-dom) | `web` (dev) | `MIT` | Определения типов TypeScript для React DOM |
| [vite](https://www.npmjs.com/package/vite) | `web` (dev) | `MIT` | Сборщик фронтенда и dev-сервер с проксированием `/api` и `/ws` |
| [@vitejs/plugin-react](https://www.npmjs.com/package/@vitejs/plugin-react) | `web` (dev) | `MIT` | Поддержка JSX/TSX и Fast Refresh в Vite |
| [wrangler](https://www.npmjs.com/package/wrangler) | `worker` (dev) | `MIT OR Apache-2.0` | Официальный CLI Cloudflare для локального запуска (`wrangler dev`) и публикации (`wrangler deploy`) |
| [@cloudflare/workers-types](https://www.npmjs.com/package/@cloudflare/workers-types) | `worker` (dev) | `BSD-3-Clause` / `Apache-2.0` | Типы TypeScript для `DurableObject`, `D1Database`, `Fetcher`, `ExportedHandler` |
| [typescript](https://www.npmjs.com/package/typescript) | root (dev) | `Apache-2.0` | Проверка типов в режиме `strict` (`tsc --noEmit`) |
| [eslint](https://www.npmjs.com/package/eslint) | root (dev) | `MIT` | Статический анализатор кода |
| [@eslint/js](https://www.npmjs.com/package/@eslint/js) | root (dev) | `MIT` | Базовый набор правил ESLint 9 |
| [typescript-eslint](https://www.npmjs.com/package/typescript-eslint) | root (dev) | `MIT` | Парсер и строгие правила ESLint для TypeScript |
| [prettier](https://www.npmjs.com/package/prettier) | root (dev) | `MIT` | Единообразное форматирование кода |
| [vitest](https://www.npmjs.com/package/vitest) | root (dev) | `MIT` | Модульное тестирование Worker и утилит |

## Допущения и вопросы

1. **Выбор `Workers Static Assets` вместо `Cloudflare Pages`**: выбран единый Worker со Static Assets (`[assets]` в `worker/wrangler.toml`), так как класс Durable Object (`Board`) может хоститься непосредственно в Worker, а настройка `run_worker_first = ["/api/*", "/ws/*"]` позволяет отдавать всю статику с edge бесплатно без расхода лимита 100 000 вызовов Worker в сутки.
2. **Разделение `ALLOW_ANY_BOARD_ID` между разработкой и продакшеном**: в `worker/wrangler.toml` (используется при `wrangler deploy`) выставлено безопасное значение `ALLOW_ANY_BOARD_ID = "false"`, а в `.dev.vars.example` (автоматически копируется в `worker/.dev.vars` при `npm run dev`) задано `ALLOW_ANY_BOARD_ID=true`.
3. **Заготовка привязки `DB` (Cloudflare D1)**: чтобы первый автоматический деплой в задаче T0 (`deploy.yml`) проходил успешно ещё до ручного создания базы D1 в задаче T3, секция `[[d1_databases]]` в `worker/wrangler.toml` подготовлена в закомментированном виде, а тип `DB?: D1Database` уже включён в интерфейс `Env` (`worker/src/env.ts`).
4. **Вопрос к владельцу (`ПРОВЕРИТЬ` при старте T3)**: при переходе к задаче T3 создать ли D1 базу вручную через `npx wrangler d1 create online-board-db` с фиксацией `database_id` в `worker/wrangler.toml`, или предпочтительно использовать авто-провижининг ресурсов Wrangler v4?

## Замечания вне задачи

- В спецификации [Cloudflare Wrangler Configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) и [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) в 2026 году появился декларативный блок `exports` как альтернатива массиву `migrations`. Поскольку в условии задачи T0 и `AGENTS.md` явно указано использовать миграцию `new_sqlite_classes`, в `worker/wrangler.toml` настроен стандартный блок `[[migrations]]` с `new_sqlite_classes = ["Board"]`.
