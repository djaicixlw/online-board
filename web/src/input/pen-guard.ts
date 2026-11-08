import type { PointerKind } from "../collab/types.js";

export interface PointerEventLike {
  pointerType: string;
  buttons?: number;
  width?: number;
  height?: number;
  isPrimary?: boolean;
}

export const PALM_CONTACT_SIZE_THRESHOLD_PX = 22;

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
 * Evaluates whether a pointer event should be rejected as accidental palm contact
 * or an unintended touch gesture when pen mode (`penMode`) is active:
 * - When `penMode` is active, any `pointerType === "touch"` drawing contact is rejected
 *   so resting a palm or finger on the tablet screen does not draw stray strokes.
 * - Even before `penMode` is manually toggled, a touch contact with large geometry
 *   (`width >= 22` or `height >= 22` CSS px, or non-primary multi-touch) is rejected as a palm.
 */
export function shouldSuppressTouchOrPalmDrawing(
  event: PointerEventLike,
  penModeActive: boolean,
): boolean {
  if (event.pointerType === "pen" || event.pointerType === "mouse") {
    return false;
  }

  if (event.pointerType === "touch") {
    if (penModeActive) {
      return true;
    }
    if (event.isPrimary === false) {
      return true;
    }
    if (
      (typeof event.width === "number" && event.width >= PALM_CONTACT_SIZE_THRESHOLD_PX) ||
      (typeof event.height === "number" && event.height >= PALM_CONTACT_SIZE_THRESHOLD_PX)
    ) {
      return true;
    }
  }

  return false;
}
