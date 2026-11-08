import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";

const DEFAULT_SAVE_INTERVAL_MS = 10_000;
const MIN_SAVE_INTERVAL_MS = 5_000;
const MAX_SAVE_INTERVAL_MS = 15_000;

/**
 * Parses and clamps SAVE_INTERVAL_MS within the allowed range (5000..15000 ms) per SPEC.md section 2.
 */
export function resolveSaveIntervalMs(rawValue: string | undefined): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (Number.isNaN(parsed)) {
    return DEFAULT_SAVE_INTERVAL_MS;
  }
  return Math.min(MAX_SAVE_INTERVAL_MS, Math.max(MIN_SAVE_INTERVAL_MS, parsed));
}

/**
 * Durable Object stub for a single lesson board backed by SQLite storage (`new_sqlite_classes`).
 * Full WebSocket Hibernation and snapshot persistence are implemented in task T1.
 */
export class Board extends DurableObject<Env> {
  readonly saveIntervalMs: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.saveIntervalMs = resolveSaveIntervalMs(env.SAVE_INTERVAL_MS);
  }

  override async fetch(_request: Request): Promise<Response> {
    return Response.json(
      {
        ok: false,
        error: "Board Durable Object stub (implemented in T1)",
        saveIntervalMs: this.saveIntervalMs,
      },
      { status: 501 },
    );
  }
}
