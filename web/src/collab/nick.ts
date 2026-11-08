export const NICK_STORAGE_KEY = "board.nick" as const;
export const CLIENT_ID_STORAGE_KEY = "board.client_id" as const;

const BOARD_ID_REGEX = /^[0-9A-Za-z]{22}$/;
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F-\u009F]+/g;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/**
 * Validates that a board ID is exactly 22 base62 characters (SPEC.md section 6).
 */
export function isValidBoardId(id: string | null | undefined): id is string {
  return typeof id === "string" && BOARD_ID_REGEX.test(id);
}

/**
 * Generates a cryptographically random 22-character base62 board ID (~131 bits of entropy).
 */
export function generateBoardId(): string {
  const bytes = new Uint8Array(22);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let result = "";
  for (let i = 0; i < 22; i++) {
    result += BASE62_ALPHABET[(bytes[i] ?? 0) % 62];
  }
  return result;
}

/**
 * Extracts the board ID from a pathname of the form `/b/:id`.
 * Safely catches malformed percent-encoding (`URIError`) instead of crashing.
 */
export function parseBoardRoute(pathname: string): {
  matchedRoute: boolean;
  boardId: string | null;
  rawSegment: string | null;
} {
  if (pathname === "/" || pathname === "") {
    return { matchedRoute: false, boardId: null, rawSegment: null };
  }
  const match = /^\/b\/([^/]+)\/?$/.exec(pathname);
  if (!match) {
    return { matchedRoute: true, boardId: null, rawSegment: pathname };
  }
  const rawMatch = match[1] ?? "";
  let segment: string;
  try {
    segment = decodeURIComponent(rawMatch);
  } catch {
    return {
      matchedRoute: true,
      boardId: null,
      rawSegment: rawMatch,
    };
  }
  return {
    matchedRoute: true,
    boardId: isValidBoardId(segment) ? segment : null,
    rawSegment: segment,
  };
}

/**
 * Strips C0/C1 control characters, trims whitespace, and validates length (1..32 Unicode code points).
 */
export function sanitizeNickname(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const cleaned = raw.replace(CONTROL_CHARS_REGEX, "").trim();
  const length = Array.from(cleaned).length;
  if (length < 1 || length > 32) {
    return null;
  }
  return cleaned;
}

/**
 * Loads and validates the saved nickname from localStorage (`board.nick`).
 */
export function loadSavedNickname(storage?: StorageLike): string | null {
  const targetStorage =
    storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!targetStorage) {
    return null;
  }
  try {
    return sanitizeNickname(targetStorage.getItem(NICK_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * Validates and saves the nickname into localStorage (`board.nick`).
 * Throws if nickname is invalid.
 */
export function saveNickname(rawNick: string, storage?: StorageLike): string {
  const sanitized = sanitizeNickname(rawNick);
  if (!sanitized) {
    throw new Error("Invalid nickname: expected 1..32 non-control characters");
  }
  const targetStorage =
    storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (targetStorage) {
    try {
      targetStorage.setItem(NICK_STORAGE_KEY, sanitized);
    } catch {
      // Ignore storage quota errors in restricted browsing modes
    }
  }
  return sanitized;
}

/**
 * Returns a persistent random client_id for the current browser tab/profile.
 */
export function getOrCreateClientId(storage?: StorageLike): string {
  const targetStorage =
    storage ?? (typeof window !== "undefined" ? window.sessionStorage : undefined);
  if (targetStorage) {
    try {
      const existing = targetStorage.getItem(CLIENT_ID_STORAGE_KEY);
      if (existing && existing.trim().length > 0 && existing.length <= 64) {
        return existing.trim();
      }
    } catch {
      // Ignore storage read error
    }
  }

  const generated =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  if (targetStorage) {
    try {
      targetStorage.setItem(CLIENT_ID_STORAGE_KEY, generated);
    } catch {
      // Ignore storage write error
    }
  }
  return generated;
}
