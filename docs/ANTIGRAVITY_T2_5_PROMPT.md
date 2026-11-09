# Инструкция и готовый промпт для агента Antigravity 2.0 (Gemini 3.8 Flash) — Завершение T2.5 и Деплой

В этом документе собрана:
1. **Пошаговая инструкция для вас** (как передать проект в Antigravity 2.0 и какие секреты подготовить для деплоя).
2. **Готовый детальный промпт (Copy-Paste)** для агента **Antigravity 2.0 (Gemini 3.8 Flash)**, чтобы он выполнил все шаги, требующие доступа к npm-реестру, локальному `workerd` (`wrangler dev` / `Miniflare`), браузеру Chromium (Playwright) и Cloudflare.

---

## Часть 1. Что уже сделано в репозитории (в ветке `task/T2.5-stabilize`)

Все изменения кода, конфигурации, тестов и документации по задаче **T2.5 («Стабилизация перед пилотом»)** уже написаны, протестированы в песочнице (26/26 тестов) и закоммичены в ветку `task/T2.5-stabilize`:
- Удалён синтетический `package-lock.json` (без `resolved` и `integrity`), а версии в `package.json`, `web/package.json` и `worker/package.json` выставлены в точных границах (`@excalidraw/excalidraw: "^0.18.0"`, `vite: "^5.4.10"`, `wrangler: "^4.0.0"`, `@cloudflare/workers-types: "^4.20250214.0"`, `miniflare: "^4.0.0"`, `esbuild: "^0.25.0"`).
- Обновлены `scripts/check-licenses.mjs` (корректный разбор `OR`-лицензий и fallback-чтение `node_modules`) и `license-exceptions.json`.
- Реализована защита пилотных досок через секрет `PILOT_BOARD_IDS` (до 50 base62 ID через запятую при `ALLOW_ANY_BOARD_ID=false`), создан генератор `scripts/gen-board-id.mjs` (`npm run gen:board-id -- N`).
- Устранена гонка между `alarm()` и 10-секундным порогом WebSocket Hibernation в Cloudflare: `SAVE_INTERVAL_MS` по умолчанию снижен до **`5000` мс (5 с)** (в продакшене зажимается в `2000..8000` мс). Обновлены `worker/src/board.ts`, `worker/wrangler.toml`, `.dev.vars.example` и `SPEC.md`.
- Убраны лишние записи в таблицу `meta` при каждом `flushSnapshot()`, а `DELETE FROM snapshot WHERE chunk_idx >= ?` вызывается только при уменьшении числа чанков (1 строка SQLite на 1-чанковый сброс вместо 3/2 строк).
- Добавлен интеграционный тест `worker/test/board.runtime.test.ts` (автоматически запускает реальный `Miniflare` с `useSQLite: true`, когда пакет `miniflare` установлен в `node_modules`).
- Обновлены `.github/workflows/deploy.yml` (`concurrency` + шаги `check:licenses`, `typecheck`, `lint`, `test` перед `build` и деплоем) и `README.md`.

---

## Часть 2. Как подготовить окружение перед запуском Antigravity 2.0

1. Распакуйте архив `online-board-T2.5-stabilize.zip` в рабочую папку проекта (или откройте репозиторий, где активна ветка `task/T2.5-stabilize`).
2. Если вы хотите, чтобы агент Antigravity 2.0 сразу задеплоил проект в Cloudflare и прописал секрет `PILOT_BOARD_IDS`, выполните вход в Wrangler (`npx wrangler login`) или экспортируйте в терминале переменные:
   ```bash
   export CLOUDFLARE_ACCOUNT_ID="<ваш_32_символьный_Account_ID>"
   export CLOUDFLARE_API_TOKEN="<ваш_API_Token_с_правами_Workers_Scripts_Edit>"
   ```
3. Скопируйте и отправьте агенту **Antigravity 2.0 (Gemini 3.8 Flash)** промпт из **Части 3** ниже.

---

## Часть 3. Готовый промпт для агента Antigravity 2.0 (скопируйте целиком)

