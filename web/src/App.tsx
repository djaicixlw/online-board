import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { RU_LOCALE_CODE, RU_STRINGS } from "./i18n/ru.js";

export function App() {
  return (
    <main className="board-viewport" aria-label={RU_STRINGS.canvasAriaLabel}>
      <Excalidraw langCode={RU_LOCALE_CODE} />
    </main>
  );
}
