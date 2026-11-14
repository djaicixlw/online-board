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
  openTeacherBoardLinkDescription: "Откройте ссылку на доску, которую вам прислал преподаватель",
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

  // Scene file (.excalidraw) export, import, and server error banners
  saveExcalidrawFileButton: "Сохранить .excalidraw",
  openExcalidrawFileButton: "Открыть .excalidraw",
  fileImportError: "Не удалось прочитать файл .excalidraw: проверьте формат JSON.",
  boardTooLargeError:
    "Превышен максимальный размер доски (не более 20 000 элементов или 20 МБ). Удалите лишние элементы или создайте новую доску.",
  boardNotSavedError: "Доска повреждена, изменения не сохраняются. Сообщите преподавателю",
  collaboratorsCountPrefix: "Участников:",

  // Image attachments (T4)
  imageTooLargeError: "Картинка слишком большая, максимум 4 МБ",
  imageUploadError: "Не удалось загрузить картинку на сервер. Проверьте подключение к сети.",
  imageQuotaExceededError:
    "Превышена квота хранения картинок на доске (максимум 100 МБ). Удалите старые картинки.",
  imageUnsupportedFormatError:
    "Неподдерживаемый формат изображения. Разрешены только WebP, PNG и JPEG.",

  // Teacher Cabinet (T3)
  teacherCabinetTitle: "Кабинет преподавателя",
  teacherLoginTitle: "Вход для преподавателя",
  teacherLoginSubtitle: "Введите секретный токен доступа к кабинету.",
  teacherTokenLabel: "Токен преподавателя",
  teacherTokenPlaceholder: "Вставьте секретный токен...",
  teacherLoginButton: "Войти",
  teacherLogoutButton: "Выйти",
  teacherLoginError: "Неверный токен доступа",
  studentsTitle: "Ученики",
  addStudentButton: "+ Ученик",
  studentNickPlaceholder: "Имя или ник ученика",
  studentNotesPlaceholder: "Заметки к ученику (класс, расписание, цели)...",
  showArchivedStudents: "Показать архив",
  hideArchivedStudents: "Скрыть архив",
  archiveStudentButton: "В архив",
  unarchiveStudentButton: "Восстановить",
  noStudentsMessage: "Список учеников пуст. Добавьте первого ученика.",
  boardsTitle: "Доски",
  allStudentsFilter: "Все доски",
  createBoardOneClick: "Создать доску в 1 клик",
  boardCreatedToast: "Доска создана, ссылка скопирована!",
  openBoardButton: "Открыть",
  copyBoardLinkButton: "Скопировать ссылку",
  linkCopiedToast: "Ссылка скопирована!",
  duplicateBoardButton: "Дублировать",
  deleteBoardButton: "Удалить",
  deleteBoardConfirm:
    "Вы уверены, что хотите удалить эту доску? Все активные подключения будут закрыты.",
  boardNotesPlaceholder: "Заметки к уроку и домашнее задание...",
  noBoardsMessage: "У этого ученика пока нет досок. Нажмите «Создать доску в 1 клик».",
  savingStatus: "Сохранение...",
  savedStatus: "Сохранено",
  goToTeacherCabinet: "Перейти в кабинет преподавателя",
} as const;

export const RU = RU_STRINGS;
