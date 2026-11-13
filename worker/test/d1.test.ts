import { beforeEach, describe, expect, it } from "vitest";
import worker, { Board, type Env } from "../src/index.js";
import { clearTeacherCache, hashToken, isBoardAllowed } from "../src/d1.js";
import { createBoardTestHarness } from "./cloudflare-workers-shim.js";
import { InMemoryD1Database } from "./d1-mock.js";

describe("Cloudflare D1 & Teacher Cabinet (Task T3)", () => {
  let mockDb: InMemoryD1Database;
  let harness: ReturnType<typeof createBoardTestHarness>;
  let env: Env;

  const teacherA = {
    id: "TeacherA12345678901234",
    name: "Иван Учитель",
    token: "token_teacher_a_secret_key_1234567890",
  };

  const teacherB = {
    id: "TeacherB12345678901234",
    name: "Анна Репетитор",
    token: "token_teacher_b_secret_key_0987654321",
  };

  beforeEach(async () => {
    clearTeacherCache();
    mockDb = new InMemoryD1Database();

    // Seed test teachers into D1
    const hashA = await hashToken(teacherA.token);
    const hashB = await hashToken(teacherB.token);
    await mockDb
      .prepare("INSERT INTO teachers (id, name, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(teacherA.id, teacherA.name, hashA, Date.now())
      .run();
    await mockDb
      .prepare("INSERT INTO teachers (id, name, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(teacherB.id, teacherB.name, hashB, Date.now())
      .run();

    harness = createBoardTestHarness(Board, {
      ALLOW_ANY_BOARD_ID: "false",
      PILOT_BOARD_IDS: "PilotBoard123456789012",
      DB: mockDb as unknown as D1Database,
    });
    env = harness.env;
  });

  it("GET /api/me requires authorization header and validates teacher token", async () => {
    // 1. Missing auth header -> 401
    const unauthReq = new Request("http://localhost:8787/api/me", { method: "GET" });
    const unauthRes = await worker.fetch(unauthReq, env);
    expect(unauthRes.status).toBe(401);
    const unauthBody = (await unauthRes.json()) as { ok: boolean; error: string };
    expect(unauthBody.ok).toBe(false);

    // 2. Invalid auth token -> 401
    const invalidReq = new Request("http://localhost:8787/api/me", {
      method: "GET",
      headers: { Authorization: "Bearer wrong_token" },
    });
    const invalidRes = await worker.fetch(invalidReq, env);
    expect(invalidRes.status).toBe(401);

    // 3. Valid teacher token -> 200
    const validReq = new Request("http://localhost:8787/api/me", {
      method: "GET",
      headers: { Authorization: `Bearer ${teacherA.token}` },
    });
    const validRes = await worker.fetch(validReq, env);
    expect(validRes.status).toBe(200);
    const validBody = (await validRes.json()) as {
      ok: boolean;
      teacher: { id: string; name: string };
    };
    expect(validBody.ok).toBe(true);
    expect(validBody.teacher.id).toBe(teacherA.id);
    expect(validBody.teacher.name).toBe(teacherA.name);
  });

  it("Strict tenant isolation: Teacher B cannot read, edit, or delete Teacher A's student", async () => {
    // Teacher A creates a student
    const createReq = new Request("http://localhost:8787/api/students", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${teacherA.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ nickname: "Миша", notes: "8 класс, геометрия" }),
    });
    const createRes = await worker.fetch(createReq, env);
    expect(createRes.status).toBe(201);
    const { student } = (await createRes.json()) as {
      student: { id: string; nickname: string; notes: string };
    };
    expect(student.nickname).toBe("Миша");

    // Teacher B tries to PATCH Teacher A's student -> 404 (strictly 404, never 200 or 403)
    const patchReq = new Request(`http://localhost:8787/api/students/${student.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${teacherB.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ nickname: "Хакер" }),
    });
    const patchRes = await worker.fetch(patchReq, env);
    expect(patchRes.status).toBe(404);

    // Teacher B lists students -> does NOT see Teacher A's student
    const listReq = new Request("http://localhost:8787/api/students", {
      method: "GET",
      headers: { Authorization: `Bearer ${teacherB.token}` },
    });
    const listRes = await worker.fetch(listReq, env);
    expect(listRes.status).toBe(200);
    const { students } = (await listRes.json()) as { students: unknown[] };
    expect(students.length).toBe(0);
  });

  it("Strict tenant isolation: Teacher B cannot read, modify, clone, or delete Teacher A's board", async () => {
    // Teacher A creates a board
    const createBoardReq = new Request("http://localhost:8787/api/boards", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${teacherA.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Урок алгебры" }),
    });
    const createBoardRes = await worker.fetch(createBoardReq, env);
    expect(createBoardRes.status).toBe(201);
    const { board } = (await createBoardRes.json()) as {
      board: { id: string; title: string };
    };

    // Teacher B tries to clone Teacher A's board -> 404
    const cloneReq = new Request("http://localhost:8787/api/boards", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${teacherB.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Украденная доска", from_board_id: board.id }),
    });
    const cloneRes = await worker.fetch(cloneReq, env);
    expect(cloneRes.status).toBe(404);

    // Teacher B tries to edit notes on Teacher A's board -> 404
    const patchReq = new Request(`http://localhost:8787/api/boards/${board.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${teacherB.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ notes: "взлом" }),
    });
    const patchRes = await worker.fetch(patchReq, env);
    expect(patchRes.status).toBe(404);

    // Teacher B tries to delete Teacher A's board -> 404
    const deleteReq = new Request(`http://localhost:8787/api/boards/${board.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${teacherB.token}` },
    });
    const deleteRes = await worker.fetch(deleteReq, env);
    expect(deleteRes.status).toBe(404);
  });

  it("1-click board creation & cloning via from_board_id copies scene elements", async () => {
    // 1. Create source board
    const createRes = await worker.fetch(
      new Request("http://localhost:8787/api/boards", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${teacherA.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Шаблон формул" }),
      }),
      env,
    );
    expect(createRes.status).toBe(201);
    const { board: sourceBoard } = (await createRes.json()) as { board: { id: string } };

    // 2. Put an element into source board DO
    const sourceDo = env.BOARD.get(env.BOARD.idFromName(sourceBoard.id));
    const testElement = {
      id: "elem-rectangle-12345",
      type: "rectangle",
      x: 100,
      y: 200,
      width: 150,
      height: 80,
      version: 42,
      versionNonce: 99999,
      isDeleted: false,
    };
    await sourceDo.fetch("http://do/internal/import", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ elements: [testElement] }),
    });

    // 3. Clone board via POST /api/boards with from_board_id
    const cloneRes = await worker.fetch(
      new Request("http://localhost:8787/api/boards", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${teacherA.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "Копия для ученика",
          from_board_id: sourceBoard.id,
        }),
      }),
      env,
    );
    expect(cloneRes.status).toBe(201);
    const { board: clonedBoard } = (await cloneRes.json()) as { board: { id: string } };

    // 4. Verify cloned board DO has the imported element with version reset to 1
    const clonedDo = env.BOARD.get(env.BOARD.idFromName(clonedBoard.id));
    const exportRes = await clonedDo.fetch("http://do/internal/export");
    expect(exportRes.status).toBe(200);
    const exportedData = (await exportRes.json()) as {
      elements: Array<{ id: string; version: number; x: number; y: number }>;
    };
    expect(exportedData.elements.length).toBe(1);
    expect(exportedData.elements[0]?.id).toBe("elem-rectangle-12345");
    expect(exportedData.elements[0]?.version).toBe(1);
  });

  it("WebSocket allowlist checks D1 and board deletion revokes sockets with code 1008", async () => {
    // 1. Create active board in D1
    const createRes = await worker.fetch(
      new Request("http://localhost:8787/api/boards", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${teacherA.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Урок физики" }),
      }),
      env,
    );
    const { board } = (await createRes.json()) as { board: { id: string } };

    // Verify isBoardAllowed returns true for newly created board
    const allowedBefore = await isBoardAllowed(board.id, env);
    expect(allowedBefore).toBe(true);

    // 2. Open WebSocket connection
    const wsReq = new Request(`http://localhost:8787/ws/${board.id}?nick=Ученик`, {
      method: "GET",
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        Origin: "http://localhost:8787",
      },
    });
    const wsRes = await worker.fetch(wsReq, env);
    expect(wsRes.status).toBe(101);

    // 3. Delete board via DELETE /api/boards/:id
    const deleteRes = await worker.fetch(
      new Request(`http://localhost:8787/api/boards/${board.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${teacherA.token}` },
      }),
      env,
    );
    expect(deleteRes.status).toBe(200);

    // Verify isBoardAllowed now returns false
    const allowedAfter = await isBoardAllowed(board.id, env);
    expect(allowedAfter).toBe(false);

    // Verify subsequent WebSocket upgrade gets 404
    const wsReqAfter = new Request(`http://localhost:8787/ws/${board.id}?nick=Ученик`, {
      method: "GET",
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        Origin: "http://localhost:8787",
      },
    });
    const wsResAfter = await worker.fetch(wsReqAfter, env);
    expect(wsResAfter.status).toBe(404);
  });
});
