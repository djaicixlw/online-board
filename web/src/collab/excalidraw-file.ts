import type { ExcalidrawElementLike } from "./types.js";

export interface ExcalidrawFileDocument {
  type: "excalidraw";
  version: 2;
  source: string;
  elements: ExcalidrawElementLike[];
  appState: {
    gridSize: number | null;
    viewBackgroundColor: string;
    exportEmbedScene: boolean;
  };
  files: Record<string, unknown>;
}

/**
 * Serializes elements into the open `.excalidraw` JSON format (SPEC.md section 9).
 */
export function serializeExcalidrawDocument(
  elements: readonly ExcalidrawElementLike[],
  viewBackgroundColor = "#ffffff",
  sourceOrigin = "https://online-board.local",
): string {
  const doc: ExcalidrawFileDocument = {
    type: "excalidraw",
    version: 2,
    source: sourceOrigin,
    elements: elements.filter((el) => el.isDeleted !== true),
    appState: {
      gridSize: null,
      viewBackgroundColor,
      exportEmbedScene: true,
    },
    files: {},
  };
  return JSON.stringify(doc, null, 2);
}

/**
 * Parses and validates an imported `.excalidraw` JSON file string.
 */
export function parseExcalidrawDocument(rawJson: string): {
  elements: ExcalidrawElementLike[];
  viewBackgroundColor?: string;
} {
  const parsed = JSON.parse(rawJson) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || parsed.type !== "excalidraw") {
    throw new Error("Invalid .excalidraw file header");
  }
  if (!Array.isArray(parsed.elements)) {
    throw new Error("Invalid .excalidraw elements array");
  }
  const validElements: ExcalidrawElementLike[] = [];
  for (const item of parsed.elements) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as Record<string, unknown>).id === "string" &&
      typeof (item as Record<string, unknown>).version === "number" &&
      typeof (item as Record<string, unknown>).versionNonce === "number"
    ) {
      validElements.push(item as ExcalidrawElementLike);
    }
  }
  const appState = parsed.appState as Record<string, unknown> | undefined;
  const bg =
    appState && typeof appState.viewBackgroundColor === "string"
      ? appState.viewBackgroundColor
      : undefined;
  return {
    elements: validElements,
    ...(bg !== undefined ? { viewBackgroundColor: bg } : {}),
  };
}
