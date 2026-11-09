import { webcrypto } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BOARD_ID_LENGTH = 22;
const MAX_COUNT = 50;

// Largest multiple of 62 <= 256 (62 * 4 = 248) for unbiased rejection sampling
const UNBIASED_BYTE_LIMIT = 248;

/**
 * Generates a single cryptographically random 22-character base62 board ID
 * using `crypto.getRandomValues` (SPEC.md sections 5 and 6).
 * @returns {string}
 */
export function generateBoardId() {
  const cryptoObj = globalThis.crypto ?? webcrypto;
  const chars = [];
  const randomBuf = new Uint8Array(64);

  while (chars.length < BOARD_ID_LENGTH) {
    cryptoObj.getRandomValues(randomBuf);
    for (let i = 0; i < randomBuf.length && chars.length < BOARD_ID_LENGTH; i++) {
      const byte = randomBuf[i];
      if (byte < UNBIASED_BYTE_LIMIT) {
        chars.push(BASE62_ALPHABET[byte % 62]);
      }
    }
  }

  return chars.join("");
}

/**
 * Generates `count` unique 22-character base62 board IDs (1..50).
 * @param {number} [count=1]
 * @returns {string[]}
 */
export function generateMultipleBoardIds(count = 1) {
  const parsedCount = Number.parseInt(String(count), 10);
  if (Number.isNaN(parsedCount) || parsedCount < 1 || parsedCount > MAX_COUNT) {
    throw new Error(
      `[gen-board-id] Количество ID должно быть целым числом от 1 до ${MAX_COUNT} (передано: ${String(count)}).`,
    );
  }
  const ids = new Set();
  while (ids.size < parsedCount) {
    ids.add(generateBoardId());
  }
  return Array.from(ids);
}

function main() {
  const rawArg = process.argv[2];
  const count = rawArg !== undefined ? Number.parseInt(rawArg, 10) : 1;

  try {
    const ids = generateMultipleBoardIds(count);
    for (const id of ids) {
      process.stdout.write(`${id}\n`);
    }
    if (ids.length > 1) {
      process.stderr.write(`\n# Для сохранения в секрет PILOT_BOARD_IDS:\n`);
      process.stderr.write(`# PILOT_BOARD_IDS="${ids.join(",")}"\n`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
