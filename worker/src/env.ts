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
   * Provisioned in task T3; optional in T0 scaffold before D1 creation.
   */
  DB?: D1Database;

  /**
   * Interval in milliseconds for persisting board snapshots to SQLite (default: "10000").
   */
  SAVE_INTERVAL_MS: string;

  /**
   * Development-only flag ("true" in .dev.vars) allowing connections to any board ID
   * without checking D1 registry. Must be "false" or unset in production.
   */
  ALLOW_ANY_BOARD_ID?: string;
}
