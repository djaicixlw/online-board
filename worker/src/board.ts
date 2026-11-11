import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";

/**
 * Default snapshot persistence interval (5000 ms).
 * Set to half of Cloudflare's 10-second WebSocket Hibernation inactivity eviction threshold
 * so scheduled alarms always flush dirty state before an idle Durable Object is evicted from RAM.
 */
export const DEFAULT_SAVE_INTERVAL_MS = 5_000;
export const MIN_PROD_SAVE_INTERVAL_MS = 2_000;
export const MAX_PROD_SAVE_INTERVAL_MS = 8_000;
export const MIN_DEV_SAVE_INTERVAL_MS = 50;

export const MAX_PILOT_BOARD_IDS = 50;
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024; // 2 MiB per WebSocket message
export const MAX_BOARD_ELEMENTS = 20_000; // Ceiling on total elements per board
export const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024; // 20 MiB ceiling on total snapshot JSON
export const MAX_CONNECTIONS_PER_BOARD = 20;
export const MAX_MESSAGES_PER_SECOND = 30;
export const SUSTAINED_RATE_LIMIT_EXCESS_THRESHOLD = 60;
export const MAX_SNAPSHOT_CHUNK_BYTES = 900_000; // <= 900 KB in bytes
export const DELETED_ELEMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const BOARD_ID_REGEX = /^[0-9A-Za-z]{22}$/;
// Matches C0 (0x00-0x1F) and C1 (0x7F-0x9F) control characters
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F-\u009F]+/g;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Base wrapper overhead for `{"v":1,"elements":[]}` is 21 bytes
const SNAPSHOT_JSON_WRAPPER_BYTES = 21;

export interface ExcalidrawElementRecord {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean | undefined;
  is_deleted?: boolean | undefined;
  updated?: number | undefined;
  [key: string]: unknown;
}

export interface CollaboratorInfo {
  client_id: string;
  nick: string;
}

export interface WebSocketAttachment {
  sessionId: string;
  boardId?: string | undefined;
  clientId: string | null;
  nick: string;
  connectedAt: number;
  messagesAccepted: number;
  messagesDropped: number;
  rejected?: boolean | undefined;
}

interface SessionRuntimeState extends WebSocketAttachment {
  windowStartMs: number;
  messagesInWindow: number;
  sustainedExcessCount: number;
  closed: boolean;
}

export type FlushReason = "alarm" | "connection_close" | "last_connection_close" | "manual";

export interface FlushStats {
  reason: FlushReason;
  messagesAccepted: number;
  messagesDropped: number;
  flushesCount: number;
  rowsWritten: number;
  totalRowsWritten: number;
  chunksCount: number;
  elementsCount: number;
}

/**
 * Validates that a board ID is exactly 22 base62 characters (`0-9`, `A-Z`, `a-z`).
 */
export function isValidBoardId(id: string | null | undefined): id is string {
  return typeof id === "string" && BOARD_ID_REGEX.test(id);
}

/**
 * Parses comma-separated `PILOT_BOARD_IDS` secret into a Set of up to 50 valid 22-char base62 board IDs.
 * Invalid entries and whitespace are ignored.
 */
export function parsePilotBoardIds(raw: string | undefined): Set<string> {
  const allowed = new Set<string>();
  if (typeof raw !== "string" || raw.trim() === "") {
    return allowed;
  }
  const parts = raw.split(",");
  for (const part of parts) {
    const candidate = part.trim();
    if (isValidBoardId(candidate)) {
      allowed.add(candidate);
      if (allowed.size >= MAX_PILOT_BOARD_IDS) {
        break;
      }
    }
  }
  return allowed;
}

/**
 * Checks whether a valid 22-char base62 board ID is allowed to open a WebSocket room:
 * - When `ALLOW_ANY_BOARD_ID === "true"` (development/testing), any valid board ID is permitted.
 * - Otherwise (pilot/production before T3 D1 registry), the board ID must be listed in `PILOT_BOARD_IDS`.
 */
export function isBoardAccessAllowed(
  boardId: string,
  env: Pick<Env, "ALLOW_ANY_BOARD_ID" | "PILOT_BOARD_IDS">,
): boolean {
  if (!isValidBoardId(boardId)) {
    return false;
  }
  if (env.ALLOW_ANY_BOARD_ID === "true") {
    return true;
  }
  const pilotAllowlist = parsePilotBoardIds(env.PILOT_BOARD_IDS);
  return pilotAllowlist.has(boardId);
}

/**
 * Strips C0/C1 control characters, trims whitespace, and validates length (1..32 characters).
 * Returns sanitized nickname or null if invalid.
 */
export function sanitizeNickname(rawNick: string | null | undefined): string | null {
  if (typeof rawNick !== "string") {
    return null;
  }
  const cleaned = rawNick.replace(CONTROL_CHARS_REGEX, "").trim();
  const codePointLength = Array.from(cleaned).length;
  if (codePointLength < 1 || codePointLength > 32) {
    return null;
  }
  return cleaned;
}

