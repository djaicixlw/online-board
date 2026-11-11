# Промпт и инструкция T2.5b + T2.5c для агента с интернетом и браузером (Antigravity 2.0 / Gemini 3.8 Flash)

Все кодовые доработки из **`PROMPT_T2_5b.md` (разделы A, B, C, E)** и **`PROMPT_T2_5c.md` (пункты 1–5)** уже внесены в репозиторий в ветке `task/T2.5-stabilize`:
- **T2.5c п. 1 (`flushSnapshot` и откат транзакции)**: в `worker/src/board.ts` новые дайджесты (`stagedDigests`), число кусков (`stagedChunksCount`) и `stagedSchemaInitialized` собираются во временные переменные внутри `runTx` и записываются в поля объекта (`this.persistedChunkDigests`, `this.lastPersistedChunksCount`, `this.schemaInitialized`) только после успешного завершения `transactionSync`. Добавлен модульный тест с выбросом исключения в `sql.exec` посередине сброса и последующим успешным сбросом всех кусков.
- **T2.5c п. 2 (`snapshot_backup` и `board_not_saved`)**: если при повреждённом снимке резервная копия в `snapshot_backup` записана успешно, объект логирует `snapshot_corrupted_backup_saved` один раз, стартует с пустой сценой и дальше сохраняет новые правки как обычно. Запись блокируется (`this.snapshotSaveBlocked = true`) только если создать резервную копию в `snapshot_backup` не удалось — в этом случае при `hello` клиенту отправляется `{"type":"error","code":"board_not_saved"}`, а клиент показывает постоянную плашку «Доска повреждена, изменения не сохраняются. Сообщите преподавателю». В `README.md` описано восстановление из `snapshot_backup`.
- **T2.5c п. 3 (разделение `tsconfig` в `worker/`)**: `worker/tsconfig.json` проверяет `src/**/*.ts` строго с `"types": ["@cloudflare/workers-types"]`, а `worker/tsconfig.test.json` проверяет `test/**/*.ts` с `"types": ["@cloudflare/workers-types", "node"]`; скрипт `typecheck` в `worker/package.json` запускает оба.
- **T2.5c п. 4 (разделение `board.runtime.test.ts` и тайм-ауты)**: `worker/test/board.runtime.test.ts` разделён на 2 независимых теста с тайм-аутом `60 000` мс каждый (короткие проверки протокола/диска отдельно, сценарий «15 секунд тишины» отдельно).
- **T2.5c п. 5 (порядок merge и `PILOT_BOARD_IDS`)**: в `README.md` и `docs/PR_T2_5_stabilize.md` зафиксирован точный порядок: сначала секреты GitHub (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`), затем первый деплой (слияние PR в `main`), затем `wrangler secret put PILOT_BOARD_IDS`, затем ссылки ученикам.

---

## Готовый промпт для агента с интернетом и браузером (скопируйте целиком)

```text
Ты исполнитель задачи T2.5b + T2.5c в проекте «онлайн-доска для уроков». Прочитай SPEC.md, AGENTS.md и docs/PR_T2_5_stabilize.md полностью, правила обязательны. Работай в ветке task/T2.5-stabilize (продолжение предыдущей работы), результат оформи в виде PR, в main не пушь (AGENTS.md запрещает). В PR пиши только то, что реально запустил, без самооценок вроде «0 ошибок» и «100%».

В ветке task/T2.5-stabilize уже написан код всех пунктов T2.5b (разделы A, B, C, E) и T2.5c (пункты 1–5):
1. В flushSnapshot (worker/src/board.ts) новые дайджесты и число кусков применяются к полям объекта только после успешного завершения transactionSync (плюс тест на выброс исключения в sql.exec посередине сброса).
2. При повреждённом снимке (loadSnapshotFromSqlite): если копия в snapshot_backup записана успешно, объект стартует с пустой сценой и продолжает сохранять правки как обычно; запись блокируется только если записать snapshot_backup не удалось (при hello отправляется {"type":"error","code":"board_not_saved"}, клиент показывает постоянную плашку).
3. В worker/ разделены tsconfig.json (только @cloudflare/workers-types для src) и tsconfig.test.json (для test), скрипт typecheck проверяет оба.
4. В worker/test/board.runtime.test.ts тесты разделены на два независимых теста (короткие проверки отдельно, сценарий «15 секунд тишины» отдельно) с тайм-аутом 60 секунд каждый.
5. В README.md описано восстановление из snapshot_backup и точный порядок первого деплоя (секреты GitHub -> первый деплой -> PILOT_BOARD_IDS -> ссылки ученикам).

Твоя задача — выполнить раздел D (настоящие проверки) на Node 22 с настоящим реестром npm, настоящим рантаймом workerd (Miniflare и wrangler dev) и браузером Chromium (Playwright):

1. Удали package-lock.json, если он есть, выполни `npm install` с настоящим реестром (версии в границах package.json: Excalidraw ^0.18, Vite ^5.4, wrangler ^4), закоммить новый package-lock.json, затем склонируй репозиторий в новый каталог (`git clone . /tmp/online-board-clean`) и выполни там `npm ci`.
2. Выполни `npm ls axe-core lightningcss`. Если они входят в дерево, не добавляй MPL-2.0 в license-exceptions.json молча: оставь вопрос владельцу в PR (пакет, путь зависимости, назначение, продакшен или только разработка). В license-exceptions.json оставь только те пермиссивные исключения, которые реально понадобились на настоящем прогоне `npm run check:licenses`.
3. В чистой копии на Node 22 выполни по очереди и приложи в docs/PR_T2_5_stabilize.md полный реальный вывод команд:
   - `npm run check:licenses` (с реальным числом проверенных пакетов из сотен зависимостей);
   - `npm run typecheck` (проверяет web/tsconfig.json, worker/tsconfig.json и worker/tsconfig.test.json с `exactOptionalPropertyTypes: true`);
   - `npm run lint` (без отключённых правил);
   - `REQUIRE_RUNTIME=1 npm test` (замерь фактическую длительность обоих тестов в `worker/test/board.runtime.test.ts` на Miniflare и убедись, что тайм-аут установлен с запасом не меньше двух раз);
   - `npm run build`;
   - `npx playwright install chromium && npm run test:e2e`.
   Чини только то, что падает, не ослабляя тесты и конфигурацию.
4. Живой сценарий на `wrangler dev`:
   - Запусти `npm run dev` в одном окне и прогони `npm run smoke:ws` во втором окне против настоящего `wrangler dev` (`ws://localhost:8787`).
   - Проверь вручную на живом `wrangler dev`:
     а) одно сообщение `scene_update`, пауза 15 секунд (проверка выгрузки объекта по 10-секундному таймеру гибернации), новое подключение — элемент на месте;
     б) штрих (`scene_update`) и немедленное закрытие вкладки/сокета, новое подключение — элемент на месте.
   - Приложи в `docs/PR_T2_5_stabilize.md` фактические строки лога `snapshot_flush` (`rowsWritten`) с настоящего рантайма `wrangler dev` и фактический список запросов браузера из вкладки Network.
5. Закоммить все изменения в ветку `task/T2.5-stabilize` и оформи PR (в `main` не пушь и `wrangler deploy` / `wrangler secret put` сам не запускай — деплой выполняет владелец по инструкции в README.md).
```
