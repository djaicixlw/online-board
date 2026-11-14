import { webcrypto } from "node:crypto";
import type { Board } from "../src/board.js";
import type { Env } from "../src/env.js";

const globalScope = globalThis as unknown as Record<string, unknown>;

if (typeof globalScope.crypto === "undefined") {
  globalScope.crypto = webcrypto;
}

/**
 * Runtime shim and in-memory SQLite + WebSocket Hibernation harness for `cloudflare:workers`
 * when running Vitest in a standard Node environment.
 */
export class DurableObject<E = unknown> {
  protected ctx: DurableObjectState;
  protected env: E;

  constructor(ctx: DurableObjectState, env: E) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response("Not Implemented", { status: 501 });
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}
  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {}
  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {}
  async alarm(): Promise<void> {}
}

export class MockWebSocketRequestResponsePair {
  readonly request: string;
  readonly response: string;

  constructor(request: string, response: string) {
    this.request = request;
    this.response = response;
  }
}

export interface CloseRecord {
  code: number;
  reason: string;
}

export class MockSocket {
  public peer: MockSocket | null = null;
  public readyState = 1; // OPEN
  public readonly sentMessages: string[] = [];
  public closeRecord: CloseRecord | null = null;
  private attachment: unknown = null;
  private stateOwner: MockDurableObjectState | null = null;
  private messageListeners: Array<(event: { data: string }) => void> = [];
  private closeListeners: Array<(event: CloseRecord) => void> = [];

  public bindStateOwner(owner: MockDurableObjectState): void {
    this.stateOwner = owner;
  }

  public serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  public deserializeAttachment(): unknown {
    return this.attachment ? structuredClone(this.attachment) : null;
  }

  public send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 1) {
      throw new Error("WebSocket is not open");
    }
    const text =
      typeof data === "string"
        ? data
        : new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data));

    if (this.peer) {
      if (this.peer.stateOwner) {
        const autoPair = this.peer.stateOwner.getWebSocketAutoResponse();
        if (autoPair && text === autoPair.request) {
          this.sentMessages.push(autoPair.response);
          for (const listener of this.messageListeners) {
            listener({ data: autoPair.response });
          }
          return;
        }
      }
      this.peer.sentMessages.push(text);
      for (const listener of this.peer.messageListeners) {
        listener({ data: text });
      }
    }
  }

  public close(code = 1000, reason = ""): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3; // CLOSED
    this.closeRecord = { code, reason };
    for (const listener of this.closeListeners) {
      listener({ code, reason });
    }
    if (this.peer && this.peer.readyState !== 3) {
      this.peer.readyState = 3;
      this.peer.closeRecord = { code, reason };
      for (const listener of this.peer.closeListeners) {
        listener({ code, reason });
      }
    }
  }

  public addEventListener(
    type: string,
    listener: ((event: { data: string }) => void) | ((event: CloseRecord) => void),
  ): void {
    if (type === "message") {
      this.messageListeners.push(listener as (event: { data: string }) => void);
    } else if (type === "close") {
      this.closeListeners.push(listener as (event: CloseRecord) => void);
    }
  }
}

export class MockWebSocketPair {
  0: WebSocket;
  1: WebSocket;

  constructor() {
    const client = new MockSocket();
    const server = new MockSocket();
    client.peer = server;
    server.peer = client;
    this[0] = client as unknown as WebSocket;
    this[1] = server as unknown as WebSocket;
  }
}

if (typeof globalScope.WebSocketRequestResponsePair === "undefined") {
  globalScope.WebSocketRequestResponsePair = MockWebSocketRequestResponsePair;
}

if (typeof globalScope.WebSocketPair === "undefined") {
  globalScope.WebSocketPair = MockWebSocketPair;
}

/**
 * In-memory SQLite storage engine simulating Durable Object's `ctx.storage.sql`
 * for `sqlite_master`, `meta`, `snapshot`, and `snapshot_backup` tables, including `rowsWritten` and `transactionSync`.
 */