/**
 * Parses SAVE_INTERVAL_MS.
 * In production, clamps to 2000..8000 ms (default 5000 ms) so `alarm()` always runs before
 * Cloudflare's 10-second WebSocket Hibernation inactivity eviction threshold.
 * When ALLOW_ANY_BOARD_ID="true" (dev/test), allows intervals down to 50 ms (e.g. 1000 ms in tests).
 */
export function resolveSaveIntervalMs(
  rawValue: string | undefined,
  allowDevInterval = false,
): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (Number.isNaN(parsed)) {
    return DEFAULT_SAVE_INTERVAL_MS;
  }
  const minAllowed = allowDevInterval ? MIN_DEV_SAVE_INTERVAL_MS : MIN_PROD_SAVE_INTERVAL_MS;
  return Math.min(MAX_PROD_SAVE_INTERVAL_MS, Math.max(minAllowed, parsed));
}

function resolvePositiveLimit(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

/**
 * Validates that an incoming value is a well-formed Excalidraw element with id, version, and versionNonce.
 */
export function isValidExcalidrawElement(value: unknown): value is ExcalidrawElementRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length >= 1 &&
    candidate.id.length <= 128 &&
    typeof candidate.version === "number" &&
    Number.isFinite(candidate.version) &&
    candidate.version >= 0 &&
    typeof candidate.versionNonce === "number" &&
    Number.isFinite(candidate.versionNonce)
  );
}

/**
 * Mirrors Excalidraw's `reconcileElements` conflict resolution:
 * - Higher `version` wins.
 * - On equal `version`, lower `versionNonce` wins.
 */
export function shouldReplaceElement(
  existing: ExcalidrawElementRecord | undefined,
  incoming: ExcalidrawElementRecord,
): boolean {
  if (!existing) {
    return true;
  }
  if (incoming.version > existing.version) {
    return true;
  }
  if (incoming.version === existing.version && incoming.versionNonce < existing.versionNonce) {
    return true;
  }
  return false;
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === "string") {
    return textEncoder.encode(data);
  }
  return new Uint8Array(0);
}

/**
 * Computes a deterministic dual-hash digest + byteLength for a snapshot chunk
 * so `flushSnapshot` only writes chunks whose content actually changed.
 */
export function computeChunkDigest(chunk: Uint8Array): string {
  let fnv = 2166136261;
  let djb = 5381;
  for (let i = 0; i < chunk.byteLength; i++) {
    const b = chunk[i] ?? 0;
    fnv ^= b;
    fnv = Math.imul(fnv, 16777619) >>> 0;
    djb = (Math.imul(djb, 33) ^ b) >>> 0;
  }
  return `${chunk.byteLength}:${fnv.toString(16)}:${djb.toString(16)}`;
}

/**
 * Creates a 101 Switching Protocols Response with an attached WebSocket.
 * Uses native `new Response(null, { status: 101, webSocket })` in Cloudflare workerd,
 * with a fallback object for Node's undici Response which rejects status 101 in unit tests.
 */
function createWebSocketUpgradeResponse(client: WebSocket): Response {
  try {
    return new Response(null, { status: 101, webSocket: client });
  } catch {
    return {
      status: 101,
      ok: false,
      headers: new Headers(),
      webSocket: client,
    } as unknown as Response;
  }
}

/**
 * Durable Object representing a single board room backed by SQLite storage (`new_sqlite_classes`)
 * and using the Cloudflare WebSocket Hibernation API.
 */
export class Board extends DurableObject<Env> {
  readonly saveIntervalMs: number;
  readonly maxBoardElements: number;
  readonly maxSnapshotBytes: number;

  private boardId = "unknown";
  private readonly elements = new Map<string, ExcalidrawElementRecord>();
  private readonly elementByteLengths = new Map<string, number>();
  private totalElementsBytes = 0;
  private readonly sessions = new Map<WebSocket, SessionRuntimeState>();

  private schemaInitialized = false;
  private lastPersistedChunksCount = 0;
  private readonly persistedChunkDigests = new Map<number, string>();
  private snapshotCorrupted = false;
  private snapshotSaveBlocked = false;
  private dirty = false;
  private alarmScheduled = false;
  private lastFlushAt = 0;

  private messagesAccepted = 0;
  private messagesDropped = 0;
  private flushesCount = 0;
  private lastFlushRowsWritten = 0;
  private totalRowsWritten = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const isDev = env.ALLOW_ANY_BOARD_ID === "true";
    this.saveIntervalMs = resolveSaveIntervalMs(env.SAVE_INTERVAL_MS, isDev);
    this.maxBoardElements = resolvePositiveLimit(env.MAX_BOARD_ELEMENTS, MAX_BOARD_ELEMENTS);
    this.maxSnapshotBytes = resolvePositiveLimit(env.MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_BYTES);

