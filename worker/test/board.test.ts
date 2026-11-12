import { describe, expect, it } from "vitest";
import { generateBoardId, generateMultipleBoardIds } from "../../scripts/gen-board-id.mjs";
import worker from "../src/index.js";
import {
  Board,
  isBoardAccessAllowed,
  MAX_PILOT_BOARD_IDS,
  MAX_SNAPSHOT_CHUNK_BYTES,
  parsePilotBoardIds,
} from "../src/board.js";
import { createBoardTestHarness, type MockSocket } from "./cloudflare-workers-shim.js";

const VALID_BOARD_ID = "AbCdEfGhIjKlMnOpQrSt12"; // 22 base62 chars
const SECOND_PILOT_BOARD_ID = "0123456789abcdefghijkl"; // 22 base62 chars
const UNLISTED_BOARD_ID = "ZzYyXxWwVvUuTtSsRrQq99"; // 22 base62 chars

async function connectClient(
  harness: ReturnType<typeof createBoardTestHarness>,
  boardId: string,
  nick: string,
) {
  const url = `http://localhost:8787/ws/${boardId}?nick=${encodeURIComponent(nick)}`;
  const req = new Request(url, {
    method: "GET",
    headers: { Upgrade: "websocket" },
  });
  const res = await worker.fetch(req, harness.env);
  const { board, state } = harness.getInstance(boardId);
  const clientSocket = (res as unknown as { webSocket?: MockSocket }).webSocket;
  if (!clientSocket || !clientSocket.peer) {
    throw new Error("Expected upgraded MockSocket pair");
  }
  const serverSocket = clientSocket.peer as unknown as WebSocket;
  return { res, clientSocket, serverSocket, board, state };
}

