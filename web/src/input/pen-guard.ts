import type { PointerKind } from "../collab/types.js";

export interface PointerEventLike {
  pointerType: string;
  buttons?: number;
  width?: number;
  height?: number;
  isPrimary?: boolean;
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
 * Evaluates whether a pointer event on the canvas container should be suppressed as accidental
 * palm contact:
 * - Never suppresses `pen` or `mouse` events.
 * - Never suppresses secondary touch points (`isPrimary === false`), preserving two-finger
 *   pinch-to-zoom and pan gestures inside Excalidraw on tablets.
 * - Suppresses primary touch contacts whose contact geometry (`width >= 48` or `height >= 48` px)
 *   indicates a palm resting on the screen, or primary single-finger drawing when `penModeActive`
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
