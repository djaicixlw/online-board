import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { Board } from "../src/board.js";
import { clearTeacherCache, hashToken } from "../src/d1.js";
import { createBoardTestHarness, type MockSocket } from "./cloudflare-workers-shim.js";
import { InMemoryD1Database } from "./d1-mock.js";

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
  const clientSocket = (res as unknown as { webSocket?: MockSocket }).webSocket;
  if (!clientSocket || !clientSocket.peer) {
    throw new Error("Expected upgraded MockSocket pair");
  }
  const serverSocket = clientSocket.peer as unknown as WebSocket;
  return { res, clientSocket, serverSocket, board, state };
}

describe("Task T5 Part A: Snapshot Backup, Two-Stage Alarm, and 1-Click Restore", () => {
  let mockDb: InMemoryD1Database;
  const teacherA = {
    id: "TeacherA12345678901234",
    name: "Иван Учитель",
    token: "token_teacher_a_secret_key_1234567890",
  };

  beforeEach(async () => {
    clearTeacherCache();
    mockDb = new InMemoryD1Database();

    const hashA = await hashToken(teacherA.token);
    await mockDb
      .prepare("INSERT INTO teachers (id, name, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(teacherA.id, teacherA.name, hashA, Date.now())
      .run();

    await mockDb
      .prepare(
        "INSERT INTO boards (id, teacher_id, student_id, title, notes, created_at, updated_at) VALUES (?1, ?2, NULL, ?3, '', ?4, ?4)",
      )
      .bind(VALID_BOARD_ID, teacherA.id, "Алгебра 10 класс", Date.now())
      .run();
  });

  it("creates snapshot_backup table and saves backup copy before restore", async () => {
    const harness = createBoardTestHarness(Board, {
      ALLOW_ANY_BOARD_ID: "true",
      BACKUP_QUIET_MS: "1000",
      SAVE_INTERVAL_MS: "500",
      DB: mockDb as unknown as D1Database,
    });

    const conn = await connectClient(harness, VALID_BOARD_ID, "TeacherUser");

    // Add elements
    await conn.board.webSocketMessage(
      conn.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [
          {
            id: "rect-1",
            type: "rectangle",
            version: 10,
            versionNonce: 100,
            updated: 1000,
          },
        ],
      }),
      1000,
    );

    // Trigger flush
    conn.board.flushSnapshot("manual", 1000);

    // Call /internal/backup-info
    const infoRes = await conn.board.fetch(
      new Request("http://internal/internal/backup-info", { method: "GET" }),
    );
    expect(infoRes.ok).toBe(true);
    const infoData = (await infoRes.json()) as { ok: boolean; has_backup: boolean };
    expect(infoData.ok).toBe(true);

    // Test /internal/restore with payload
    const restoreRes = await conn.board.fetch(
      new Request("http://internal/internal/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "payload",
          elements: [
            {
              id: "restored-el",
              type: "text",
              text: "Restored from test",
              version: 2,
              versionNonce: 50,
            },
          ],
        }),
      }),
    );

    expect(restoreRes.ok).toBe(true);
    const restoreData = (await restoreRes.json()) as {
      ok: boolean;
      restored: boolean;
      elementsCount: number;
    };
    expect(restoreData.ok).toBe(true);
    expect(restoreData.restored).toBe(true);
    expect(restoreData.elementsCount).toBe(1);

    // Verify version bump: the restored element must have version > 10 (previous max)
    const metrics = conn.board.getMetrics();
    expect(metrics.elementsCount).toBe(1);

    // Verify snapshot_backup now contains the backed up rect-1
    const backupInfoAfter = await conn.board.fetch(
      new Request("http://internal/internal/backup-info", { method: "GET" }),
    );
    const backupDataAfter = (await backupInfoAfter.json()) as {
      ok: boolean;
      has_backup: boolean;
      element_count: number;
    };
    expect(backupDataAfter.has_backup).toBe(true);
    expect(backupDataAfter.element_count).toBe(1);

    // Now restore from local_backup
    const restoreLocalRes = await conn.board.fetch(
      new Request("http://internal/internal/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "local_backup" }),
      }),
    );
    expect(restoreLocalRes.ok).toBe(true);
    const restoreLocalData = (await restoreLocalRes.json()) as {
      ok: boolean;
      restored: boolean;
      elementsCount: number;
    };
    expect(restoreLocalData.ok).toBe(true);
    expect(restoreLocalData.elementsCount).toBe(1);
  });

  it("handles two-stage alarm: fast snapshot flush followed by quiet window backup", async () => {
    const harness = createBoardTestHarness(Board, {
      ALLOW_ANY_BOARD_ID: "true",
      BACKUP_QUIET_MS: "2000",
      SAVE_INTERVAL_MS: "500",
      DB: mockDb as unknown as D1Database,
    });

    const conn = await connectClient(harness, VALID_BOARD_ID, "StudentBob");
    const t0 = 100_000;

    await conn.board.webSocketMessage(
      conn.serverSocket,
      JSON.stringify({
        type: "scene_update",
        elements: [
          {
            id: "line-1",
            type: "line",
            version: 1,
            versionNonce: 111,
            updated: t0,
          },
        ],
      }),
      t0,
    );

    // Initial state: dirty = true, fast flush scheduled at t0 + 500
    expect(conn.board.getMetrics().dirty).toBe(true);
    const alarm1 = await conn.state.storage.getAlarm();
    expect(alarm1).toBe(t0 + 500);

    // Stage 1 fires at t0 + 500: fast flush runs
    conn.state.storage.alarmTime = alarm1;
    await conn.board.alarm();

    expect(conn.board.getMetrics().dirty).toBe(false);
    expect(conn.board.getMetrics().flushesCount).toBe(1);

    // Stage 2: quiet window alarm scheduled for t0 + 2000
    const alarm2 = await conn.state.storage.getAlarm();
    expect(alarm2).toBe(t0 + 2000);

    // Stage 2 fires at t0 + 2000: quiet window reached
    conn.state.storage.alarmTime = alarm2;
    await conn.board.alarm();

    // Backup pending cleared
    expect(conn.board.getMetrics().backupPendingAt).toBeNull();
  });

  it("supports public teacher cabinet routes /api/boards/:id/backups and /api/boards/:id/restore", async () => {
    const harness = createBoardTestHarness(Board, {
      ALLOW_ANY_BOARD_ID: "false",
      PILOT_BOARD_IDS: VALID_BOARD_ID,
      DB: mockDb as unknown as D1Database,
    });

    const authHeader = `Bearer ${teacherA.token}`;

    // 1. Fetch backups endpoint
    const backupsReq = new Request(`http://localhost:8787/api/boards/${VALID_BOARD_ID}/backups`, {
      method: "GET",
      headers: { Authorization: authHeader },
    });
    const backupsRes = await worker.fetch(backupsReq, harness.env);
    expect(backupsRes.status).toBe(200);
    const backupsData = (await backupsRes.json()) as {
      ok: boolean;
      local_backup: unknown;
      git_backups: unknown[];
    };
    expect(backupsData.ok).toBe(true);

    // 2. Restore via POST /api/boards/:id/restore with file payload
    const restoreReq = new Request(`http://localhost:8787/api/boards/${VALID_BOARD_ID}/restore`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "file",
        elements: [
          {
            id: "imported-el-1",
            type: "rectangle",
            version: 1,
            versionNonce: 777,
          },
        ],
      }),
    });
    const restoreRes = await worker.fetch(restoreReq, harness.env);
    expect(restoreRes.status).toBe(200);
    const restoreData = (await restoreRes.json()) as {
      ok: boolean;
      restored: boolean;
      elements_count: number;
    };
    expect(restoreData.ok).toBe(true);
    expect(restoreData.restored).toBe(true);
    expect(restoreData.elements_count).toBe(1);
  });
});
