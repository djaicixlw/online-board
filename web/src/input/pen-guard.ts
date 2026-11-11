import type { PointerKind } from "../collab/types.js";

export interface PointerEventLike {
  pointerType: string;
  buttons?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  isPrimary?: boolean | undefined;
  target?: unknown;
}

/**
 * Contact geometry threshold (in CSS pixels) that distinguishes a large palm resting on a tablet
 * from normal single-finger or two-finger pinch/pan touch gestures (which are typically 15..35 px).
 */
export const PALM_CONTACT_SIZE_THRESHOLD_PX = 48;

/**
 * Normalizes a DOM PointerEvent `pointerType` into `"pen" | "touch" | "mouse"`.
 */
export function normalizePointerKind(pointerType: string | undefined): PointerKind {
  if (pointerType === "pen") {
    return "pen";
  }
  if (pointerType === "touch") {
    return "touch";
  }
  return "mouse";
}

/**
 * Checks whether an event target belongs to Excalidraw's UI overlay (toolbars, menus, islands,
 * buttons, inputs, dialogs) rather than the drawing canvas. Touching UI controls with a finger
 * must never be suppressed even when `penMode` is active (T2.5b section B.10).
 */
export function isExcalidrawUiTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") {
    return false;
  }
  const el = target as { closest?: ((selector: string) => unknown) | undefined };
  if (typeof el.closest === "function") {
    return Boolean(
      el.closest(
        ".App-menu, .App-toolbar, .App-bottom-bar, .Island, .layer-ui__wrapper, button, input, select, textarea, label, a, [role='button'], [role='dialog']",
      ),
    );
  }
  return false;
}

/**
 * Evaluates whether a pointer event on the canvas container should be suppressed as accidental
 * palm or single-finger drawing contact:
 * - Never suppresses `pen` or `mouse` events.
 * - Never suppresses touches targeting Excalidraw UI toolbars/buttons (`isExcalidrawUiTarget`).
 * - Never suppresses secondary touch points (`isPrimary === false`), preserving two-finger
 *   pinch-to-zoom and pan gestures inside Excalidraw on tablets.
 * - Suppresses primary touch contacts whose contact geometry (`width >= 48` or `height >= 48` px)
 *   indicates a palm resting on the screen, or primary single-finger canvas drawing when `penModeActive`
 *   is enabled.
 */
export function shouldSuppressTouchOrPalmDrawing(
  event: PointerEventLike,
  penModeActive: boolean,
): boolean {
  if (event.pointerType === "pen" || event.pointerType === "mouse") {
    return false;
  }

  if (event.pointerType === "touch") {
    if (isExcalidrawUiTarget(event.target)) {
      return false;
    }

    // Never block secondary touch pointers so two-finger pinch-to-zoom and pan always work
    if (event.isPrimary === false) {
      return false;
    }

    // Large contact area on primary touch indicates a palm resting on the screen
    if (
      (typeof event.width === "number" && event.width >= PALM_CONTACT_SIZE_THRESHOLD_PX) ||
      (typeof event.height === "number" && event.height >= PALM_CONTACT_SIZE_THRESHOLD_PX)
    ) {
      return true;
    }

    if (penModeActive) {
      return true;
    }
  }

  return false;
}
