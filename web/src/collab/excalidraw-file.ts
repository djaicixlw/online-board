import { isValidFiniteElement } from "./reconcile.js";
import type { ExcalidrawElementLike } from "./types.js";

/**
 * Maximum allowed `.excalidraw` file size on import (1.8 MiB) so scene updates fit within
 * the 2 MiB WebSocket message limit (SPEC.md sections 3 and 10).
 */
export const MAX_EXCALIDRAW_FILE_BYTES = 1_800_000;

const textEncoder = new TextEncoder();

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
    elements: elements.filter((el) => isValidFiniteElement(el) && el.isDeleted !== true),
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
 * Enforces `MAX_EXCALIDRAW_FILE_BYTES` and `Number.isFinite` on element versions.
 */
export function parseExcalidrawDocument(rawJson: string): {
  elements: ExcalidrawElementLike[];
  viewBackgroundColor?: string;
} {
  const byteLength = textEncoder.encode(rawJson).byteLength;
  if (byteLength > MAX_EXCALIDRAW_FILE_BYTES) {
    throw new Error(`File exceeds maximum allowed size (${MAX_EXCALIDRAW_FILE_BYTES} bytes)`);
  }

  const parsed = JSON.parse(rawJson) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || parsed.type !== "excalidraw") {
    throw new Error("Invalid .excalidraw file header");
  }
  if (!Array.isArray(parsed.elements)) {
    throw new Error("Invalid .excalidraw elements array");
  }
  const validElements: ExcalidrawElementLike[] = [];
  for (const item of parsed.elements) {
    if (isValidFiniteElement(item)) {
      validElements.push(item);
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