```markdown
Ты — исполнитель финальной фазы задачи T2.5 «Стабилизация перед пилотом» и релиз-инженер проекта «онлайн-доска для уроков».
Обязательно сначала прочитай `SPEC.md`, `AGENTS.md` и `docs/PR_T2_5_stabilize.md`. Все правила из `AGENTS.md` (TypeScript strict, без `any` и `@ts-ignore`, комментарии в коде на английском, строки UI на русском в `web/src/i18n/ru.ts`, честный отчёт с реальным выводом команд) строго обязательны.

Текущее состояние репозитория:
Мы находимся в ветке `task/T2.5-stabilize`. Вся кодовая часть T2.5 уже реализована:
- Синтетический `package-lock.json` удалён.
- Закрыт доступ к произвольным доскам на пилоте через секрет `PILOT_BOARD_IDS` (до 50 ID base62 через запятую при `ALLOW_ANY_BOARD_ID=false`) и скрипт `scripts/gen-board-id.mjs`.
- Устранена гонка между `alarm()` и 10-секундным порогом WebSocket Hibernation: `SAVE_INTERVAL_MS` уменьшен до `5000` мс (в продакшене зажат в `2000..8000` мс).
- Из `flushSnapshot()` в `worker/src/board.ts` убраны записи в таблицу `meta`, а `DELETE FROM snapshot WHERE chunk_idx >= ?` выполняется только при уменьшении числа чанков (1 строка на сброс для 1-чанковой доски).
- Добавлен интеграционный тест `worker/test/board.runtime.test.ts` на базе `Miniflare` (`useSQLite: true`).
- В `.github/workflows/deploy.yml` добавлены `concurrency` и шаги `check:licenses`, `typecheck`, `lint`, `test` перед `build` и деплоем.

Твоя задача — выполнить все шаги на реальном реестре npm, реальной среде Workers (`workerd` / `wrangler dev`), в реальном браузере Chromium (Playwright), обновить отчёт в `docs/PR_T2_5_stabilize.md` реальными логами и выполнить деплой в Cloudflare:

### Шаг 1. Генерация настоящего `package-lock.json` и проверка `npm ci` в чистом клоне
1. Убедись, что старого `package-lock.json` нет (`rm -f package-lock.json`), и выполни:
   ```bash
   npm install
   ```
   Проверь, что версии остались в границах `package.json` (`@excalidraw/excalidraw` `^0.18`, `vite` `^5.4`, `wrangler` `^4`), а в новом `package-lock.json` у пакетов присутствуют поля `resolved` и `integrity`.
2. Закоммить сгенерированный `package-lock.json` в ветку `task/T2.5-stabilize`.
3. Сделай чистый клон репозитория во временный каталог (например, `git clone . /tmp/online-board-clean-ci`) и выполни там:
   ```bash
   cd /tmp/online-board-clean-ci && npm ci
   ```
   Убедись, что `npm ci` проходит с кодом `0`.

### Шаг 2. Реальные проверки (`check:licenses`, `typecheck`, `lint`, `test`, `build`)
В чистой копии (или в рабочей папке после `npm ci`) выполни по очереди и сохрани полный вывод каждой команды:
1. `npm run check:licenses`
   - Если в реальном дереве `node_modules` встретится транзитивный пакет с пермиссивной лицензией вне базового списка (`MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`), добавь его в `license-exceptions.json` с подробным русским пояснением в поле `"reason"` (без ослабления запрета на `GPL`/`AGPL`/`LGPL`/`SSPL`/`BUSL`/`tldraw`).
2. `npm run typecheck`
   - Если `tsc --noEmit` покажет ошибки типов на реальных пакетах `@excalidraw/excalidraw` или `@cloudflare/workers-types`, аккуратно исправь только их (строго без `any` и без `@ts-ignore`).
3. `npm run lint`
   - Если Prettier укажет на форматирование, выполни `npm run format` и перепроверь `npm run lint`.
4. `npm test`
   - Убедись, что проходят все модульные тесты в `web` и `worker`, включая `worker/test/board.runtime.test.ts` на настоящем `Miniflare` (`useSQLite: true`). Тесты не удаляй и проверки в них не ослабляй.
5. `npm run build`
   - Убедись, что `web/dist` успешно собирается (включая локальные шрифты Excalidraw в `web/dist/fonts/`), а `wrangler deploy --dry-run --outdir dist` в `worker/` проходит без ошибок.

### Шаг 3. Живая проверка устранения гонки `alarm()` и гибернации на `wrangler dev` (пауза 15 секунд)
1. Запусти локально `worker` (`npx --workspace=@online-board/worker wrangler dev --port 8787`).
2. Подключись WebSocket-клиентом к `/ws/AbCdEfGhIjKlMnOpQrSt12?nick=Tester`, отправь `hello` и один `scene_update` с тестовым элементом (`id: "live-15s-test"`).
3. Подожди **15 секунд в полной тишине** (чтобы через 5 секунд сработал `alarm()` и записал снимок в SQLite до 10-секундного порога WebSocket Hibernation).
4. Перезапусти процесс `wrangler dev` (или открой новое WebSocket-соединение после гибернации), отправь `hello` и убедись, что в полученном `snapshot` элемент `"live-15s-test"` сохранён.

### Шаг 4. Сквозной E2E-тест двух браузеров в Playwright Chromium
1. Установи браузер Chromium для Playwright:
   ```bash
   npx playwright install chromium
   ```
2. Запусти сквозной E2E-тест:
   ```bash
   npm run test:e2e
   ```
3. Если в реальном браузере выявится тайминг или селектор в `web/e2e/board-collab.spec.ts` или `web/src/App.tsx`, почини его и добейся зелёного прохождения `1 passed` (два контекста браузера входят на `/b/:id`, вводят ники, первый загружает сцену с прямоугольником `e2e-rect-1`, второй получает элемент по WebSocket).

### Шаг 5. Обновление отчёта PR, слияние и деплой в Cloudflare
1. Вставь реальный вывод всех выполненных команд (`npm ci`, `npm run check:licenses`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`) в раздел 4 файла `docs/PR_T2_5_stabilize.md`.
2. Закоммить все изменения в ветку `task/T2.5-stabilize`,слей в `main` (или отправь ветку в `origin` и открой/слей PR).
3. Сгенерируй стартовый набор из 10 ID досок для пилота:
   ```bash
   npm run gen:board-id -- 10
   ```
4. Если в окружении настроена авторизация Cloudflare (`wrangler login` или `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`):
   - Выполни деплой Worker со статикой:
     ```bash
     npm --workspace=@online-board/worker run deploy
     ```
   - Установи секрет `PILOT_BOARD_IDS` со сгенерированными 10 ID досок:
     ```bash
     cd worker && npx wrangler secret put PILOT_BOARD_IDS
     ```
   - Проверь живой `GET https://online-board.<поддомен>.workers.dev/api/health` и открытие пилотной доски `/b/<ID_из_PILOT_BOARD_IDS>`, а также убедись, что случайный ID не из списка отдаёт `404` при попытке WebSocket-подключения.
   - Выведи пользователю готовый список из 10 ссылок на доски для раздачи ученикам пилота.
```
