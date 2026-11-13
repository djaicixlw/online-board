# PR: Задача T3 — Личный кабинет преподавателя и база Cloudflare D1 (`task/T3-teacher-cabinet`)

## 1. Сводка изменений по этапу T3

### 1.1. База данных Cloudflare D1 и миграции (`worker/migrations/0001_init.sql`)

- Создана таблица `teachers`:
  - `id TEXT PRIMARY KEY` (22-символьный base62);
  - `name TEXT NOT NULL`;
  - `token_hash TEXT NOT NULL UNIQUE` (SHA-256 hex от сырого токена);
  - `created_at INTEGER NOT NULL`.
  - Сырой токен никогда не сохраняется в БД; авторизация идёт строго по `token_hash`.
- Создана таблица `students`:
  - `id TEXT PRIMARY KEY` (22-символьный base62);
  - `teacher_id TEXT NOT NULL`;
  - `nickname TEXT NOT NULL` (1–32 символа, без управляющих символов);
  - `notes TEXT NOT NULL DEFAULT ''` (до 2000 символов);
  - `archived INTEGER NOT NULL DEFAULT 0`;
  - `created_at INTEGER NOT NULL`.
  - Индекс `idx_students_teacher (teacher_id, archived, nickname)`.
- Создана таблица `boards`:
  - `id TEXT PRIMARY KEY` (22-символьный base62);
  - `teacher_id TEXT NOT NULL`;
  - `student_id TEXT` (nullable);
  - `title TEXT NOT NULL`;
  - `notes TEXT NOT NULL DEFAULT ''`;
  - `deleted_at INTEGER` (nullable, мягкое удаление);
  - `created_at INTEGER NOT NULL`;
  - `updated_at INTEGER NOT NULL`;
  - `last_backup_at INTEGER` (nullable).
  - Индексы `idx_boards_teacher (teacher_id, deleted_at, updated_at)` и `idx_boards_student (student_id, deleted_at)`.
- Настроена привязка `[[d1_databases]]` с `binding = "DB"` и `database_name = "online-board-db"` в `worker/wrangler.toml`.

### 1.2. Скрипт создания преподавателя (`scripts/create-teacher.mjs`)

- Принимает опцию `--name "<Имя>"` (по умолчанию `"Преподаватель"`).
- Генерирует 22-значный base62 ID и 44-значный криптостойкий base62 токен (>260 бит энтропии).
- Вычисляет SHA-256 хэш и формирует готовую SQL-команду для `wrangler d1 execute` (`--local` и `--remote`).

### 1.3. Авторизация и изоляция тенантов (`worker/src/d1.ts`, `worker/src/index.ts`)

- Все кабинетные эндпоинты требуют заголовок `Authorization: Bearer <token>`.
- Реализован in-memory кэш токенов на 60 секунд (`token_hash -> { id, name }`), снижающий чтения D1 более чем на 90% при активной работе в кабинете.
- **Жёсткий инвариант изоляции (Zero IDOR)**: каждый запрос к таблицам `students` и `boards` фильтруется по `WHERE teacher_id = ?`. При попытке обратиться к чужому ID воркер возвращает `404 Not Found` (предотвращение перебора сущностей).
- Реализованы REST-маршруты:
  - `GET /api/me` -> `{ ok: true, teacher: { id, name } }`;
  - `GET /api/students?include_archived=0|1` -> список учеников преподавателя;
  - `POST /api/students` -> создание карточки ученика;
  - `PATCH /api/students/:id` -> обновление ника, заметок и статуса архива;
  - `GET /api/boards?student_id=<id>` -> список активных досок преподавателя;
  - `POST /api/boards` -> создание доски в 1 клик, а при наличии `from_board_id` — клонирование состояния из исходного Durable Object через экспорт/импорт со сбросом версий элементов в 1;
  - `PATCH /api/boards/:id` -> обновление названия, заметок к уроку и привязки к ученику;
  - `DELETE /api/boards/:id` -> мягкое удаление в D1, мгновенный сброс положительного кэша досок и вызов внутреннего метода Durable Object `/internal/revoke`, закрывающего активные сокеты с кодом `1008 ("Board deleted")`.
- Функция `isBoardAllowed` проверяет наличие доски в D1 (с 30-секундным in-memory кэшем) при `ALLOW_ANY_BOARD_ID=false`.

### 1.4. Фронтенд личного кабинета преподавателя (`web/src/teacher/`)

- Бандл кабинета полностью отделён от библиотеки `@excalidraw/excalidraw` с помощью `React.lazy()`:
  - Размер чанка кабинета: **всего 8.87 КБ** (2.94 КБ gzip), что многократно ниже установленного лимита в 50 КБ!
  - При открытии `/teacher` тяжёлый чанк Excalidraw не загружается.
- Все строки переведены на русский язык и вынесены в `web/src/i18n/ru.ts`.
- Форма авторизации по токену с сохранением в `localStorage['board.teacherToken']`.
- Панель учеников: создание, фильтрация досок по клику на ученика, автосохранение заметок с debounce 600 мс, архивация/восстановление.
- Панель досок:
  - Кнопка **«Создать доску в 1 клик»**: автогенерация названия (`<Ник> — <Дата>`), вызов API, копирование ссылки в буфер обмена (`navigator.clipboard.writeText`) и всплывающее уведомление.
  - Кнопка **«Дублировать»** для создания досок из шаблонов с чертежами.
  - Редактирование заметок к уроку прямо на карточке доски с автосохранением.
  - Удаление доски с подтверждением.

---

## 2. Результаты проверок качества и тестов

| Проверка                         | Команда                          | Результат                                                |
| :------------------------------- | :------------------------------- | :------------------------------------------------------- |
| Лицензии зависимостей            | `npm run check:licenses`         | **PASS** (640 пакетов, 0 запрещённых лицензий)           |
| Строгая типизация                | `npm run typecheck`              | **PASS** (0 ошибок во всех воркспейсах)                  |
| Линтер и форматирование          | `npm run lint`                   | **PASS** (ESLint strict + Prettier)                      |
| Модульные и интеграционные тесты | `npm test` (`REQUIRE_RUNTIME=1`) | **PASS** (31 тест, включая 5 новых тестов D1 и изоляции) |
| E2E тесты совместной работы      | `npm run test:e2e`               | **PASS** (2 теста Playwright)                            |
| Сборка фронтенда                 | `npm run build`                  | **PASS** (чанк `TeacherCabinet` = 8.87 КБ < 50 КБ)       |