    // Configure automatic edge ping/pong response so pings do not wake hibernating Durable Objects
    if (
      typeof this.ctx.setWebSocketAutoResponse === "function" &&
      typeof WebSocketRequestResponsePair === "function"
    ) {
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
      );
    }

    // Restore hibernated WebSocket sessions from attachments
    if (typeof this.ctx.getWebSockets === "function") {
      for (const ws of this.ctx.getWebSockets()) {
        const attachment = this.readAttachment(ws);
        if (attachment?.boardId && this.boardId === "unknown") {
          this.boardId = attachment.boardId;
        }
        if (attachment && !attachment.rejected) {
          this.sessions.set(ws, {
            ...attachment,
            windowStartMs: 0,
            messagesInWindow: 0,
            sustainedExcessCount: 0,
            closed: false,
          });
        }
      }
    }

    // Load persisted snapshot from SQLite before processing incoming events
    this.ctx.blockConcurrencyWhile(async () => {
      this.loadSnapshotFromSqlite();
      const existingAlarm = await this.ctx.storage.getAlarm();
      this.alarmScheduled = existingAlarm !== null;
    });
  }

  private readAttachment(ws: WebSocket): WebSocketAttachment | null {
    if (typeof ws.deserializeAttachment !== "function") {
      return null;
    }
    try {
      const raw = ws.deserializeAttachment() as WebSocketAttachment | null;
      if (raw && typeof raw === "object" && typeof raw.sessionId === "string") {
        return raw;
      }
    } catch {
      // Ignore malformed attachment
    }
    return null;
  }

  private writeAttachment(ws: WebSocket, state: SessionRuntimeState): void {
    if (typeof ws.serializeAttachment !== "function") {
      return;
    }
    const resolvedBoardId =
      state.boardId && state.boardId !== "unknown" ? state.boardId : this.boardId;
    const attachment: WebSocketAttachment = {
      sessionId: state.sessionId,
      ...(resolvedBoardId !== "unknown" ? { boardId: resolvedBoardId } : {}),
      clientId: state.clientId,
      nick: state.nick,
      connectedAt: state.connectedAt,
      messagesAccepted: state.messagesAccepted,
      messagesDropped: state.messagesDropped,
    };
    ws.serializeAttachment(attachment);
  }

  private getOrRestoreSession(ws: WebSocket): SessionRuntimeState | null {
    const existing = this.sessions.get(ws);
    if (existing) {
      return existing;
    }
    const attachment = this.readAttachment(ws);
    if (attachment?.boardId && this.boardId === "unknown") {
      this.boardId = attachment.boardId;
    }
    if (!attachment || attachment.rejected) {
      return null;
    }
    const restored: SessionRuntimeState = {
      ...attachment,
      windowStartMs: 0,
      messagesInWindow: 0,
      sustainedExcessCount: 0,
      closed: false,
    };
    this.sessions.set(ws, restored);
    return restored;
  }

  private getActiveSessions(): Array<[WebSocket, SessionRuntimeState]> {
    if (typeof this.ctx.getWebSockets === "function") {
      for (const ws of this.ctx.getWebSockets()) {
        if (!this.sessions.has(ws)) {
          this.getOrRestoreSession(ws);
        }
      }
    }
    const active: Array<[WebSocket, SessionRuntimeState]> = [];
    for (const [ws, session] of this.sessions.entries()) {
      if (!session.closed) {
        active.push([ws, session]);
      }
    }
    return active;
  }

  private getCollaborators(): CollaboratorInfo[] {
    const collaborators: CollaboratorInfo[] = [];
    for (const [, session] of this.getActiveSessions()) {
      if (session.clientId) {
        collaborators.push({
          client_id: session.clientId,
          nick: session.nick,
        });
      }
    }
    return collaborators;
  }

  private estimateSnapshotBytes(elementsCount: number, totalElementBytes: number): number {
    const commasBytes = elementsCount > 1 ? elementsCount - 1 : 0;
    return SNAPSHOT_JSON_WRAPPER_BYTES + totalElementBytes + commasBytes;
  }

  private setElementInMemory(element: ExcalidrawElementRecord, byteLength?: number): void {
    const computedBytes =
      byteLength ?? textEncoder.encode(JSON.stringify(element)).byteLength;
    const prevBytes = this.elementByteLengths.get(element.id) ?? 0;
    this.elements.set(element.id, element);
    this.elementByteLengths.set(element.id, computedBytes);
    this.totalElementsBytes += computedBytes - prevBytes;
  }

  private deleteElementFromMemory(id: string): void {
    const prevBytes = this.elementByteLengths.get(id) ?? 0;
    if (this.elements.delete(id)) {
      this.elementByteLengths.delete(id);
      this.totalElementsBytes = Math.max(0, this.totalElementsBytes - prevBytes);
    }
  }

  /**
   * Copies corrupted snapshot chunks into `snapshot_backup`.
   * Returns `true` if the backup succeeded (allowing the board to start fresh and continue saving new edits),
   * or `false` if the backup transaction failed (in which case saving must be blocked and clients receive
   * `{"type":"error","code":"board_not_saved"}` on `hello`).
   */
  private backupCorruptedSnapshotChunks(
    sql: SqlStorage,
    byteChunks: Uint8Array[],
    errorMsg: string,
  ): boolean {
    const nowMs = Date.now();
    try {
      const runBackupTx = () => {
        sql.exec(
          "CREATE TABLE IF NOT EXISTS snapshot_backup (chunk_idx INTEGER PRIMARY KEY, data BLOB, backed_up_at INTEGER)",
        );
        for (let idx = 0; idx < byteChunks.length; idx++) {
          const chunkData = byteChunks[idx];
          if (chunkData) {
            sql.exec(
              "INSERT OR REPLACE INTO snapshot_backup (chunk_idx, data, backed_up_at) VALUES (?, ?, ?)",
              idx,
              chunkData,
              nowMs,
            );
          }
        }
      };

      if (typeof this.ctx.storage.transactionSync === "function") {
        this.ctx.storage.transactionSync(runBackupTx);
      } else {
        runBackupTx();
      }

      console.log(
        JSON.stringify({
          event: "snapshot_corrupted_backup_saved",
          boardId: this.boardId,
          chunksBackedUp: byteChunks.length,
          error: errorMsg,
          timestamp: nowMs,
        }),
      );
      return true;
    } catch (backupErr) {
      console.log(
        JSON.stringify({
          event: "snapshot_corrupted_backup_failed",
          boardId: this.boardId,
          error: backupErr instanceof Error ? backupErr.message : String(backupErr),
          originalError: errorMsg,
          timestamp: nowMs,
        }),
      );
      return false;
    }
  }

  private loadSnapshotFromSqlite(): void {
    const sql = this.ctx.storage?.sql;
    if (!sql) {
      return;
    }

    const tableCheck = sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'snapshot'")
      .toArray();
    if (tableCheck.length === 0) {
      return;
    }

    this.schemaInitialized = true;

    const chunkRows = sql
      .exec("SELECT chunk_idx, data FROM snapshot ORDER BY chunk_idx ASC")
      .toArray() as Array<{ chunk_idx: number; data: unknown }>;
    this.lastPersistedChunksCount = chunkRows.length;
    this.persistedChunkDigests.clear();
    if (chunkRows.length === 0) {
      return;
    }

    const byteChunks: Uint8Array[] = [];
    for (let idx = 0; idx < chunkRows.length; idx++) {
      const row = chunkRows[idx];
      const bytes = toUint8Array(row?.data);
      byteChunks.push(bytes);
      this.persistedChunkDigests.set(idx, computeChunkDigest(bytes));
    }

    const totalLength = byteChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of byteChunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    try {
      const jsonStr = textDecoder.decode(combined);
      const parsed = JSON.parse(jsonStr) as {
        v?: number;
        elements?: unknown[];
      };
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.elements)) {
        throw new Error("Snapshot JSON does not contain an elements array");
      }
      this.elements.clear();
      this.elementByteLengths.clear();
      this.totalElementsBytes = 0;
      for (const item of parsed.elements) {
        if (isValidExcalidrawElement(item)) {
          this.setElementInMemory(item);
        }
      }
      this.snapshotCorrupted = false;
      this.snapshotSaveBlocked = false;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.snapshotCorrupted = true;
      this.elements.clear();
      this.elementByteLengths.clear();
      this.totalElementsBytes = 0;
      console.log(
        JSON.stringify({
          event: "snapshot_load_error",
          boardId: this.boardId,
          error: errorMsg,
        }),
      );
      const backupOk = this.backupCorruptedSnapshotChunks(sql, byteChunks, errorMsg);
      if (backupOk) {
        // Backup succeeded: clear digests so subsequent normal flushes overwrite `snapshot` cleanly
        this.persistedChunkDigests.clear();
        this.snapshotSaveBlocked = false;
      } else {
        // Backup failed: block writes to `snapshot` so original data is not destroyed, and notify clients on `hello`
        this.snapshotSaveBlocked = true;
      }
    }
  }

  /**
   * Prunes soft-deleted elements (`isDeleted: true` or `is_deleted: true`) older than 30 days by `updated`.
   */
  private pruneExpiredDeletedElements(nowMs: number): number {
    const cutoffMs = nowMs - DELETED_ELEMENT_RETENTION_MS;
    let pruned = 0;
    for (const [id, element] of this.elements.entries()) {
      const isDeleted = element.isDeleted === true || element.is_deleted === true;
      if (
        isDeleted &&
        typeof element.updated === "number" &&
        Number.isFinite(element.updated) &&
        element.updated < cutoffMs
      ) {
        this.deleteElementFromMemory(id);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Flushes the current in-memory scene snapshot into the `snapshot` SQLite table
   * in a single transaction, splitting into chunks <= 900 KB (in bytes).
   *
   * Optimizations & Safeguards (T2.5 / T2.5b / T2.5c):
   * - Blocks writes ONLY if `this.snapshotSaveBlocked` is true (i.e. corrupted snapshot could not be backed up to `snapshot_backup`).
   * - Does NOT write `meta` rows (`board_id` or `snapshot_version`) on flush.
   * - Writes ONLY chunks whose content digest (`computeChunkDigest`) changed since the previous flush.
   * - Executes `DELETE FROM snapshot WHERE chunk_idx >= ?` ONLY when `chunks.length < this.lastPersistedChunksCount`.
   * - Stages updated digests and chunk count in local variables inside `runTx` and commits them to `this.persistedChunkDigests`
   *   and `this.lastPersistedChunksCount` ONLY after `transactionSync` succeeds (preventing silent data loss on rollback).
   */
  public flushSnapshot(reason: FlushReason, nowMs = Date.now()): FlushStats | null {
    if (!this.dirty) {
      return null;
    }

    if (this.snapshotSaveBlocked) {
      console.log(
        JSON.stringify({
          event: "snapshot_flush_skipped_backup_failed",
          boardId: this.boardId,
          reason,
          timestamp: nowMs,
        }),
      );
      return null;
    }

    const sql = this.ctx.storage?.sql;
    if (!sql) {
      return null;
    }

    this.pruneExpiredDeletedElements(nowMs);

    const payloadObj = {
      v: 1,
      elements: Array.from(this.elements.values()),
    };
    const encodedBytes = textEncoder.encode(JSON.stringify(payloadObj));

    const chunks: Uint8Array[] = [];
    if (encodedBytes.byteLength === 0) {
      chunks.push(new Uint8Array(0));
    } else {
      for (let offset = 0; offset < encodedBytes.byteLength; offset += MAX_SNAPSHOT_CHUNK_BYTES) {
        const end = Math.min(offset + MAX_SNAPSHOT_CHUNK_BYTES, encodedBytes.byteLength);
        chunks.push(encodedBytes.subarray(offset, end));
      }
    }

    let rowsWrittenInFlush = 0;
    let stagedSchemaInitialized = this.schemaInitialized;
    let stagedChunksCount = this.lastPersistedChunksCount;
    let stagedDigests = new Map<number, string>(this.persistedChunkDigests);

    const runTx = () => {
      rowsWrittenInFlush = 0;
      stagedSchemaInitialized = this.schemaInitialized;
      stagedChunksCount = this.lastPersistedChunksCount;
      stagedDigests = new Map<number, string>(this.persistedChunkDigests);

      if (!stagedSchemaInitialized) {
        sql.exec("CREATE TABLE IF NOT EXISTS snapshot (chunk_idx INTEGER PRIMARY KEY, data BLOB)");
        stagedSchemaInitialized = true;
      }

      for (let idx = 0; idx < chunks.length; idx++) {
        const chunkData = chunks[idx];
        if (!chunkData) {
          continue;
        }
        const nextDigest = computeChunkDigest(chunkData);
        if (this.persistedChunkDigests.get(idx) === nextDigest) {
          continue;
        }
        const cChunk = sql.exec(
          "INSERT OR REPLACE INTO snapshot (chunk_idx, data) VALUES (?, ?)",
          idx,
          chunkData,
        );
        rowsWrittenInFlush += cChunk.rowsWritten ?? 1;
        stagedDigests.set(idx, nextDigest);
      }

      // Only execute DELETE when the new snapshot has strictly fewer chunks than previously persisted
      if (chunks.length < this.lastPersistedChunksCount) {
        const cDel = sql.exec("DELETE FROM snapshot WHERE chunk_idx >= ?", chunks.length);
        rowsWrittenInFlush += cDel.rowsWritten ?? 0;
        for (let idx = chunks.length; idx < this.lastPersistedChunksCount; idx++) {
          stagedDigests.delete(idx);
        }
      }
      stagedChunksCount = chunks.length;
    };

    if (typeof this.ctx.storage.transactionSync === "function") {
      this.ctx.storage.transactionSync(runTx);
    } else {
      runTx();
    }

    // Apply staged state ONLY after the SQLite transaction has succeeded without throwing (T2.5c section 1)
    this.schemaInitialized = stagedSchemaInitialized;
    this.lastPersistedChunksCount = stagedChunksCount;
    this.persistedChunkDigests.clear();
    for (const [k, v] of stagedDigests.entries()) {
      this.persistedChunkDigests.set(k, v);
    }

    this.dirty = false;
    this.lastFlushAt = nowMs;
    this.flushesCount += 1;
    this.lastFlushRowsWritten = rowsWrittenInFlush;
    this.totalRowsWritten += rowsWrittenInFlush;

    const stats: FlushStats = {
      reason,
      messagesAccepted: this.messagesAccepted,
      messagesDropped: this.messagesDropped,
      flushesCount: this.flushesCount,
      rowsWritten: rowsWrittenInFlush,
      totalRowsWritten: this.totalRowsWritten,
      chunksCount: chunks.length,
      elementsCount: this.elements.size,
    };

    console.log(
      JSON.stringify({
        event: "snapshot_flush",
        boardId: this.boardId,
        ...stats,
        timestamp: nowMs,
      }),
    );

    return stats;
  }

  private async scheduleFlushAlarmIfNeeded(nowMs: number): Promise<void> {
    if (this.alarmScheduled) {
      return;
    }
    const earliestNextFlush =
      this.lastFlushAt > 0
        ? Math.max(nowMs + this.saveIntervalMs, this.lastFlushAt + this.saveIntervalMs)
        : nowMs + this.saveIntervalMs;
    this.alarmScheduled = true;
    await this.ctx.storage.setAlarm(earliestNextFlush);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return Response.json({ ok: false, error: "Expected GET request" }, { status: 400 });
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return Response.json({ ok: false, error: "Expected Upgrade: websocket" }, { status: 400 });
    }

    const url = new URL(request.url);
    const pathMatch = /^\/ws\/([^/]+)$/.exec(url.pathname);
    const candidateBoardId = pathMatch?.[1] ?? null;
    if (!isValidBoardId(candidateBoardId)) {
      return Response.json(
        { ok: false, error: "Invalid board id: expected 22 base62 characters" },
        { status: 400 },
      );
    }

    const rawNick = url.searchParams.get("nick");
    const nick = sanitizeNickname(rawNick);
    if (!nick) {
      return Response.json(
        { ok: false, error: "Invalid nick: expected 1..32 non-control characters" },
        { status: 400 },
      );
    }

    this.boardId = candidateBoardId;

    const activeCount = this.getActiveSessions().length;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (activeCount >= MAX_CONNECTIONS_PER_BOARD) {
      this.ctx.acceptWebSocket(server);
      if (typeof server.serializeAttachment === "function") {
        server.serializeAttachment({
          sessionId: "rejected",
          boardId: candidateBoardId,
          clientId: null,
          nick,
          connectedAt: Date.now(),
          messagesAccepted: 0,
          messagesDropped: 0,
          rejected: true,
        } satisfies WebSocketAttachment);
      }
      server.close(1013, "Board connection limit reached (max 20)");
      console.log(
        JSON.stringify({
          event: "connection_rejected_limit",
          boardId: this.boardId,
          nick,
          activeConnections: activeCount,
          maxConnections: MAX_CONNECTIONS_PER_BOARD,
          timestamp: Date.now(),
        }),
      );
      return createWebSocketUpgradeResponse(client);
    }

    this.ctx.acceptWebSocket(server);

    const nowMs = Date.now();
    const sessionState: SessionRuntimeState = {
      sessionId: crypto.randomUUID(),
      boardId: candidateBoardId,
      clientId: null,
      nick,
      connectedAt: nowMs,
      messagesAccepted: 0,
      messagesDropped: 0,
      windowStartMs: 0,
      messagesInWindow: 0,
      sustainedExcessCount: 0,
      closed: false,
    };

    this.writeAttachment(server, sessionState);
    this.sessions.set(server, sessionState);

    return createWebSocketUpgradeResponse(client);
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
    nowMs = Date.now(),
  ): Promise<void> {
    const session = this.getOrRestoreSession(ws);
    if (!session || session.closed) {
      return;
    }

    // 1. Check incoming message size limit (<= 2 MiB)
    let rawText: string;
    let byteLength: number;
    if (typeof message === "string") {
      if (message.length > MAX_MESSAGE_BYTES) {
        byteLength = textEncoder.encode(message).byteLength;
      } else {
        const encoded = textEncoder.encode(message);
        byteLength = encoded.byteLength;
      }
      if (byteLength > MAX_MESSAGE_BYTES) {
        session.messagesDropped += 1;
        this.messagesDropped += 1;
        this.writeAttachment(ws, session);
        console.log(
          JSON.stringify({
            event: "message_rejected_size",
            boardId: this.boardId,
            clientId: session.clientId,
            nick: session.nick,
            byteLength,
            maxBytes: MAX_MESSAGE_BYTES,
            timestamp: nowMs,
          }),
        );
        return;
      }
      rawText = message;
    } else {
      byteLength = message.byteLength;
      if (byteLength > MAX_MESSAGE_BYTES) {
        session.messagesDropped += 1;
        this.messagesDropped += 1;
        this.writeAttachment(ws, session);
        console.log(
          JSON.stringify({
            event: "message_rejected_size",
            boardId: this.boardId,
            clientId: session.clientId,
            nick: session.nick,
            byteLength,
            maxBytes: MAX_MESSAGE_BYTES,
            timestamp: nowMs,
          }),
        );
        return;
      }
      rawText = textDecoder.decode(message);
    }

    // 2. Enforce per-connection rate limit (<= 30 messages/sec)
    if (session.windowStartMs === 0 || nowMs - session.windowStartMs >= 1000) {
      if (session.messagesInWindow <= MAX_MESSAGES_PER_SECOND) {
        session.sustainedExcessCount = 0;
      }
      session.windowStartMs = nowMs;
      session.messagesInWindow = 0;
    }

    session.messagesInWindow += 1;
    if (session.messagesInWindow > MAX_MESSAGES_PER_SECOND) {
      session.messagesDropped += 1;
      session.sustainedExcessCount += 1;
      this.messagesDropped += 1;
      this.writeAttachment(ws, session);

      if (session.sustainedExcessCount >= SUSTAINED_RATE_LIMIT_EXCESS_THRESHOLD) {
        console.log(
          JSON.stringify({
            event: "connection_closed_rate_limit",
            boardId: this.boardId,
            clientId: session.clientId,
            nick: session.nick,
            messagesDropped: session.messagesDropped,
            timestamp: nowMs,
          }),
        );
        await this.closeSessionInternal(ws, session, 1008, "Rate limit exceeded", nowMs);
      }
      return;
    }

    // 3. Parse and validate JSON message
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      console.log(
        JSON.stringify({
          event: "invalid_message_json",
          boardId: this.boardId,
          clientId: session.clientId,
          nick: session.nick,
          timestamp: nowMs,
        }),
      );
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.log(
        JSON.stringify({
          event: "invalid_message_shape",
          boardId: this.boardId,
          clientId: session.clientId,
          nick: session.nick,
          timestamp: nowMs,
        }),
      );
      return;
    }

    const msg = parsed as Record<string, unknown>;
    const msgType = msg.type;
    if (typeof msgType !== "string") {
      console.log(
        JSON.stringify({
          event: "invalid_message_missing_type",
          boardId: this.boardId,
          clientId: session.clientId,
          nick: session.nick,
          timestamp: nowMs,
        }),
      );
      return;
    }

    session.messagesAccepted += 1;
    this.messagesAccepted += 1;

    switch (msgType) {
      case "ping": {
        ws.send('{"type":"pong"}');
        this.writeAttachment(ws, session);
        return;
      }

      case "hello": {
        if (
          typeof msg.client_id !== "string" ||
          msg.client_id.trim().length === 0 ||
          msg.client_id.length > 64
        ) {
          console.log(
            JSON.stringify({
              event: "invalid_hello_client_id",
              boardId: this.boardId,
              nick: session.nick,
              timestamp: nowMs,
            }),
          );
          return;
        }
        if (msg.nick !== undefined) {
          const updatedNick = sanitizeNickname(String(msg.nick));
          if (!updatedNick) {
            console.log(
              JSON.stringify({
                event: "invalid_hello_nick",
                boardId: this.boardId,
                clientId: msg.client_id,
                timestamp: nowMs,
              }),
            );
            return;
          }
          session.nick = updatedNick;
        }
        session.clientId = msg.client_id.trim();
        this.writeAttachment(ws, session);

        const snapshotMsg = JSON.stringify({
          type: "snapshot",
          elements: Array.from(this.elements.values()),
          collaborators: this.getCollaborators(),
        });
        ws.send(snapshotMsg);

        if (this.snapshotSaveBlocked) {
          ws.send(JSON.stringify({ type: "error", code: "board_not_saved" }));
        }
        return;
      }

      case "scene_update": {
        if (!Array.isArray(msg.elements)) {
          console.log(
            JSON.stringify({
              event: "invalid_scene_update_elements",
              boardId: this.boardId,
              clientId: session.clientId,
              nick: session.nick,
              timestamp: nowMs,
            }),
          );
          return;
        }

        // Deduplicate winning elements inside the incoming batch first and check board ceiling
        const candidateUpdates = new Map<
          string,
          { element: ExcalidrawElementRecord; byteLength: number }
        >();
        for (const rawEl of msg.elements) {
          if (!isValidExcalidrawElement(rawEl)) {
            console.log(
              JSON.stringify({
                event: "invalid_scene_element",
                boardId: this.boardId,
                clientId: session.clientId,
                nick: session.nick,
                timestamp: nowMs,
              }),
            );
            continue;
          }
          const currentBest = candidateUpdates.get(rawEl.id)?.element ?? this.elements.get(rawEl.id);
          if (shouldReplaceElement(currentBest, rawEl)) {
            const elBytes = textEncoder.encode(JSON.stringify(rawEl)).byteLength;
            candidateUpdates.set(rawEl.id, { element: rawEl, byteLength: elBytes });
          }
        }

        if (candidateUpdates.size === 0) {
          this.writeAttachment(ws, session);
          return;
        }

        let prospectiveCount = this.elements.size;
        let prospectiveElementBytes = this.totalElementsBytes;
        for (const [id, entry] of candidateUpdates.entries()) {
          if (!this.elements.has(id)) {
            prospectiveCount += 1;
          }
          const prevBytes = this.elementByteLengths.get(id) ?? 0;
          prospectiveElementBytes += entry.byteLength - prevBytes;
        }

        const prospectiveSnapshotBytes = this.estimateSnapshotBytes(
          prospectiveCount,
          prospectiveElementBytes,
        );

        if (
          prospectiveCount > this.maxBoardElements ||
          prospectiveSnapshotBytes > this.maxSnapshotBytes
        ) {
          session.messagesDropped += 1;
          this.messagesDropped += 1;
          this.writeAttachment(ws, session);
          ws.send(JSON.stringify({ type: "error", code: "board_too_large" }));
          console.log(
            JSON.stringify({
              event: "board_too_large_rejected",
              boardId: this.boardId,
              clientId: session.clientId,
              nick: session.nick,
              prospectiveCount,
              maxBoardElements: this.maxBoardElements,
              prospectiveSnapshotBytes,
              maxSnapshotBytes: this.maxSnapshotBytes,
              timestamp: nowMs,
            }),
          );
          return;
        }

        const updatedElements: ExcalidrawElementRecord[] = [];
        for (const entry of candidateUpdates.values()) {
          this.setElementInMemory(entry.element, entry.byteLength);
          updatedElements.push(entry.element);
        }

        this.writeAttachment(ws, session);

        this.dirty = true;
        await this.scheduleFlushAlarmIfNeeded(nowMs);

        const broadcastPayload = JSON.stringify({
          type: "scene_update",
          client_id: session.clientId ?? session.sessionId,
          nick: session.nick,
          elements: updatedElements,
        });

        this.broadcastExcept(ws, broadcastPayload);
        return;
      }

      case "cursor": {
        if (
          typeof msg.x !== "number" ||
          !Number.isFinite(msg.x) ||
          typeof msg.y !== "number" ||
          !Number.isFinite(msg.y)
        ) {
          console.log(
            JSON.stringify({
              event: "invalid_cursor_coordinates",
              boardId: this.boardId,
              clientId: session.clientId,
              nick: session.nick,
              timestamp: nowMs,
            }),
          );
          return;
        }

        this.writeAttachment(ws, session);

        const cursorPayload = JSON.stringify({
          type: "cursor",
          client_id: session.clientId ?? session.sessionId,
          nick: session.nick,
          x: msg.x,
          y: msg.y,
          ...(msg.pointer !== undefined ? { pointer: msg.pointer } : {}),
          ...(msg.tool !== undefined ? { tool: msg.tool } : {}),
        });

        this.broadcastExcept(ws, cursorPayload);
        return;
      }

      default: {
        console.log(
          JSON.stringify({
            event: "invalid_message_unknown_type",
            boardId: this.boardId,
            clientId: session.clientId,
            nick: session.nick,
            messageType: msgType,
            timestamp: nowMs,
          }),
        );
        return;
      }
    }
  }

  private broadcastExcept(senderWs: WebSocket, serializedMessage: string): void {
    for (const [peerWs] of this.getActiveSessions()) {
      if (peerWs === senderWs) {
        continue;
      }
      try {
        peerWs.send(serializedMessage);
      } catch {
        // Ignore broken peer socket during broadcast
      }
    }
  }

  /**
   * Closes a client session and immediately flushes any unsaved dirty state to SQLite.
   * Per T2.5b section B.5, in the real Cloudflare Workers runtime `ctx.getWebSockets()` may
   * still include closing sockets during `webSocketClose`, so we flush unconditionally whenever
   * `this.dirty` is true on any socket close/error instead of waiting for `remainingActive === 0`.
   */
  private async closeSessionInternal(
    ws: WebSocket,
    session: SessionRuntimeState,
    code: number,
    reason: string,
    nowMs = Date.now(),
  ): Promise<void> {
    if (session.closed) {
      return;
    }
    session.closed = true;
    this.sessions.delete(ws);

    try {
      ws.close(code, reason);
    } catch {
      // Ignore if socket is already closed
    }

    if (this.dirty) {
      this.flushSnapshot("connection_close", nowMs);
      if (this.alarmScheduled) {
        this.alarmScheduled = false;
        await this.ctx.storage.deleteAlarm();
      }
    }

    const remainingActive = this.getActiveSessions().length;

    console.log(
      JSON.stringify({
        event: "connection_close",
        boardId: this.boardId,
        clientId: session.clientId,
        nick: session.nick,
        code,
        sessionMessagesAccepted: session.messagesAccepted,
        sessionMessagesDropped: session.messagesDropped,
        messagesAccepted: this.messagesAccepted,
        messagesDropped: this.messagesDropped,
        flushesCount: this.flushesCount,
        lastFlushRowsWritten: this.lastFlushRowsWritten,
        totalRowsWritten: this.totalRowsWritten,
        activeConnections: remainingActive,
        timestamp: nowMs,
      }),
    );
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const session = this.getOrRestoreSession(ws);
    if (!session) {
      if (this.dirty) {
        this.flushSnapshot("connection_close", Date.now());
      }
      return;
    }
    await this.closeSessionInternal(ws, session, code, reason);
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const session = this.getOrRestoreSession(ws);
    console.log(
      JSON.stringify({
        event: "websocket_error",
        boardId: this.boardId,
        clientId: session?.clientId ?? null,
        nick: session?.nick ?? null,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      }),
    );
    if (session) {
      await this.closeSessionInternal(ws, session, 1011, "WebSocket error");
    } else if (this.dirty) {
      this.flushSnapshot("connection_close", Date.now());
    }
  }

  override async alarm(): Promise<void> {
    const scheduledAlarmTime = await this.ctx.storage.getAlarm();
    const effectiveNow = scheduledAlarmTime ?? Date.now();
    this.alarmScheduled = false;
    if (this.dirty) {
      this.flushSnapshot("alarm", effectiveNow);
    }
  }

  /**
   * Diagnostic getter for tests and metrics inspection.
   */
  public getMetrics() {
    return {
      boardId: this.boardId,
      saveIntervalMs: this.saveIntervalMs,
      elementsCount: this.elements.size,
      estimatedSnapshotBytes: this.estimateSnapshotBytes(
        this.elements.size,
        this.totalElementsBytes,
      ),
      activeConnections: this.getActiveSessions().length,
      messagesAccepted: this.messagesAccepted,
      messagesDropped: this.messagesDropped,
      flushesCount: this.flushesCount,
      lastFlushRowsWritten: this.lastFlushRowsWritten,
      totalRowsWritten: this.totalRowsWritten,
      dirty: this.dirty,
      alarmScheduled: this.alarmScheduled,
      snapshotCorrupted: this.snapshotCorrupted,
      snapshotSaveBlocked: this.snapshotSaveBlocked,
    };
  }
}
