/**
 * Russian UI strings and locale configuration.
 * Per AGENTS.md, all user-facing Russian strings live in `web/src/i18n/ru.ts`.
 */
export const RU_LOCALE_CODE = "ru-RU" as const;

export const RU_STRINGS = {
  appTitle: "Онлайн-доска для уроков",
  canvasAriaLabel: "Холст онлайн-доски для урока",
  rootElementMissingError: "Корневой элемент #root не найден в DOM",

  // Маршрутизация /b/:id
  invalidBoardUrlTitle: "Некорректный адрес доски",
  invalidBoardUrlDescription:
    "Ссылка на доску должна иметь формат /b/<22 символа латиницы и цифр (base62)>.",
  createNewLocalBoardButton: "Открыть новую доску",

  // Диалог ввода и смены ника (ключ localStorage: board.nick)
  nickDialogTitle: "Как вас зовут на доске?",
  nickDialogSubtitle: "Введите ник (от 1 до 32 символов). Он запомнится в этом браузере.",
  nickInputLabel: "Ваш ник на доске",
  nickInputPlaceholder: "Например, Алексей",
  nickSubmitButton: "Продолжить",
  nickCancelButton: "Отмена",
  nickValidationError: "Введите ник длиной от 1 до 32 символов (без управляющих спецсимволов).",
  changeNickButtonPrefix: "Ник:",
  changeNickButtonAriaLabel: "Сменить ник на доске",

  // Плашка состояния соединения
  statusConnecting: "Подключение…",
  statusConnected: "На связи",
  statusOffline: "Нет связи, рисуем локально",
  statusBoardFull: "Доска заполнена",

  // Ввод и режим пера (стилуса)
  penModeActiveLabel: "Режим пера: вкл",
  penModeAutoLabel: "Режим пера: авто",
  penModeToggleTitle:
    "В режиме пера касания ладонью и пальцем не рисуют на холсте (работают только стилус и мышь)",

  // Экспорт и работа с файлами .excalidraw
  saveExcalidrawFileButton: "Сохранить .excalidraw",
  openExcalidrawFileButton: "Открыть .excalidraw",
  fileImportError: "Не удалось прочитать файл .excalidraw: проверьте формат JSON.",
  collaboratorsCountPrefix: "Участников:",
} as const;
