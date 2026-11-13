import "./init.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { RU_STRINGS } from "./i18n/ru.js";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error(RU_STRINGS.rootElementMissingError);
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
