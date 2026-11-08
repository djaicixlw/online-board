import type { InterpolatedCursor, RemoteCursorTarget } from "./types.js";

const CURSOR_PALETTE = [
  "#2563eb",
  "#d97706",
  "#059669",
  "#dc2626",
  "#7c3aed",
  "#db2777",
  "#0891b2",
  "#4f46e5",
] as const;

export const CURSOR_STALE_TIMEOUT_MS = 30_000;
const SMOOTHING_TAU_MS = 45;
const SNAP_EPSILON_PX = 0.25;

export function pickCollaboratorColor(clientId: string): string {
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) {
    hash = (hash * 31 + clientId.charCodeAt(i)) >>> 0;
  }
  return CURSOR_PALETTE[hash % CURSOR_PALETTE.length] ?? CURSOR_PALETTE[0];
}

export interface CursorStepResult {
  cursors: InterpolatedCursor[];
  changed: boolean;
  expiredClientIds: string[];
}

/**
 * Smoothly interpolates remote collaborator cursor positions between network updates (10 Hz -> 60 FPS).
 * Tracks dirty state so React only re-renders when a cursor actually moves, appears, or expires.
 */
export class CursorInterpolator {
  private readonly cursors = new Map<string, InterpolatedCursor>();
  private dirtySinceLastStep = false;
  private readonly staleTimeoutMs: number;

  constructor(staleTimeoutMs = CURSOR_STALE_TIMEOUT_MS) {
    this.staleTimeoutMs = staleTimeoutMs;
  }

  public updateTarget(target: RemoteCursorTarget, nowMs = Date.now()): InterpolatedCursor {
    const existing = this.cursors.get(target.client_id);
    this.dirtySinceLastStep = true;

    if (!existing) {
      const created: InterpolatedCursor = {
        clientId: target.client_id,
        nick: target.nick,
        x: target.x,
        y: target.y,
        targetX: target.x,
        targetY: target.y,
        pointer: target.pointer ?? "mouse",
        tool: target.tool ?? "pointer",
        color: pickCollaboratorColor(target.client_id),
        updatedAt: nowMs,
      };
      this.cursors.set(target.client_id, created);
      return { ...created };
    }

    existing.nick = target.nick;
    existing.targetX = target.x;
    existing.targetY = target.y;
    if (target.pointer) {
      existing.pointer = target.pointer;
    }
    if (target.tool) {
      existing.tool = target.tool;
    }
    existing.updatedAt = nowMs;
    return { ...existing };
  }

  /**
   * Advances all remote cursors toward their target positions by `dtMs` milliseconds,
   * returning whether any cursor visually changed or expired (preventing idle 60 FPS re-renders).
   */
  public stepWithDiff(dtMs: number, nowMs = Date.now()): CursorStepResult {
    if (this.cursors.size === 0 && !this.dirtySinceLastStep) {
      return { cursors: [], changed: false, expiredClientIds: [] };
    }

    const clampedDt = Math.max(0, Math.min(dtMs, 250));
    const alpha = clampedDt === 0 ? 0 : 1 - Math.exp(-clampedDt / SMOOTHING_TAU_MS);

    let changed = this.dirtySinceLastStep;
    this.dirtySinceLastStep = false;

    const result: InterpolatedCursor[] = [];
    const expiredClientIds: string[] = [];

    for (const [clientId, cursor] of this.cursors.entries()) {
      if (nowMs - cursor.updatedAt > this.staleTimeoutMs) {
        this.cursors.delete(clientId);
        expiredClientIds.push(clientId);
        changed = true;
        continue;
      }

      const prevX = cursor.x;
      const prevY = cursor.y;
      const dx = cursor.targetX - cursor.x;
      const dy = cursor.targetY - cursor.y;

      if (Math.hypot(dx, dy) <= SNAP_EPSILON_PX) {
        cursor.x = cursor.targetX;
        cursor.y = cursor.targetY;
      } else {
        cursor.x += dx * alpha;
        cursor.y += dy * alpha;
      }

      if (Math.abs(cursor.x - prevX) > 0.01 || Math.abs(cursor.y - prevY) > 0.01) {
        changed = true;
      }

      result.push({ ...cursor });
    }

    return { cursors: result, changed, expiredClientIds };
  }

  /**
   * Advances all remote cursors toward their target positions by `dtMs` milliseconds.
   */
  public step(dtMs: number, nowMs = Date.now()): InterpolatedCursor[] {
    return this.stepWithDiff(dtMs, nowMs).cursors;
  }

  public removeCollaborator(clientId: string): void {
    if (this.cursors.delete(clientId)) {
      this.dirtySinceLastStep = true;
    }
  }

  public getSnapshot(): InterpolatedCursor[] {
    return Array.from(this.cursors.values()).map((c) => ({ ...c }));
  }

  public clear(): void {
    if (this.cursors.size > 0) {
      this.cursors.clear();
      this.dirtySinceLastStep = true;
    }
  }
}