describe("Task T1, T2.5, T2.5b & T2.5c: Board Room Durable Object, Pilot Access Control, and SQLite Persistence", () => {
  it("validates GET /ws/:id?nick=<ник> and enforces ALLOW_ANY_BOARD_ID vs PILOT_BOARD_IDS", async () => {
    const harness = createBoardTestHarness(Board);

    // Invalid board id length
    const badIdRes = await worker.fetch(
      new Request("http://localhost:8787/ws/shortId?nick=Alice", {
        headers: { Upgrade: "websocket" },
      }),
      harness.env,
    );
    expect(badIdRes.status).toBe(400);

    // Invalid non-base62 chars in board id
    const nonBase62Res = await worker.fetch(
      new Request("http://localhost:8787/ws/AbCdEfGhIjKlMnOpQrSt_2?nick=Alice", {
        headers: { Upgrade: "websocket" },
      }),
      harness.env,
    );
    expect(nonBase62Res.status).toBe(400);

    // Empty / control-char-only nick
    const badNickRes = await worker.fetch(
      new Request(`http://localhost:8787/ws/${VALID_BOARD_ID}?nick=%00%09%20`, {
        headers: { Upgrade: "websocket" },
      }),
      harness.env,
    );
    expect(badNickRes.status).toBe(400);

    // Nick > 32 chars
    const longNick = "А".repeat(33);
    const longNickRes = await worker.fetch(
      new Request(
        `http://localhost:8787/ws/${VALID_BOARD_ID}?nick=${encodeURIComponent(longNick)}`,
        {
          headers: { Upgrade: "websocket" },
        },
      ),
      harness.env,
    );
    expect(longNickRes.status).toBe(400);

    // ALLOW_ANY_BOARD_ID=false with empty PILOT_BOARD_IDS returns 404
    const prodEmptyHarness = createBoardTestHarness(Board, { ALLOW_ANY_BOARD_ID: "false" });
    const notFoundRes = await worker.fetch(
      new Request(`http://localhost:8787/ws/${VALID_BOARD_ID}?nick=Alice`, {
        headers: { Upgrade: "websocket" },
      }),
      prodEmptyHarness.env,
    );
    expect(notFoundRes.status).toBe(404);

    // ALLOW_ANY_BOARD_ID=false with PILOT_BOARD_IDS allows listed boards (101) and rejects unlisted boards (404)
    const pilotHarness = createBoardTestHarness(Board, {
      ALLOW_ANY_BOARD_ID: "false",
      PILOT_BOARD_IDS: ` ${VALID_BOARD_ID} , invalid-short-id , ${SECOND_PILOT_BOARD_ID} `,
    });

    const allowedPilotConn = await connectClient(pilotHarness, VALID_BOARD_ID, "Преподаватель");
    expect(allowedPilotConn.res.status).toBe(101);

    const secondAllowedConn = await connectClient(pilotHarness, SECOND_PILOT_BOARD_ID, "Ученик");
    expect(secondAllowedConn.res.status).toBe(101);

    const unlistedPilotRes = await worker.fetch(
      new Request(`http://localhost:8787/ws/${UNLISTED_BOARD_ID}?nick=Alice`, {
        headers: { Upgrade: "websocket" },
      }),
      pilotHarness.env,
    );
    expect(unlistedPilotRes.status).toBe(404);

    // Valid id and nick with surrounding spaces and control char get trimmed/cleaned and accepted (101)
    const okConn = await connectClient(harness, VALID_BOARD_ID, "  \u0007Анна\n  ");
    expect(okConn.res.status).toBe(101);
  });

  it("caps PILOT_BOARD_IDS at 50 valid 22-char base62 IDs and generates valid IDs via scripts/gen-board-id.mjs", () => {
    const generated50 = generateMultipleBoardIds(MAX_PILOT_BOARD_IDS);
    expect(generated50.length).toBe(50);
    for (const id of generated50) {
      expect(id).toMatch(/^[0-9A-Za-z]{22}$/);
    }

    const firstId = generated50[0] ?? "";
    const fiftiethId = generated50[49] ?? "";
    const extra51st = generateBoardId();
    const csvWith51 = [...generated50, extra51st].join(",");
    const parsedSet = parsePilotBoardIds(csvWith51);
    expect(parsedSet.size).toBe(50);
    expect(parsedSet.has(firstId)).toBe(true);
    expect(parsedSet.has(fiftiethId)).toBe(true);
    expect(parsedSet.has(extra51st)).toBe(false);

    expect(
      isBoardAccessAllowed(firstId, {
        ALLOW_ANY_BOARD_ID: "false",
        PILOT_BOARD_IDS: csvWith51,
      }),
    ).toBe(true);
    expect(
      isBoardAccessAllowed(extra51st, {
        ALLOW_ANY_BOARD_ID: "false",
        PILOT_BOARD_IDS: csvWith51,
      }),
    ).toBe(false);
  });

  it("delivers scene_update and cursor from Client A to Client B without echoing back to A", async () => {
    const harness = createBoardTestHarness(Board);
    const clientA = await connectClient(harness, VALID_BOARD_ID, "Преподаватель");
    const clientB = await connectClient(harness, VALID_BOARD_ID, "Ученик");

    await clientA.board.webSocketMessage(
      clientA.serverSocket,
      JSON.stringify({ type: "hello", client_id: "c-a", nick: "Преподаватель" }),
    );
    await clientB.board.webSocketMessage(
      clientB.serverSocket,
      JSON.stringify({ type: "hello", client_id: "c-b", nick: "Ученик" }),
    );

    // Clear initial snapshot responses
    clientA.clientSocket.sentMessages.length = 0;
    clientB.clientSocket.sentMessages.length = 0;

    // Client A sends scene_update
    const element1 = {
      id: "el-1",
      type: "rectangle",
      x: 10,
      y: 20,
      version: 1,
      versionNonce: 500,
      updated: 1700000000000,
    };
    await clientA.board.webSocketMessage(
      clientA.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [element1],
      }),
    );

    expect(clientA.clientSocket.sentMessages.length).toBe(0);
    expect(clientB.clientSocket.sentMessages.length).toBe(1);

    const receivedByB = JSON.parse(clientB.clientSocket.sentMessages[0] ?? "{}");
    expect(receivedByB).toEqual({
      type: "scene_update",
      client_id: "c-a",
      nick: "Преподаватель",
      elements: [element1],
    });

    // Client A sends cursor update
    clientB.clientSocket.sentMessages.length = 0;
    await clientA.board.webSocketMessage(
      clientA.serverSocket,
      JSON.stringify({
        type: "cursor",
        x: 150,
        y: 240,
        pointer: "mouse",
        tool: "laser",
      }),
    );

    expect(clientA.clientSocket.sentMessages.length).toBe(0);
    expect(clientB.clientSocket.sentMessages.length).toBe(1);
    const cursorByB = JSON.parse(clientB.clientSocket.sentMessages[0] ?? "{}");
    expect(cursorByB).toEqual({
      type: "cursor",
      client_id: "c-a",
      nick: "Преподаватель",
      x: 150,
      y: 240,
      pointer: "mouse",
      tool: "laser",
    });

    // Auto-response for exact {"type":"ping"} without waking DO
    clientA.clientSocket.send('{"type":"ping"}');
    expect(clientA.clientSocket.sentMessages[clientA.clientSocket.sentMessages.length - 1]).toBe(
      '{"type":"pong"}',
    );
  });

  it("sends snapshot with latest elements and collaborators when a new client sends hello", async () => {
    const harness = createBoardTestHarness(Board);
    const clientA = await connectClient(harness, VALID_BOARD_ID, "Ольга");
    await clientA.board.webSocketMessage(
      clientA.serverSocket,
      JSON.stringify({ type: "hello", client_id: "c-olga", nick: "Ольга" }),
    );

    const elA = { id: "arrow-1", type: "arrow", version: 3, versionNonce: 123 };
    await clientA.board.webSocketMessage(
      clientA.serverSocket,
      JSON.stringify({ type: "scene_update", elements: [elA] }),
    );

    // New client joins and sends hello
    const clientC = await connectClient(harness, VALID_BOARD_ID, "Максим");
    await clientC.board.webSocketMessage(
      clientC.serverSocket,
      JSON.stringify({ type: "hello", client_id: "c-max", nick: "Максим" }),
    );

    expect(clientC.clientSocket.sentMessages.length).toBe(1);
    const snapshot = JSON.parse(clientC.clientSocket.sentMessages[0] ?? "{}");
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.elements).toEqual([elA]);
    expect(snapshot.collaborators).toEqual([
      { client_id: "c-olga", nick: "Ольга" },
      { client_id: "c-max", nick: "Максим" },
    ]);
  });

  it("reconciles elements by version and versionNonce (lower versionNonce wins on tie), skips broadcast when all elements lose, and prunes 30-day deleted elements on flush", async () => {
    const harness = createBoardTestHarness(Board);
    const clientA = await connectClient(harness, VALID_BOARD_ID, "A");
    const clientPeer = await connectClient(harness, VALID_BOARD_ID, "Peer");
    const nowMs = 1_794_114_000_000;
    const fortyDaysAgo = nowMs - 40 * 24 * 60 * 60 * 1000;
    const fiveDaysAgo = nowMs - 5 * 24 * 60 * 60 * 1000;

    // Initial element v2, nonce 500
    await clientA.board.webSocketMessage(
      clientA.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [
          { id: "e1", version: 2, versionNonce: 500, text: "v2-500" },
          { id: "del-old", version: 1, versionNonce: 10, isDeleted: true, updated: fortyDaysAgo },
          { id: "del-recent", version: 1, versionNonce: 20, isDeleted: true, updated: fiveDaysAgo },
        ],
      }),
      nowMs,
    );
    expect(clientPeer.clientSocket.sentMessages.length).toBe(1);
    clientPeer.clientSocket.sentMessages.length = 0;

    // Lower version (v1) should be ignored AND not broadcast to peers
    await clientA.board.webSocketMessage(
      clientA.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [{ id: "e1", version: 1, versionNonce: 100, text: "v1-stale" }],
      }),
      nowMs,
    );
    expect(clientPeer.clientSocket.sentMessages.length).toBe(0);

    // Same version (v2) with HIGHER versionNonce (600 > 500) should be ignored AND not broadcast
    await clientA.board.webSocketMessage(
      clientA.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [{ id: "e1", version: 2, versionNonce: 600, text: "v2-600-lose" }],
      }),
      nowMs,
    );
    expect(clientPeer.clientSocket.sentMessages.length).toBe(0);

    // Same version (v2) with LOWER versionNonce (300 < 500) should WIN and be broadcast
    await clientA.board.webSocketMessage(
      clientA.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [{ id: "e1", version: 2, versionNonce: 300, text: "v2-300-win" }],
      }),
      nowMs,
    );
    expect(clientPeer.clientSocket.sentMessages.length).toBe(1);

    // Before flush, both soft-deleted elements are still in memory
    expect(clientA.board.getMetrics().elementsCount).toBe(3);

    // Flush snapshot -> prunes del-old (> 30 days), keeps del-recent (5 days) and winning e1
    clientA.board.flushSnapshot("manual", nowMs);

    const clientB = await connectClient(harness, VALID_BOARD_ID, "B");
    await clientB.board.webSocketMessage(
      clientB.serverSocket,
      JSON.stringify({ type: "hello", client_id: "c-b" }),
      nowMs,
    );
    const snap = JSON.parse(clientB.clientSocket.sentMessages[0] ?? "{}");
    expect(snap.elements).toEqual([
      { id: "e1", version: 2, versionNonce: 300, text: "v2-300-win" },
      { id: "del-recent", version: 1, versionNonce: 20, isDeleted: true, updated: fiveDaysAgo },
    ]);
  });

  it("persists chunked snapshots (<= 900 KB) to SQLite, writes only changed chunks (B.8), deletes extra chunks when shrinking, and survives DO recreation", async () => {
    const harness = createBoardTestHarness(Board, { SAVE_INTERVAL_MS: "1000" });
    const conn1 = await connectClient(harness, VALID_BOARD_ID, "Teacher");

    // Simulate hibernation wake-up BEFORE any snapshot flush has occurred:
    // boardId must be restored from WebSocketAttachment.boardId (not "unknown")
    const wokenBeforeFlush = await harness.recreateBoard(VALID_BOARD_ID);
    expect(wokenBeforeFlush.board.getMetrics().boardId).toBe(VALID_BOARD_ID);

    // Create a large scene (> 900 KB -> 2 chunks) on the woken instance
    const bigPayload = "X".repeat(MAX_SNAPSHOT_CHUNK_BYTES + 100_000);
    await wokenBeforeFlush.board.webSocketMessage(
      conn1.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [
          { id: "big-1", version: 1, versionNonce: 11, customData: bigPayload },
          { id: "small-2", version: 2, versionNonce: 22, text: "keep-me" },
        ],
      }),
    );

    // Trigger alarm to flush snapshot (2 chunks = 2 rows written, 0 meta writes)
    await wokenBeforeFlush.board.alarm();

    const boardStorage = harness.storages.get(VALID_BOARD_ID);
    if (!boardStorage) {
      throw new Error("Expected storage for board");
    }
    const sqlStorage = boardStorage.sql;
    expect(sqlStorage.snapshotTable.size).toBe(2);
    expect(sqlStorage.metaTable.size).toBe(0);
    expect(wokenBeforeFlush.board.getMetrics().lastFlushRowsWritten).toBe(2);

    // B.8: Modify ONLY the tail element `small-2` (which lives at the end of chunk 1, leaving chunk 0 untouched).
    // Flushing must write ONLY chunk 1 (`rowsWritten === 1`, not 2)!
    await wokenBeforeFlush.board.webSocketMessage(
      conn1.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [{ id: "small-2", version: 3, versionNonce: 19, text: "updated-tail-only" }],
      }),
    );
    await wokenBeforeFlush.board.alarm();
    expect(wokenBeforeFlush.board.getMetrics().lastFlushRowsWritten).toBe(1);

    // Simulate Durable Object eviction and recreation on the same SQLite storage
    const recreated = await harness.recreateBoard(VALID_BOARD_ID);
    expect(recreated.board.getMetrics().elementsCount).toBe(2);

    // Even after DO recreation, chunk digests are reconstructed on load: updating only `small-2` again writes 1 row!
    await recreated.board.webSocketMessage(
      conn1.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [{ id: "small-2", version: 4, versionNonce: 15, text: "updated-after-recreate" }],
      }),
    );
    await recreated.board.alarm();
    expect(recreated.board.getMetrics().lastFlushRowsWritten).toBe(1);

    // Now replace big-1 with a small payload so snapshot fits in 1 chunk; extra chunk 1 must be deleted (1 insert + 1 delete = 2 rowsWritten)
    await recreated.board.webSocketMessage(
      conn1.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [{ id: "big-1", version: 2, versionNonce: 5, customData: "compact" }],
      }),
    );
    await recreated.board.alarm();
    expect(sqlStorage.snapshotTable.size).toBe(1);
    expect(recreated.board.getMetrics().lastFlushRowsWritten).toBe(2);

    // Recreate again and verify a newly connected client gets the updated snapshot
    await harness.recreateBoard(VALID_BOARD_ID);
    const conn2 = await connectClient(harness, VALID_BOARD_ID, "Student");
    await conn2.board.webSocketMessage(
      conn2.serverSocket,
      JSON.stringify({ type: "hello", client_id: "student-1" }),
    );
    const snap = JSON.parse(conn2.clientSocket.sentMessages[0] ?? "{}");
    expect(snap.elements).toEqual([
      { id: "big-1", version: 2, versionNonce: 5, customData: "compact" },
      { id: "small-2", version: 4, versionNonce: 15, text: "updated-after-recreate" },
    ]);
  });

  it("does not mutate persistedChunkDigests or lastPersistedChunksCount when sql.exec throws mid-flush, writing all chunks on subsequent retry (T2.5c item 1)", async () => {
    const harness = createBoardTestHarness(Board, { SAVE_INTERVAL_MS: "1000" });
    const conn = await connectClient(harness, VALID_BOARD_ID, "Teacher");

    // Create a 2-chunk scene (> 900 KB)
    const bigPayload = "Y".repeat(MAX_SNAPSHOT_CHUNK_BYTES + 80_000);
    await conn.board.webSocketMessage(
      conn.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [
          { id: "tx-big-1", version: 1, versionNonce: 1, customData: bigPayload },
          { id: "tx-small-2", version: 1, versionNonce: 2, text: "tail" },
        ],
      }),
    );

    const boardStorage = harness.storages.get(VALID_BOARD_ID);
    if (!boardStorage) {
      throw new Error("Expected storage for board");
    }
    const origExec = boardStorage.sql.exec.bind(boardStorage.sql);

    // Inject a failure on the 2nd chunk write (chunk_idx === 1) so the transaction rolls back mid-flush
    let failOnChunkOne = true;
    boardStorage.sql.exec = ((query: string, ...bindings: unknown[]) => {
      if (
        failOnChunkOne &&
        query.toUpperCase().startsWith("INSERT OR REPLACE INTO SNAPSHOT") &&
        bindings[0] === 1
      ) {
        throw new Error("Simulated SQLite write failure on chunk 1");
      }
      return origExec(query, ...bindings);
    }) as typeof boardStorage.sql.exec;

    expect(() => conn.board.flushSnapshot("manual")).toThrow(
      /Simulated SQLite write failure on chunk 1/,
    );

    // Transaction rolled back: snapshotTable is still empty and dirty is still true
    expect(boardStorage.sql.snapshotTable.size).toBe(0);
    expect(conn.board.getMetrics().dirty).toBe(true);

    // Restore normal sql.exec and retry flushSnapshot -> must write BOTH chunks (rowsWritten === 2)
    failOnChunkOne = false;
    boardStorage.sql.exec = origExec;

    const retryStats = conn.board.flushSnapshot("manual");
    expect(retryStats).not.toBeNull();
    expect(retryStats?.rowsWritten).toBe(2);
    expect(boardStorage.sql.snapshotTable.size).toBe(2);
    expect(conn.board.getMetrics().dirty).toBe(false);
  });

  it("flushes immediately on any socket close or error if dirty (T2.5b section B.5)", async () => {
    const harness = createBoardTestHarness(Board, { SAVE_INTERVAL_MS: "5000" });
    const c1 = await connectClient(harness, VALID_BOARD_ID, "User1");
    const c2 = await connectClient(harness, VALID_BOARD_ID, "User2");

    await c1.board.webSocketMessage(
      c1.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [{ id: "el-close-test", version: 1, versionNonce: 99 }],
      }),
    );

    expect(c1.board.getMetrics().flushesCount).toBe(0);
    expect(c1.board.getMetrics().dirty).toBe(true);

    // B.5: Closing c1 while dirty immediately flushes to SQLite even if c2 is still open
    await c1.board.webSocketClose(c1.serverSocket, 1000, "tab-closed", true);
    expect(c1.board.getMetrics().flushesCount).toBe(1);
    expect(c1.board.getMetrics().dirty).toBe(false);
    expect(c1.state.storage.alarmTime).toBeNull();

    // Closing c2 when no longer dirty performs no extra flush
    await c2.board.webSocketClose(c2.serverSocket, 1000, "second-bye", true);
    expect(c2.board.getMetrics().flushesCount).toBe(1);
  });

  it("rejects scene_update with {type:'error', code:'board_too_large'} when element count or snapshot byte ceiling is exceeded (T2.5b section B.6)", async () => {
    const harness = createBoardTestHarness(Board, {
      MAX_BOARD_ELEMENTS: "3",
      MAX_SNAPSHOT_BYTES: "400",
    });
    const client = await connectClient(harness, VALID_BOARD_ID, "Teacher");

    // 1. Add 3 small elements -> succeeds
    await client.board.webSocketMessage(
      client.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [
          { id: "e1", version: 1, versionNonce: 1 },
          { id: "e2", version: 1, versionNonce: 2 },
          { id: "e3", version: 1, versionNonce: 3 },
        ],
      }),
    );
    expect(client.board.getMetrics().elementsCount).toBe(3);

    // 2. Attempt to add a 4th element -> exceeds MAX_BOARD_ELEMENTS (3) -> rejected with board_too_large
    client.clientSocket.sentMessages.length = 0;
    await client.board.webSocketMessage(
      client.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [{ id: "e4", version: 1, versionNonce: 4 }],
      }),
    );
    expect(client.board.getMetrics().elementsCount).toBe(3);
    expect(client.clientSocket.sentMessages.length).toBe(1);
    expect(JSON.parse(client.clientSocket.sentMessages[0] ?? "{}")).toEqual({
      type: "error",
      code: "board_too_large",
    });

    // 3. Attempt to update existing element `e1` with payload exceeding MAX_SNAPSHOT_BYTES (400) -> rejected with board_too_large
    client.clientSocket.sentMessages.length = 0;
    await client.board.webSocketMessage(
      client.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [{ id: "e1", version: 2, versionNonce: 5, text: "Z".repeat(500) }],
      }),
    );
    expect(client.clientSocket.sentMessages.length).toBe(1);
    expect(JSON.parse(client.clientSocket.sentMessages[0] ?? "{}")).toEqual({
      type: "error",
      code: "board_too_large",
    });
  });

  it("backs up corrupted snapshot to snapshot_backup and resumes normal saving when backup succeeds, or sends board_not_saved and blocks saving when backup fails (T2.5c item 2)", async () => {
    const harness = createBoardTestHarness(Board, { SAVE_INTERVAL_MS: "1000" });
    const conn = await connectClient(harness, VALID_BOARD_ID, "Teacher");

    await conn.board.webSocketMessage(
      conn.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [{ id: "valid-el", version: 1, versionNonce: 10 }],
      }),
    );
    await conn.board.alarm();

    const boardStorage = harness.storages.get(VALID_BOARD_ID);
    if (!boardStorage) {
      throw new Error("Expected storage for board");
    }

    // Subcase A: Corrupt chunk 0 in SQLite storage; backup to `snapshot_backup` succeeds
    const corruptedBytes = new TextEncoder().encode("{corrupted-json-payload");
    boardStorage.sql.snapshotTable.set(0, corruptedBytes);

    const recreated = await harness.recreateBoard(VALID_BOARD_ID);
    expect(recreated.board.getMetrics().snapshotCorrupted).toBe(true);
    expect(recreated.board.getMetrics().snapshotSaveBlocked).toBe(false);
    expect(boardStorage.sql.snapshotBackupTable.size).toBe(1);
    const backedUpChunk = boardStorage.sql.snapshotBackupTable.get(0);
    expect(new TextDecoder().decode(backedUpChunk?.data)).toBe("{corrupted-json-payload");

    // Because backup succeeded, the board starts empty and continues saving new edits normally
    await recreated.board.webSocketMessage(
      conn.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [{ id: "fresh-el-after-backup", version: 1, versionNonce: 20 }],
      }),
    );
    const flushResult = recreated.board.flushSnapshot("manual");
    expect(flushResult).not.toBeNull();
    expect(flushResult?.rowsWritten).toBe(1);
    // And snapshot_backup still holds the original corrupted data for owner recovery
    expect(new TextDecoder().decode(boardStorage.sql.snapshotBackupTable.get(0)?.data)).toBe(
      "{corrupted-json-payload",
    );

    // Subcase B: Corrupt chunk 0 again AND simulate `snapshot_backup` failure -> saving is blocked and `hello` sends `board_not_saved`
    const unbackedCorruptedBytes = new TextEncoder().encode("{second-corrupted-payload");
    boardStorage.sql.snapshotTable.set(0, unbackedCorruptedBytes);
    const origExec = boardStorage.sql.exec.bind(boardStorage.sql);
    boardStorage.sql.exec = ((query: string, ...bindings: unknown[]) => {
      if (query.toUpperCase().includes("SNAPSHOT_BACKUP")) {
        throw new Error("Simulated backup table failure");
      }
      return origExec(query, ...bindings);
    }) as typeof boardStorage.sql.exec;

    const recreatedFailedBackup = await harness.recreateBoard(VALID_BOARD_ID);
    expect(recreatedFailedBackup.board.getMetrics().snapshotCorrupted).toBe(true);
    expect(recreatedFailedBackup.board.getMetrics().snapshotSaveBlocked).toBe(true);

    // Connecting client sends hello -> receives snapshot followed by {"type":"error","code":"board_not_saved"}
    conn.clientSocket.sentMessages.length = 0;
    await recreatedFailedBackup.board.webSocketMessage(
      conn.serverSocket,
      JSON.stringify({ type: "hello", client_id: "c-after-fail", nick: "Teacher" }),
    );
    expect(conn.clientSocket.sentMessages.length).toBe(2);
    expect(JSON.parse(conn.clientSocket.sentMessages[0] ?? "{}").type).toBe("snapshot");
    expect(JSON.parse(conn.clientSocket.sentMessages[1] ?? "{}")).toEqual({
      type: "error",
      code: "board_not_saved",
    });

    // Attempting to flush while snapshotSaveBlocked === true returns null and does not overwrite `snapshot`
    await recreatedFailedBackup.board.webSocketMessage(
      conn.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [{ id: "unsaved-el", version: 1, versionNonce: 30 }],
      }),
    );
    expect(recreatedFailedBackup.board.flushSnapshot("manual")).toBeNull();
    expect(new TextDecoder().decode(boardStorage.sql.snapshotTable.get(0))).toBe(
      "{second-corrupted-payload",
    );
  });

  it("enforces limits: 2 MB message size, 20 max connections (code 1013), and 30 msg/s rate limit", async () => {
    const harness = createBoardTestHarness(Board);

    // 1. Open 20 connections -> all accepted
    const openConns = [];
    for (let i = 1; i <= 20; i++) {
      const conn = await connectClient(harness, VALID_BOARD_ID, `User${i}`);
      expect(conn.res.status).toBe(101);
      expect(conn.clientSocket.closeRecord).toBeNull();
      openConns.push(conn);
    }

    // 21st connection -> rejected and closed with code 1013
    const conn21 = await connectClient(harness, VALID_BOARD_ID, "User21");
    expect(conn21.clientSocket.closeRecord?.code).toBe(1013);

    // 2. Message > 2 MB is rejected and counted in messagesDropped without crashing
    const activeConn = openConns[0];
    if (!activeConn) {
      throw new Error("Expected active connection 0");
    }
    const oversizedMsg = JSON.stringify({
      type: "scene_update",
      elements: [
        { id: "huge", version: 1, versionNonce: 1, data: "A".repeat(2 * 1024 * 1024 + 500) },
      ],
    });
    await activeConn.board.webSocketMessage(activeConn.serverSocket, oversizedMsg, 10_000);
    expect(activeConn.board.getMetrics().messagesDropped).toBe(1);
    expect(activeConn.board.getMetrics().elementsCount).toBe(0);

    // 3. Rate limit: 30 messages/s allowed, excess dropped & counted, sustained excess closes socket (1008)
    const noisyConn = openConns[1];
    if (!noisyConn) {
      throw new Error("Expected active connection 1");
    }
    const baseTime = 50_000;
    for (let i = 1; i <= 40; i++) {
      await noisyConn.board.webSocketMessage(
        noisyConn.serverSocket,
        JSON.stringify({ type: "cursor", x: i, y: i }),
        baseTime + 10,
      );
    }
    // 30 accepted, 10 dropped, connection still open
    expect(noisyConn.board.getMetrics().messagesAccepted).toBe(30);
    expect(noisyConn.board.getMetrics().messagesDropped).toBe(1 + 10);
    expect(noisyConn.clientSocket.closeRecord).toBeNull();

    // Sustained flood (another 55 messages in the same window -> total 65 excess >= 60 threshold) closes connection
    for (let i = 41; i <= 95; i++) {
      await noisyConn.board.webSocketMessage(
        noisyConn.serverSocket,
        JSON.stringify({ type: "cursor", x: i, y: i }),
        baseTime + 20,
      );
    }
    expect(noisyConn.clientSocket.closeRecord?.code).toBe(1008);
  });

  it("batches 100 scene_update messages over 5 seconds with SAVE_INTERVAL_MS=1000 into <= 5 flushes writing 1 row per flush", async () => {
    const harness = createBoardTestHarness(Board, { SAVE_INTERVAL_MS: "1000" });
    const conn = await connectClient(harness, VALID_BOARD_ID, "DrawStress");

    const startTimeMs = 1_000_000;
    // 100 updates over 5000 ms = 1 update every 50 ms (20 msg/s, within the 30 msg/s limit)
    for (let i = 1; i <= 100; i++) {
      const nowMs = startTimeMs + (i - 1) * 50;

      // If a scheduled alarm is due at or before nowMs, fire it just like the Workers runtime
      const dueAlarm = await conn.state.storage.getAlarm();
      if (dueAlarm !== null && nowMs >= dueAlarm) {
        await conn.board.alarm();
        conn.state.storage.alarmTime = null;
      }

      await conn.board.webSocketMessage(
        conn.serverSocket,
        JSON.stringify({
          type: "scene_update",
          elements: [
            {
              id: "stroke-1",
              type: "freedraw",
              version: i,
              versionNonce: 1000 - i,
              updated: nowMs,
            },
          ],
        }),
        nowMs,
      );
    }

    // Fire the final pending alarm at t = startTimeMs + 5000
    const finalAlarm = await conn.state.storage.getAlarm();
    if (finalAlarm !== null) {
      await conn.board.alarm();
      conn.state.storage.alarmTime = null;
    }

    const metrics = conn.board.getMetrics();
    expect(metrics.messagesAccepted).toBe(100);
    expect(metrics.flushesCount).toBeLessThanOrEqual(5);
    expect(metrics.flushesCount).toBeGreaterThanOrEqual(1);
    // Every 1-chunk flush writes 1 row (snapshot[0]), so 5 flushes = 5 rows total
    expect(metrics.lastFlushRowsWritten).toBe(1);
    expect(metrics.totalRowsWritten).toBe(5);
  });
});