export class MockSqlStorage {
  public tablesCreated = new Set<string>();
  public metaTable = new Map<string, string>();
  public snapshotTable = new Map<number, Uint8Array>();
  public snapshotBackupTable = new Map<number, { data: Uint8Array; backedUpAt: number }>();
  public filesTable = new Map<
    string,
    {
      file_id: string;
      chunk_idx: number;
      mime: string;
      total_bytes: number;
      data: Uint8Array;
      created_at: number;
      last_referenced_at: number;
    }
  >();

  public cloneState() {
    const snapshotCopy = new Map<number, Uint8Array>();
    for (const [k, v] of this.snapshotTable.entries()) {
      snapshotCopy.set(k, new Uint8Array(v));
    }
    const backupCopy = new Map<number, { data: Uint8Array; backedUpAt: number }>();
    for (const [k, v] of this.snapshotBackupTable.entries()) {
      backupCopy.set(k, { data: new Uint8Array(v.data), backedUpAt: v.backedUpAt });
    }
    const filesCopy = new Map<
      string,
      {
        file_id: string;
        chunk_idx: number;
        mime: string;
        total_bytes: number;
        data: Uint8Array;
        created_at: number;
        last_referenced_at: number;
      }
    >();
    for (const [k, v] of this.filesTable.entries()) {
      filesCopy.set(k, { ...v, data: new Uint8Array(v.data) });
    }
    return {
      tablesCreated: new Set(this.tablesCreated),
      metaTable: new Map(this.metaTable),
      snapshotTable: snapshotCopy,
      snapshotBackupTable: backupCopy,
      filesTable: filesCopy,
    };
  }

  public restoreState(snapshot: ReturnType<MockSqlStorage["cloneState"]>): void {
    this.tablesCreated = snapshot.tablesCreated;
    this.metaTable = snapshot.metaTable;
    this.snapshotTable = snapshot.snapshotTable;
    this.snapshotBackupTable = snapshot.snapshotBackupTable;
    this.filesTable = snapshot.filesTable;
  }

