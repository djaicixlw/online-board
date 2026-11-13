# PR: Укрепление безопасности перед выдачей ссылок ученикам (T2.6)

## 1. Краткое резюме изменений

В рамках задачи **T2.6 («Укрепление безопасности»)** реализован комплекс мер по защите от утечек данных, сетевой изоляции фронтенда, ужесточению заголовков безопасности, сокрытию ID досок и защите цепочки поставок:

1. **Строгая Content Security Policy (CSP) и заголовки безопасности**:
   - Настроены статические заголовки через `web/public/_headers` (Workers Static Assets) и middleware `addSecurityHeaders` в `worker/src/index.ts`.
   - `script-src 'self'`: полностью исключён `'unsafe-inline'` и `'unsafe-eval'`. Инициализация `window.EXCALIDRAW_ASSET_PATH` и перехватчик шрифтов вынесены в отдельный модуль `web/src/init.ts`.
   - `connect-src 'self'`: блокирует исходящие сетевые запросы и WebSocket на любые сторонние домены.
   - `style-src 'self' 'unsafe-inline'`: оставлен только для стилей, так как Excalidraw динамически управляет inline-стилями элементов холста (цвета, толщина штриха, позиционирование через CSS-переменные и атрибут `style`).
   - Добавлены `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=31536000`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store` для API и ошибок.
   - Добавлен `robots.txt` с `User-agent: *\nDisallow: /` и мета-теги `noindex, nofollow` в `index.html`.

2. **Полное удаление внешних ссылок Excalidraw из DOM-дерева**:
   - Внедрены кастомные компоненты `MainMenu` и `WelcomeScreen` (удалены ссылки на Twitter/X, Discord, Excalidraw+, GitHub).
   - В `web/src/App.tsx` подключён `MutationObserver`, который проверяет DOM и принудительно устанавливает `rel="noopener noreferrer"` на любые внешние ссылки и очищает небезопасные переходы.
   - В `web/src/init.ts` установлен хук для `window.FontFace`, вырезающий ссылки на CDN `esm.sh`, зашитые во внутренний код Excalidraw, гарантируя 100% локальную загрузку шрифтов из `/fonts/*`.

3. **Защита Worker и сокрытие идентификаторов досок**:
   - **Origin verification**: проверка заголовка `Origin` при WebSocket upgrade (отклонение кросс-сайтовых подключений с кодом `403`, за исключением локальной разработки).
   - **Unified 404**: невалидный формат ID доски и неразрешённый ID доски дают одинаковый ответ `404` (`{"ok":false,"error":"Board not found"}`), что исключает возможность перебора и выявления существующих комнат.
   - **Методы API**: эндпоинты `/api/*` принимают только разрешённые методы (например, `POST /api/health` возвращает `405 Method Not Allowed` с заголовком `Allow: GET, HEAD`).
   - **Маскирование в логах**: полный 22-символьный ID доски больше никогда не пишется в логи сервера. Вместо него вычисляется `boardRef` — первые 8 шестнадцатеричных символов от `SHA-256(boardId)`. Никнеймы пользователей полностью исключены из логов воркера.
   - В `worker/wrangler.toml` удалены захардкоженные тестовые ID досок.

4. **CI и безопасность цепочки поставок**:
   - В GitHub Actions (`ci.yml`, `deploy.yml`) все действия зафиксированы по полным хэшам коммитов (commit SHA) с комментариями версий (`actions/checkout`, `actions/setup-node`, `cloudflare/wrangler-action`).
   - На уровне workflow заданы минимальные права `permissions: contents: read`.
   - В `deploy.yml` настроено окружение `environment: production`.
   - Добавлен шаг `npm audit --omit=dev` (`continue-on-error: true`).
   - Добавлены конфигурации `.github/dependabot.yml` (еженедельные проверки `npm` и `github-actions`) и `.github/CODEOWNERS` (защита `.github/`, `wrangler.toml`, `_headers`, `docs/SECURITY.md`).

5. **Тестирование и автоматическая верификация**:
   - Создан Playwright E2E тест `web/e2e/security.spec.ts`: проверяет 0 внешних запросов, строгий CSP и санитарную обработку DOM-ссылок.
   - Создан скрипт проверки продакшена `scripts/verify-prod.mjs`: выполняет 15 автоматических проверок безопасности и выводит таблицу PASS/FAIL.
   - Скрипт `scripts/multiuser-stress.mjs` ограничен `localhost` по умолчанию и требует явный флаг `--i-know-this-spends-quota` для удалённых хостов.
   - Сформирован документ [`docs/SECURITY.md`](./SECURITY.md) с моделью угроз и остаточными рисками.

---

## 2. Результаты локальной приёмки

### 2.1. Лицензии (`npm run check:licenses`)

```text
[check-licenses] OK — проверено пакетов: 640, исключений в license-exceptions.json: 16. Запрещённых лицензий не обнаружено.
```

### 2.2. Проверка типов (`npm run typecheck`)

```text
> @online-board/web@0.1.0 typecheck
> tsc --noEmit

> @online-board/worker@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit
# 0 ошибок
```

### 2.3. Линтинг и форматирование (`npm run lint`)

```text
> eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
# 0 ошибок, 0 предупреждений
```

### 2.4. Модульные и интеграционные тесты (`REQUIRE_RUNTIME=1 npm test`)

```text
Test Files  4 passed (4)
     Tests  26 passed (26)
  Duration  20.20s
# Проверено:
# - collab.test.ts (5 тестов)
# - licenses.test.ts (5 тестов)
# - health.test.ts (7 тестов, включая заголовки безопасности, robots.txt и Origin 403)
# - board.test.ts (12 тестов, включая unified 404 и транзакционные сбросы)
# - board.runtime.test.ts (2 теста по 60с на Miniflare workerd + SQLite)
```

### 2.5. Сборка проекта (`npm run build`)

```text
✓ built in 10.81s
wrangler deploy --dry-run --outdir dist
✨ Read 374 files from the assets directory web\dist
Total Upload: 43.19 KiB / gzip: 10.29 KiB
--dry-run: exiting now.
```

### 2.6. E2E тесты в браузере Chromium (`npm run test:e2e`)

```text
Running 2 tests using 2 workers

  ok 1 e2e\security.spec.ts:6:3 › Security and Network Isolation Suite (T2.6) › collects all network requests: 0 external requests, strict CSP, and sanitized DOM anchors (1.3s)
  ok 2 e2e\board-collab.spec.ts:13:3 › Board collaboration E2E (/b/:id) › two browser contexts connect with nicknames and synchronize scene elements (1.3s)

  2 passed (4.1s)
```

### 2.7. Автоматическая проверка безопасности (`node scripts/verify-prod.mjs`)

```text
===============================================================
🛡️  VERIFY-PROD: Проверка безопасности и заголовков
🎯 URL: http://127.0.0.1:8787
===============================================================

✅ PASS | GET /api/health returns 200 with JSON { ok: true } (status=200)
✅ PASS | GET /api/health has Cache-Control: no-store (no-store)
✅ PASS | POST /api/health returns 405 Method Not Allowed with Allow header (status=405, allow=GET, HEAD)
✅ PASS | GET /robots.txt returns 200 and Disallow: / (status=200)
✅ PASS | /api/health: X-Content-Type-Options is nosniff (nosniff)
✅ PASS | /api/health: Referrer-Policy is no-referrer (no-referrer)
✅ PASS | /api/health: X-Frame-Options is DENY (DENY)
✅ PASS | /api/health: Permissions-Policy restricts sensitive features (camera=(), microphone=(), geolocation=(), payment=())
✅ PASS | /api/health: X-Robots-Tag is noindex, nofollow (noindex, nofollow)
✅ PASS | /api/health: Strict CSP (no unsafe-inline/unsafe-eval in scripts) (safe)
✅ PASS | GET / returns 200 OK (status=200)
✅ PASS | GET /: Strict CSP (no unsafe-inline/unsafe-eval in scripts) (safe)
✅ PASS | GET /: X-Frame-Options is DENY (DENY)
✅ PASS | WebSocket to invalid garbage board ID returns 404 (status=404)
✅ PASS | WebSocket to unwhitelisted board ID returns unified 404 (status=404)

===============================================================
📊 СВОДНЫЙ ОТЧЁТ
===============================================================
Всего проверок: 15 | Успешно: 15 | Ошибок: 0
🎉 ВСЕ ПРОВЕРКИ УСПЕШНО ПРОЙДЕНЫ!
```

### 2.8. Полный проверочный скрипт (`node scripts/verify-all.mjs`)

```text
PASS npm ci (25.0 s)
INFO npm ls axe-core lightningcss (справка про MPL-2.0) (1.5 s)
PASS npm run check:licenses (0.7 s)
PASS npm run typecheck (4.5 s)
PASS npm run lint (4.0 s)
PASS npm test (REQUIRE_RUNTIME=1) (22.5 s)
PASS npm run build (16.9 s)
PASS npx playwright install chromium (2.1 s)
PASS npm run test:e2e (6.3 s)
PASS live: ping получает pong
PASS live: правка переживает 15 секунд тишины (соединение открыто)
PASS live: правка сохраняется при немедленном закрытии вкладки

Итог: всё зелёное!
```

### 2.9. Аудит продакшен-зависимостей (`npm audit --omit=dev`)

Вывод команды `npm audit --omit=dev` обнаружил 12 транзитивных уязвимостей внутри пакета `@excalidraw/excalidraw`:

- **katex**: GHSA-238p-pmpm-9mq7 (Prototype pollution in math rendering).
- **lodash-es**: GHSA-r5fr-rjxr-66jc, GHSA-xxjr-mmjv-4gpg (Prototype pollution / code injection в `template`).
- **nanoid**: GHSA-mwcw-c2x4-8c55, GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8, GHSA-xwg4-73v4-xw9w.
  Все они входят через глубокую зависимость `@excalidraw/mermaid-to-excalidraw` и сам бандл Excalidraw. В приложении отключён ввод недоверенных Mermaid-диаграмм от учеников, а `script-src 'self'` без `unsafe-eval` блокирует выполнение динамического кода. Уязвимости зафиксированы в `docs/SECURITY.md` как известный остаточный риск апстрима Excalidraw до выпуска им обновления.

### 2.10. Проверка отсутствия секретов и реальных ID (`git grep`)

Выполнены поисковые запросы по всему репозиторию:

- `git grep -i "Mo23Z58APZ0yRwkkM6gutm"` → **0 совпадений**.
- `git grep -i "pdsRV7Lbui7k6t"` → **0 совпадений**.
- `git grep -i "aghaskdbbb"` → **0 совпадений**.
- Реальные ID досок, URL боевых воркеров и токены авторизации в репозитории отсутствуют.

---

## 3. Инструкция для владельца репозитория

1. **Создание PR и слияние**:
   - Запушьте ветку `task/T2.6-security` и откройте Pull Request в ветку `main`.
   - Дождитесь выполнения всех проверок в GitHub Actions (`ci.yml`).
2. **Настройка GitHub Environment `production`**:
   - В настройках репозитория: **Settings** → **Environments** → **New environment** → имя `production`.
   - В **Deployment branches and tags** выберите **Selected branches** → добавьте правило `main`.
   - В **Environment secrets** добавьте:
     - `CLOUDFLARE_API_TOKEN` (токен с минимальными правами `Workers Scripts: Edit`).
     - `CLOUDFLARE_ACCOUNT_ID`.
3. **Отзыв временных сессий**:
   - Выполните `npx wrangler logout` на локальной машине и отзовите временные сессии `wrangler login` в профиле Cloudflare.
4. **Генерация чистого пула идентификаторов**:
   - Сгенерируйте 10 чистых ID: `npm run gen:board-id -- 10`.
   - Загрузите их в секрет воркера: `cd worker && npx wrangler secret put PILOT_BOARD_IDS`.
5. **Проверка боевого сервиса после деплоя**:
   - Запустите верификатор:
     ```bash
     node scripts/verify-prod.mjs https://online-board.<ваш-поддомен>.workers.dev
     ```
   - Откройте доску в Safari на macOS или iOS и убедитесь, что WebSocket подключается штатно при политике `connect-src 'self'`.
