/**
 * Russian UI strings and locale configuration (`ru-RU`).
 * Per AGENTS.md, all user-facing Russian strings live in `web/src/i18n/ru.ts`,
 * while identifiers and code comments are written in English.
 */
export const RU_LOCALE_CODE = "ru-RU" as const;

export const RU_STRINGS = {
  langCode: RU_LOCALE_CODE,
  appTitle: "Онлайн-доска для уроков",
  canvasAriaLabel: "Холст онлайн-доски для урока",
  rootElementMissingError: "Корневой элемент #root не найден в DOM",
  loadingCanvas: "Загрузка холста…",

  // Production root (/) and invalid board route (/b/:id) screens
  openTeacherBoardLinkTitle: "Вход на доску по ссылке",
  openTeacherBoardLinkDescription:
    "Откройте ссылку на доску, которую вам прислал преподаватель",
  invalidBoardUrlTitle: "Некорректный адрес доски",
  invalidBoardUrlDescription:
    "Ссылка на доску должна иметь формат /b/<22 символа латиницы и цифр (base62)>.",
  createNewLocalBoardButton: "Открыть новую доску",

  // Nickname onboarding and editing dialog (localStorage key: board.nick)
  nickDialogTitle: "Как вас зовут на доске?",
  nickDialogSubtitle: "Введите ник (от 1 до 32 символов). Он запомнится в этом браузере.",
  nickInputLabel: "Ваш ник на доске",
  nickInputPlaceholder: "Например, Алексей",
  nickSubmitButton: "Продолжить",
  nickCancelButton: "Отмена",
  nickValidationError: "Введите ник длиной от 1 до 32 символов (без управляющих спецсимволов).",
  changeNickButtonPrefix: "Ник:",
  changeNickButtonAriaLabel: "Сменить ник на доске",

  // Connection status banner
  statusConnecting: "Подключение…",
  statusConnected: "На связи",
  statusOffline: "Нет связи, рисуем локально",
  statusBoardFull: "Доска заполнена",

  // Stylus pen mode and palm rejection controls
  penModeActiveLabel: "Режим пера: вкл",
  penModeAutoLabel: "Режим пера: авто",
  penModeToggleTitle:
    "В режиме пера касания ладонью и пальцем не рисуют на холсте (работают только стилус и мышь)",

  // Scene file (.excalidraw) export, import, and server size ceiling errors
  saveExcalidrawFileButton: "Сохранить .excalidraw",
  openExcalidrawFileButton: "Открыть .excalidraw",
  fileImportError: "Не удалось прочитать файл .excalidraw: проверьте формат JSON.",
  boardTooLargeError:
    "Превышен максимальный размер доски (не более 20 000 элементов или 20 МБ). Удалите лишние элементы или создайте новую доску.",
  collaboratorsCountPrefix: "Участников:",
} as const;

export const RU = RU_STRINGS;