  public exec(query: string, ...bindings: unknown[]) {
    const normalized = query.trim().replace(/\s+/g, " ");
    const upper = normalized.toUpperCase();

    if (upper.startsWith("CREATE TABLE IF NOT EXISTS META")) {
      const existed = this.tablesCreated.has("meta");
      this.tablesCreated.add("meta");
      return {
        rowsRead: 0,
        rowsWritten: existed ? 0 : 1,
        toArray: () => [],
      };
    }

    if (upper.startsWith("CREATE TABLE IF NOT EXISTS SNAPSHOT_BACKUP")) {
      const existed = this.tablesCreated.has("snapshot_backup");
      this.tablesCreated.add("snapshot_backup");
      return {
        rowsRead: 0,
        rowsWritten: existed ? 0 : 1,
        toArray: () => [],
      };
    }

    if (upper.startsWith("CREATE TABLE IF NOT EXISTS SNAPSHOT")) {
      const existed = this.tablesCreated.has("snapshot");
      this.tablesCreated.add("snapshot");
      return {
        rowsRead: 0,
        rowsWritten: existed ? 0 : 1,
        toArray: () => [],
      };
    }

    if (upper.startsWith("CREATE TABLE IF NOT EXISTS FILES")) {
      const existed = this.tablesCreated.has("files");
      this.tablesCreated.add("files");
      return {
        rowsRead: 0,
        rowsWritten: existed ? 0 : 1,
        toArray: () => [],
      };
    }

    if (upper.startsWith("CREATE TABLE IF NOT EXISTS META")) {
      const existed = this.tablesCreated.has("meta");
      this.tablesCreated.add("meta");
      return {
        rowsRead: 0,
        rowsWritten: existed ? 0 : 1,
        toArray: () => [],
      };
    }

    if (upper.startsWith("SELECT NAME FROM SQLITE_MASTER")) {
      const rows: Array<{ name: string }> = [];
      if (upper.includes("NAME = 'META'")) {
        if (this.tablesCreated.has("meta")) {
          rows.push({ name: "meta" });
        }
      } else if (upper.includes("NAME = 'SNAPSHOT'")) {
        if (this.tablesCreated.has("snapshot")) {
          rows.push({ name: "snapshot" });
        }
      } else {
        for (const t of this.tablesCreated) {
          rows.push({ name: t });
        }
      }
      return {
        rowsRead: rows.length,
        rowsWritten: 0,
        toArray: () => rows,
      };
    }

    if (upper.startsWith("SELECT VALUE FROM META WHERE KEY = 'REVOKED'")) {
      const val = this.metaTable.get("revoked");
      const rows = val !== undefined ? [{ value: val }] : [];
      return {
        rowsRead: rows.length,
        rowsWritten: 0,
        toArray: () => rows,
      };
    }

    if (upper.startsWith("SELECT KEY, VALUE FROM META")) {
      const rows: Array<{ key: string; value: string }> = [];
      for (const [key, value] of this.metaTable.entries()) {
        rows.push({ key, value });
      }
      return {
        rowsRead: rows.length,
        rowsWritten: 0,
        toArray: () => rows,
      };
    }

    if (upper.startsWith("SELECT CHUNK_IDX, DATA FROM SNAPSHOT")) {
      const sortedKeys = Array.from(this.snapshotTable.keys()).sort((a, b) => a - b);
      const rows = sortedKeys.map((chunk_idx) => ({
        chunk_idx,
        data: this.snapshotTable.get(chunk_idx) ?? new Uint8Array(0),
      }));
      return {
        rowsRead: rows.length,
        rowsWritten: 0,
        toArray: () => rows,
      };
    }

    if (upper.startsWith("INSERT OR REPLACE INTO META")) {
      let key: string;
      let val: string;
      if (normalized.includes("'board_id'")) {
        key = "board_id";
        val = String(bindings[0] ?? "");
      } else if (normalized.includes("'snapshot_version'")) {
        key = "snapshot_version";
        val = String(bindings[0] ?? "");
      } else {
        key = String(bindings[0] ?? "");
        val = String(bindings[1] ?? "");
      }
      this.metaTable.set(key, val);
      return {
        rowsRead: 0,
        rowsWritten: 1,
        toArray: () => [],
      };
    }

    if (upper.startsWith("INSERT OR REPLACE INTO SNAPSHOT_BACKUP")) {
      const idx = Number(bindings[0]);
      const rawData = bindings[1];
      const backedUpAt = Number(bindings[2] ?? Date.now());
      const bytes =
        rawData instanceof Uint8Array
          ? new Uint8Array(rawData)
          : rawData instanceof ArrayBuffer
            ? new Uint8Array(rawData)
            : new TextEncoder().encode(String(rawData ?? ""));
      this.snapshotBackupTable.set(idx, { data: bytes, backedUpAt });
      return {
        rowsRead: 0,
        rowsWritten: 1,
        toArray: () => [],
      };
    }

    if (upper.startsWith("INSERT OR REPLACE INTO SNAPSHOT")) {
      const idx = Number(bindings[0]);
      const rawData = bindings[1];
      const bytes =
        rawData instanceof Uint8Array
          ? new Uint8Array(rawData)
          : rawData instanceof ArrayBuffer
            ? new Uint8Array(rawData)
            : new TextEncoder().encode(String(rawData ?? ""));
      this.snapshotTable.set(idx, bytes);
      return {
        rowsRead: 0,
        rowsWritten: 1,
        toArray: () => [],
      };
    }

    if (upper.startsWith("DELETE FROM SNAPSHOT WHERE CHUNK_IDX >=")) {
      const minIdx = Number(bindings[0]);
      let deleted = 0;
      for (const idx of Array.from(this.snapshotTable.keys())) {
        if (idx >= minIdx) {
          this.snapshotTable.delete(idx);
          deleted += 1;
        }
      }
      return {
        rowsRead: 0,
        rowsWritten: deleted,
        toArray: () => [],
      };
    }

    if (upper.startsWith("SELECT 1 FROM FILES WHERE FILE_ID =")) {
      const targetId = String(bindings[0] ?? "");
      let found = false;
      for (const f of this.filesTable.values()) {
        if (f.file_id === targetId) {
          found = true;
          break;
        }
      }
      return {
        rowsRead: found ? 1 : 0,
        rowsWritten: 0,
        toArray: () => (found ? [{ "1": 1 }] : []),
      };
    }

    if (upper.startsWith("SELECT CHUNK_IDX, MIME, TOTAL_BYTES, DATA FROM FILES WHERE FILE_ID =")) {
      const targetId = String(bindings[0] ?? "");
      const rows: Array<{
        chunk_idx: number;
        mime: string;
        total_bytes: number;
        data: Uint8Array;
      }> = [];
      for (const f of this.filesTable.values()) {
        if (f.file_id === targetId) {
          rows.push({
            chunk_idx: f.chunk_idx,
            mime: f.mime,
            total_bytes: f.total_bytes,
            data: f.data,
          });
        }
      }
      rows.sort((a, b) => a.chunk_idx - b.chunk_idx);
      return {
        rowsRead: rows.length,
        rowsWritten: 0,
        toArray: () => rows,
      };
    }

    if (upper.startsWith("SELECT COALESCE(SUM(LENGTH(DATA)), 0)")) {
      let total = 0;
      for (const f of this.filesTable.values()) {
        total += f.data.byteLength;
      }
      return {
        rowsRead: this.filesTable.size,
        rowsWritten: 0,
        toArray: () => [{ total }],
      };
    }

    if (upper.startsWith("INSERT INTO FILES") || upper.startsWith("INSERT OR REPLACE INTO FILES")) {
      const file_id = String(bindings[0] ?? "");
      const chunk_idx = Number(bindings[1] ?? 0);
      const mime = String(bindings[2] ?? "");
      const total_bytes = Number(bindings[3] ?? 0);
      const rawData = bindings[4];
      const data =
        rawData instanceof Uint8Array
          ? new Uint8Array(rawData)
          : rawData instanceof ArrayBuffer
            ? new Uint8Array(rawData)
            : new TextEncoder().encode(String(rawData ?? ""));
      const created_at = Number(bindings[5] ?? Date.now());
      const last_referenced_at = Number(bindings[6] ?? created_at);

      const key = `${file_id}:${chunk_idx}`;
      this.filesTable.set(key, {
        file_id,
        chunk_idx,
        mime,
        total_bytes,
        data,
        created_at,
        last_referenced_at,
      });

      return {
        rowsRead: 0,
        rowsWritten: 1,
        toArray: () => [],
      };
    }

    if (upper.startsWith("UPDATE FILES SET LAST_REFERENCED_AT = ? WHERE FILE_ID = ?")) {
      const now = Number(bindings[0] ?? Date.now());
      const targetId = String(bindings[1] ?? "");
      let updated = 0;
      for (const f of this.filesTable.values()) {
        if (f.file_id === targetId) {
          f.last_referenced_at = now;
          updated += 1;
        }
      }
      return {
        rowsRead: 0,
        rowsWritten: updated,
        toArray: () => [],
      };
    }

    if (upper.startsWith("DELETE FROM FILES WHERE LAST_REFERENCED_AT < ?")) {
      const cutoff = Number(bindings[0] ?? 0);
      let deleted = 0;
      for (const [k, f] of Array.from(this.filesTable.entries())) {
        if (f.last_referenced_at < cutoff) {
          this.filesTable.delete(k);
          deleted += 1;
        }
      }
      return {
        rowsRead: 0,
        rowsWritten: deleted,
        toArray: () => [],
      };
    }

    throw new Error(`Unsupported SQL query in MockSqlStorage: ${normalized}`);
  }
}

