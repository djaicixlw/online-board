# Промпт и инструкция T2.5b для агента с интернетом и браузером (Antigravity 2.0 / Gemini 3.8 Flash)

Все кодовые доработки разделов **A, B и C** из `PROMPT_T2_5b.md` уже внесены в репозиторий в ветке `task/T2.5-stabilize`:
- **Раздел A (пункты 1–4)**:
  - В `tsconfig.base.json` возвращён `"exactOptionalPropertyTypes": true` (все типы в `worker/` и `web/` приведены в полное соответствие).
  - В `eslint.config.mjs` возвращены правила `@typescript-eslint/no-non-null-assertion` и `@typescript-eslint/no-invalid-void-type`, убран ignore `**/artifacts/**`, устранены все операторы `!` в коде и тестах.
  - Удалены рукописные объявления типов `worker/src/cloudflare-workers.d.ts`, `worker/test/node-ambient.d.ts`, `scripts/check-licenses.d.ts`, `scripts/gen-board-id.d.ts`; в `worker/tsconfig.json` прописано `"types": ["@cloudflare/workers-types", "node"]`.
  - Из `license-exceptions.json` удалены добавленные по памяти исключения `MPL-2.0` (`axe-core`, `lightningcss`), а из `scripts/check-licenses.mjs` убрана поддержка `"*"`.
- **Раздел B (пункты 5–11)**:
  - **Пункт 5**: в `worker/src/board.ts` (`closeSessionInternal`, `webSocketClose`, `webSocketError`) при `this.dirty === true` сброс `flushSnapshot("connection_close", nowMs)` выполняется немедленно при закрытии любого сокета, не пересчитывая остальные сокеты.
  - **Пункт 6**: добавлен потолок размера доски (`MAX_BOARD_ELEMENTS = 20_000`, `MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024`); при превышении возвращается `{"type":"error","code":"board_too_large"}` и показывается русская плашка ошибки в `web/src/App.tsx`.
  - **Пункт 7**: при ошибке разбора снимка (`snapshot_load_error`) повреждённые куски сохраняются в таблицу `snapshot_backup`, логируется `snapshot_corrupted_backup_saved`, а флаг `snapshotCorrupted` блокирует перезапись таблицы `snapshot` пустой сценой.
  - **Пункт 8**: в `flushSnapshot()` вычисляется дайджест каждого куска (`computeChunkDigest`) и в SQLite записываются только изменившиеся куски.
  - **Пункт 9**: генерация случайного ID доски на `/` и кнопка «Открыть новую доску» в `web/src/App.tsx` оставлены только в режиме разработки (`import.meta.env.DEV`); в продакшене корень `/` показывает «Откройте ссылку на доску, которую вам прислал преподаватель».
  - **Пункт 10**: режим пера по умолчанию выключен (`penMode = false`, режим «авто»), автоматически включается при первом касании пером и переключается вручную; касания пальцем по тулбару Excalidraw (`isExcalidrawUiTarget`) не блокируются.
  - **Пункт 11**: `scripts/ws-smoke.mjs` переписан на подключение к настоящему `wrangler dev` по `WS_SMOKE_URL` (по умолчанию `ws://localhost:8787`) с использованием только пакетов из `node_modules`.
- **Раздел C (пункты 12–14)**:
  - В `worker/test/board.runtime.test.ts` убран переход на шим: при `CI` или `REQUIRE_RUNTIME=1` тест падает, если `Miniflare` не загрузился; без переменной выводит предупреждение и помечается как `skip`. В `.github/workflows/ci.yml` и `deploy.yml` добавлен `REQUIRE_RUNTIME: "1"`.
  - В `board.runtime.test.ts` ожидание `alarm` увеличено до `2 600` мс (для продакшен-зажима `2 000` мс), добавлена проверка немедленного сброса при закрытии сокета и проверка 15 секунд тишины на `Miniflare`.

---

## Готовый промпт для агента с интернетом и браузером (скопируйте целиком)

