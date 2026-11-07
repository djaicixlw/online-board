import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { RU_STRINGS } from "./i18n/ru.js";
import "./styles.css";

// Ensure Excalidraw loads fonts and assets strictly from the local bundle origin
window.EXCALIDRAW_ASSET_PATH = "/";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error(RU_STRINGS.rootElementMissingError);
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