export class MockDurableObjectStorage {
  public readonly sql = new MockSqlStorage();
  public alarmTime: number | null = null;
  public setAlarmCalls = 0;

  public transactionSync<T>(fn: () => T): T {
    const backup = this.sql.cloneState();
    try {
      return fn();
    } catch (err) {
      this.sql.restoreState(backup);
      throw err;
    }
  }

  public async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmTime = typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();
    this.setAlarmCalls += 1;
  }

  public async getAlarm(): Promise<number | null> {
    return this.alarmTime;
  }

  public async deleteAlarm(): Promise<void> {
    this.alarmTime = null;
  }
}

export class MockDurableObjectState {
  public readonly storage: MockDurableObjectStorage;
  private readonly acceptedSockets: WebSocket[];
  private autoResponsePair: MockWebSocketRequestResponsePair | null = null;
  private readonly initPromises: Promise<unknown>[] = [];

  constructor(storage = new MockDurableObjectStorage(), existingSockets: WebSocket[] = []) {
    this.storage = storage;
    this.acceptedSockets = existingSockets;
  }

  public blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    const p = fn();
    this.initPromises.push(p);
    return p;
  }

  public async waitForInit(): Promise<void> {
    await Promise.all(this.initPromises);
  }

  public acceptWebSocket(ws: WebSocket): void {
    const mockWs = ws as unknown as MockSocket;
    if (typeof mockWs.bindStateOwner === "function") {
      mockWs.bindStateOwner(this);
    }
    if (!this.acceptedSockets.includes(ws)) {
      this.acceptedSockets.push(ws);
    }
  }

  public getWebSockets(): WebSocket[] {
    return this.acceptedSockets.filter((ws) => {
      const m = ws as unknown as MockSocket;
      return m.readyState === 1;
    });
  }

  public setWebSocketAutoResponse(pair?: MockWebSocketRequestResponsePair): void {
    this.autoResponsePair = pair ?? null;
  }

  public getWebSocketAutoResponse(): MockWebSocketRequestResponsePair | null {
    return this.autoResponsePair;
  }
}

