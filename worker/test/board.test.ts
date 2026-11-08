import { describe, expect, it } from "vitest";
import worker, { Board, MAX_SNAPSHOT_CHUNK_BYTES } from "../src/index.js";
import { createBoardTestHarness, type MockSocket } from "./cloudflare-workers-shim.js";

const VALID_BOARD_ID = "AbCdEfGhIjKlMnOpQrSt12"; // 22 base62 chars

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
  const clientSocket = (res as unknown as { webSocket?: MockSocket }).webSocket!;
  const serverSocket = clientSocket?.peer as unknown as WebSocket;
  return { res, clientSocket, serverSocket, board, state };
}

describe("Task T1: Board Room Durable Object and WebSocket Collaboration", () => {
  it("validates GET /ws/:id?nick=<ник> (22-char base62 id, 1..32 char nick, ALLOW_ANY_BOARD_ID)", async () => {
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
      new Request(`http://localhost:8787/ws/${VALID_BOARD_ID}?nick=${encodeURIComponent(longNick)}`, {
        headers: { Upgrade: "websocket" },
      }),
      harness.env,
    );
    expect(longNickRes.status).toBe(400);

    // ALLOW_ANY_BOARD_ID=false returns 404
    const prodHarness = createBoardTestHarness(Board, { ALLOW_ANY_BOARD_ID: "false" });
    const notFoundRes = await worker.fetch(
      new Request(`http://localhost:8787/ws/${VALID_BOARD_ID}?nick=Alice`, {
        headers: { Upgrade: "websocket" },
      }),
      prodHarness.env,
    );
    expect(notFoundRes.status).toBe(404);

    // Valid id and nick with surrounding spaces and control char get trimmed/cleaned and accepted (101)
    const okConn = await connectClient(harness, VALID_BOARD_ID, "  \u0007Анна\n  ");
    expect(okConn.res.status).toBe(101);
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

    const receivedByB = JSON.parse(clientB.clientSocket.sentMessages[0]!);
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
    const cursorByB = JSON.parse(clientB.clientSocket.sentMessages[0]!);
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
    const snapshot = JSON.parse(clientC.clientSocket.sentMessages[0]!);
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
    const snap = JSON.parse(clientB.clientSocket.sentMessages[0]!);
    expect(snap.elements).toEqual([
      { id: "e1", version: 2, versionNonce: 300, text: "v2-300-win" },
      { id: "del-recent", version: 1, versionNonce: 20, isDeleted: true, updated: fiveDaysAgo },
    ]);
  });

  it("persists chunked snapshots (<= 900 KB) to SQLite, deletes only extra old chunks, and survives DO recreation (including hibernation before first flush)", async () => {
    const harness = createBoardTestHarness(Board, { SAVE_INTERVAL_MS: "1000" });
    const conn1 = await connectClient(harness, VALID_BOARD_ID, "Teacher");

    // Simulate hibernation wake-up BEFORE any snapshot flush has occurred:
    // boardId must be restored from WebSocketAttachment.boardId (not "unknown")
    const wokenBeforeFlush = await harness.recreateBoard(VALID_BOARD_ID);

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

    // Trigger alarm to flush snapshot
    await wokenBeforeFlush.board.alarm();

    const sqlStorage = harness.storages.get(VALID_BOARD_ID)!.sql;
    expect(sqlStorage.snapshotTable.size).toBe(2);
    expect(sqlStorage.metaTable.get("board_id")).toBe(VALID_BOARD_ID);

    // Simulate Durable Object eviction and recreation on the same SQLite storage
    const recreated = await harness.recreateBoard(VALID_BOARD_ID);
    expect(recreated.board.getMetrics().elementsCount).toBe(2);

    // Now replace big-1 with a small payload so snapshot fits in 1 chunk; extra chunk 1 must be deleted
    await recreated.board.webSocketMessage(
      conn1.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [{ id: "big-1", version: 2, versionNonce: 5, customData: "compact" }],
      }),
    );
    await recreated.board.alarm();
    expect(sqlStorage.snapshotTable.size).toBe(1);

    // Recreate again and verify a newly connected client gets the updated snapshot
    await harness.recreateBoard(VALID_BOARD_ID);
    const conn2 = await connectClient(harness, VALID_BOARD_ID, "Student");
    await conn2.board.webSocketMessage(
      conn2.serverSocket,
      JSON.stringify({ type: "hello", client_id: "student-1" }),
    );
    const snap = JSON.parse(conn2.clientSocket.sentMessages[0]!);
    expect(snap.elements).toEqual([
      { id: "big-1", version: 2, versionNonce: 5, customData: "compact" },
      { id: "small-2", version: 2, versionNonce: 22, text: "keep-me" },
    ]);
  });

  it("flushes immediately when the last connection closes", async () => {
    const harness = createBoardTestHarness(Board, { SAVE_INTERVAL_MS: "10000" });
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

    // Closing first connection while second is still open does NOT flush yet
    await c1.board.webSocketClose(c1.serverSocket, 1000, "bye", true);
    expect(c1.board.getMetrics().flushesCount).toBe(0);
    expect(c1.board.getMetrics().dirty).toBe(true);

    // Closing the last connection flushes immediately to SQLite and clears alarm
    await c2.board.webSocketClose(c2.serverSocket, 1000, "last-bye", true);
    expect(c2.board.getMetrics().flushesCount).toBe(1);
    expect(c2.board.getMetrics().dirty).toBe(false);
    expect(c2.state.storage.alarmTime).toBeNull();
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
    const activeConn = openConns[0]!;
    const oversizedMsg = JSON.stringify({
      type: "scene_update",
      elements: [{ id: "huge", version: 1, versionNonce: 1, data: "A".repeat(2 * 1024 * 1024 + 500) }],
    });
    await activeConn.board.webSocketMessage(activeConn.serverSocket, oversizedMsg, 10_000);
    expect(activeConn.board.getMetrics().messagesDropped).toBe(1);
    expect(activeConn.board.getMetrics().elementsCount).toBe(0);

    // 3. Rate limit: 30 messages/s allowed, excess dropped & counted, sustained excess closes socket (1008)
    const noisyConn = openConns[1]!;
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

  it("batches 100 scene_update messages over 5 seconds with SAVE_INTERVAL_MS=1000 into <= 5 flushes", async () => {
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
    // First flush writes 3 rows (meta.board_id, meta.snapshot_version, snapshot[0]), subsequent 4 flushes write 2 rows each = 11 rows total
    expect(metrics.lastFlushRowsWritten).toBe(2);
    expect(metrics.totalRowsWritten).toBe(11);
  });
});
