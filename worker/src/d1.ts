/**
 * worker/src/d1.ts
 * Cloudflare D1 database operations, teacher authentication, and caching for Task T3.
 */

import type { Env } from "./env.js";
import { isValidBoardId, parsePilotBoardIds } from "./board.js";

export interface TeacherRecord {
  id: string;
  name: string;
  token_hash: string;
  created_at: number;
}

export interface StudentRecord {
  id: string;
  teacher_id: string;
  nickname: string;
  notes: string;
  archived: number;
  created_at: number;
}

export interface BoardRecord {
  id: string;
  teacher_id: string;
  student_id: string | null;
  title: string;
  notes: string;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  last_backup_at: number | null;
}

interface CachedTeacher {
  teacher: { id: string; name: string };
  expiresAt: number;
}

// 60-second in-memory cache for authenticated teachers (token_hash -> Teacher)
const teacherCache = new Map<string, CachedTeacher>();

// 30-second in-memory cache for validated D1 boards (boardId -> expiresAtMs)
const d1BoardCache = new Map<string, number>();

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Generates a cryptographically random base62 string of the specified length.
 * Default length 22 characters (~131 bits of entropy).
 */
export function generateId(length = 22): string {
  const chars: string[] = [];
  const buf = new Uint8Array(length * 2);
  while (chars.length < length) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && chars.length < length; i++) {
      const b = buf[i];
      if (b !== undefined && b < 248) {
        const char = BASE62[b % 62];
        if (char) {
          chars.push(char);
        }
      }
    }
  }
  return chars.join("");
}

/**
 * Calculates SHA-256 hex string from a UTF-8 token.
 */
export async function hashToken(token: string): Promise<string> {
  const enc = new TextEncoder();
  const digestBuf = await crypto.subtle.digest("SHA-256", enc.encode(token));
  return Array.from(new Uint8Array(digestBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Authenticates the request via `Authorization: Bearer <token>` header.
 * Uses 60-second in-memory cache to minimize D1 read queries.
 */
export async function authenticateTeacher(
  request: Request,
  env: Env,
): Promise<{ id: string; name: string } | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    return null;
  }

  const tokenHash = await hashToken(token);
  const now = Date.now();

  const cached = teacherCache.get(tokenHash);
  if (cached && cached.expiresAt > now) {
    return cached.teacher;
  }

  if (!env.DB) {
    return null;
  }

  try {
    const row = await env.DB.prepare("SELECT id, name FROM teachers WHERE token_hash = ?1 LIMIT 1")
      .bind(tokenHash)
      .first<{ id: string; name: string }>();

    if (!row) {
      return null;
    }

    const teacher = { id: row.id, name: row.name };
    teacherCache.set(tokenHash, { teacher, expiresAt: now + 60_000 });
    return teacher;
  } catch (err) {
    console.error("[d1] Error authenticating teacher in D1:", err);
    return null;
  }
}

/**
 * Clears the teacher cache (used in test suites).
 */
export function clearTeacherCache(): void {
  teacherCache.clear();
}

/**
 * Checks whether a board ID is allowed to connect via WebSocket:
 * 1. Checks `ALLOW_ANY_BOARD_ID === "true"` (local dev).
 * 2. Checks `PILOT_BOARD_IDS` secret allowlist.
 * 3. Checks Cloudflare D1 `boards` table (with 30-second in-memory cache).
 */
export async function isBoardAllowed(boardId: string, env: Env): Promise<boolean> {
  if (!isValidBoardId(boardId)) {
    return false;
  }
  if (env.ALLOW_ANY_BOARD_ID === "true") {
    return true;
  }

  // 1. Check pilot allowlist
  const pilotAllowlist = parsePilotBoardIds(env.PILOT_BOARD_IDS);
  if (pilotAllowlist.has(boardId)) {
    return true;
  }

  // 2. Check D1 database if bound
  if (env.DB) {
    const now = Date.now();
    const cachedExpires = d1BoardCache.get(boardId);
    if (cachedExpires && cachedExpires > now) {
      return true;
    }

    try {
      const row = await env.DB.prepare(
        "SELECT 1 FROM boards WHERE id = ?1 AND deleted_at IS NULL LIMIT 1",
      )
        .bind(boardId)
        .first();

      if (row) {
        d1BoardCache.set(boardId, now + 30_000);
        return true;
      }
    } catch (err) {
      console.error("[d1] Error verifying board in D1:", err);
    }
  }

  return false;
}

/**
 * Evicts a board from the in-memory positive cache upon deletion.
 */
export function evictBoardCache(boardId: string): void {
  d1BoardCache.delete(boardId);
}