/**
 * Creates a test environment with persistent per-board SQLite storage and Board Durable Object instances.
 */
export function createBoardTestHarness(
  BoardClass: new (ctx: DurableObjectState, env: Env) => Board,
  envOverrides: Partial<Env> = {},
) {
  const storages = new Map<string, MockDurableObjectStorage>();
  const socketsByBoard = new Map<string, WebSocket[]>();
  const instances = new Map<string, { board: Board; state: MockDurableObjectState }>();

  const env: Env = {
    SAVE_INTERVAL_MS: "5000",
    ALLOW_ANY_BOARD_ID: "true",
    ...envOverrides,
    BOARD: {
      idFromName(name: string) {
        return {
          toString: () => name,
          equals: (other: { toString(): string }) => other.toString() === name,
          name,
        } as unknown as DurableObjectId;
      },
      get(id: DurableObjectId) {
        const name = id.toString();
        let entry = instances.get(name);
        if (!entry) {
          let storage = storages.get(name);
          if (!storage) {
            storage = new MockDurableObjectStorage();
            storages.set(name, storage);
          }
          let sockets = socketsByBoard.get(name);
          if (!sockets) {
            sockets = [];
            socketsByBoard.set(name, sockets);
          }
          const state = new MockDurableObjectState(storage, sockets);
          const board = new BoardClass(state as unknown as DurableObjectState, env);
          entry = { board, state };
          instances.set(name, entry);
        }
        const currentEntry = entry;
        return {
          fetch: async (input: Request | string | URL, init?: RequestInit) => {
            await currentEntry.state.waitForInit();
            const req =
              typeof input === "string" || input instanceof URL ? new Request(input, init) : input;
            return currentEntry.board.fetch(req);
          },
        } as unknown as DurableObjectStub<Board>;
      },
    } as unknown as DurableObjectNamespace<Board>,
  };

  return {
    env,
    storages,
    getInstance(boardId: string) {
      const doId = env.BOARD.idFromName(boardId);
      env.BOARD.get(doId);
      const found = instances.get(boardId);
      if (!found) {
        throw new Error(`Expected Board instance for ${boardId}`);
      }
      return found;
    },
    /**
     * Simulates Durable Object eviction/hibernation and recreation on the same SQLite storage.
     */
    async recreateBoard(boardId: string) {
      const storage = storages.get(boardId) ?? new MockDurableObjectStorage();
      storages.set(boardId, storage);
      const existingSockets = (socketsByBoard.get(boardId) ?? []).filter(
        (ws) => (ws as unknown as MockSocket).readyState === 1,
      );
      socketsByBoard.set(boardId, existingSockets);
      const state = new MockDurableObjectState(storage, existingSockets);
      const board = new BoardClass(state as unknown as DurableObjectState, env);
      await state.waitForInit();
      const entry = { board, state };
      instances.set(boardId, entry);
      return entry;
    },
  };
}
