/**
 * Russian UI string dictionary (`ru-RU`).
 * All custom user-facing interface strings live here (AGENTS.md).
 */
export const RU = {
  langCode: "ru-RU",
  appTitle: "Онлайн-доска для уроков",
  loadingCanvas: "Загрузка холста…",

  // Nickname onboarding and editing dialog
  nickDialogTitle: "Как вас зовут на доске?",
  nickDialogHint: "Имя увидят другие участники рядом с вашим курсором (от 1 до 32 символов).",
  nickInputPlaceholder: "Например: Анна или Учитель",
  nickSubmitButton: "Войти на доску",
  nickSaveButton: "Сохранить",
  nickCancelButton: "Отмена",
  nickChangeButtonLabel: "Сменить имя",
  nickValidationError: "Введите имя длиной от 1 до 32 символов.",

  // Connection status banner
  statusConnecting: "Подключение…",
  statusOfflineLocal: "Нет связи, рисуем локально",
  statusRoomFull: "Доска заполнена",
  statusConnectedPrefix: "Онлайн",

  // Scene file (.excalidraw) export and import actions
  saveSceneFileButton: "Сохранить .excalidraw",
  openSceneFileButton: "Открыть .excalidraw",
  openSceneFileError: "Не удалось прочитать файл .excalidraw. Проверьте формат файла.",

  // Invalid board URL screen
  invalidBoardTitle: "Некорректный адрес доски",
  invalidBoardDescription:
    "Ссылка на доску должна иметь вид /b/<22 символа base62>. Проверьте ссылку у преподавателя или откройте демонстрационную доску.",
  openDemoBoardButton: "Открыть демо-доску",
} as const;