```text
Ты исполнитель задачи T2.5b в проекте «онлайн-доска для уроков». Прочитай SPEC.md, AGENTS.md и docs/PR_T2_5_stabilize.md полностью, правила обязательны. Работай в ветке task/T2.5-stabilize (продолжение предыдущей работы), результат оформи в виде PR, в main не пушь (AGENTS.md запрещает). В PR пиши только то, что реально запустил, без самооценок вроде «0 ошибок» и «100%».

В ветке task/T2.5-stabilize уже написан код разделов A, B и C задачи T2.5b. Твоя задача — проверить пункты A–C и выполнить раздел D на Node 22 с настоящим реестром npm, настоящим рантаймом workerd (Miniflare и wrangler dev) и браузером Chromium (Playwright):

A. Проверь, что в коде соблюдены все требования разделов A–C:
1. tsconfig.base.json содержит "exactOptionalPropertyTypes": true. Если при настоящем tsc --noEmit что-то не собирается, исправь код (без ослабления tsconfig).
2. eslint.config.mjs не выключает @typescript-eslint/no-non-null-assertion и @typescript-eslint/no-invalid-void-type и не содержит ignore **/artifacts/**.
3. Рукописных .d.ts-заглушек (worker/src/cloudflare-workers.d.ts, worker/test/node-ambient.d.ts) нет. Если после npm install падает typecheck, поправь конфигурацию tsconfig / зависимости, не создавая своих .d.ts-заглушек.
4. После настоящего npm install выполни `npm ls axe-core lightningcss`. Если они входят в дерево, не добавляй MPL-2.0 в license-exceptions.json молча: оставь вопрос владельцу в PR (пакет, путь зависимости, назначение, продакшен или только разработка). В license-exceptions.json оставь только те пермиссивные исключения, которые реально понадобились на настоящем прогоне `npm run check:licenses`.

D. Настоящие проверки (на Node 22 в чистой копии):
15. Удали package-lock.json, если он есть, выполни `npm install` с настоящим реестром (версии в границах package.json: Excalidraw ^0.18, Vite ^5.4, wrangler ^4), закоммить новый package-lock.json, затем склонируй репозиторий в новый каталог (`git clone . /tmp/online-board-clean`) и выполни там `npm ci`.
16. В чистой копии на Node 22 выполни по очереди и приложи в docs/PR_T2_5_stabilize.md полный реальный вывод команд:
   - `npm run check:licenses` (с реальным числом проверенных пакетов из сотен зависимостей);
   - `npm run typecheck` (`tsc --noEmit` с `exactOptionalPropertyTypes: true`);
   - `npm run lint`;
   - `REQUIRE_RUNTIME=1 npm test` (убедись, что `worker/test/board.runtime.test.ts` реально прошёл на Miniflare, а не был пропущен);
   - `npm run build`;
   - `npx playwright install chromium && npm run test:e2e`.
   Чини только то, что падает, не ослабляя тесты и конфигурацию.
17. Живой сценарий на `wrangler dev`:
   - Запусти `npm run dev` в фоновом режиме и прогони `npm run smoke:ws` против настоящего `wrangler dev` (`ws://localhost:8787`).
   - Проверь на живом `wrangler dev`:
     а) одно сообщение `scene_update`, пауза 15 секунд, новое подключение — элемент на месте;
     б) штрих (`scene_update`) и немедленное закрытие сокета/вкладки, новое подключение — элемент на месте.
   - Приложи в `docs/PR_T2_5_stabilize.md` фактические строки лога `snapshot_flush` (`rowsWritten`) с настоящего рантайма `wrangler dev` и фактический список запросов браузера из вкладки Network (из прогона Playwright Chromium).
18. Проверь, что все правки закоммичены в ветку `task/T2.5-stabilize`, и оформи финальное описание PR в `docs/PR_T2_5_stabilize.md` с разделами «Что проверено» (с реальными выводами команд) и «Что не проверено».

E. Деплой (НЕ выполняй сам):
19. Не сливай ветку в `main` и не запускай `wrangler deploy` или `wrangler secret put` сам (AGENTS.md запрещает прямой пуш в `main` и деплой без разрешения владельца). Оставь в PR готовую пошаговую инструкцию для владельца.
```
