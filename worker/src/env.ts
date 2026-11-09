import type { Board } from "./board.js";

/**
 * Cloudflare Worker environment bindings and variables.
 */
export interface Env {
  /**
   * Static assets binding (serves files from ../web/dist).
   */
  ASSETS?: Fetcher;

  /**
   * Durable Object namespace for board rooms (SQLite-backed).
   */
  BOARD: DurableObjectNamespace<Board>;

  /**
   * Cloudflare D1 database binding for teachers, students, and boards metadata.
   * Provisioned in task T3; optional in T0..T2.5 before D1 creation.
   */
  DB?: D1Database;

  /**
   * Interval in milliseconds for persisting board snapshots to SQLite (default: "5000").
   * Must stay below Cloudflare's 10-second WebSocket Hibernation inactivity threshold.
   */
  SAVE_INTERVAL_MS: string;

  /**
   * Development-only flag ("true" in .dev.vars) allowing connections to any valid 22-char base62
   * board ID without checking PILOT_BOARD_IDS or D1 registry. Must be "false" in production.
   */
  ALLOW_ANY_BOARD_ID?: string;

  /**
   * Comma-separated list of allowed 22-character base62 board IDs for the pilot deployment
   * (up to 50 IDs, configured via `wrangler secret put PILOT_BOARD_IDS`).
   * Used when ALLOW_ANY_BOARD_ID !== "true" before D1 board registry is introduced in T3.
   */
  PILOT_BOARD_IDS?: string;
}
