import pkg from "../package.json";
import { Board, isValidBoardId, sanitizeNickname } from "./board.js";
import { authenticateTeacher, evictBoardCache, generateId, isBoardAllowed } from "./d1.js";
import type { Env } from "./env.js";

export { Board };
export type { Env };

export interface HealthResponse {
  ok: true;
  version: string;
}

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'";

/**
 * Appends standard security headers to non-101 responses.
 * Leaves 101 (WebSocket switching protocols) responses completely untouched
 * to avoid breaking Cloudflare WebSocket handshakes.
 */
export function addSecurityHeaders(response: Response, isApi = false): Response {
  if (response.status === 101) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set("X-Robots-Tag", "noindex, nofollow");

  if (!headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", DEFAULT_CSP);
  }

  if (isApi || response.status >= 400) {
    headers.set("Cache-Control", "no-store");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Builds the JSON response for GET /api/health.
 */
export function createHealthResponse(): Response {
  const body: HealthResponse = {
    ok: true,
    version: pkg.version,
  };
  return Response.json(body, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Handles WebSocket upgrade requests on GET /ws/:id?nick=<nickname>.
 */
async function handleWebSocketUpgrade(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") {
    return addSecurityHeaders(
      Response.json(
        { ok: false, error: "Invalid method: expected GET for WebSocket upgrade" },
        { status: 400 },
      ),
      true,
    );
  }

  const upgradeHeader = request.headers.get("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return addSecurityHeaders(
      Response.json(
        { ok: false, error: "Missing or invalid Upgrade: websocket header" },
        { status: 400 },
      ),
      true,
    );
  }

  // Cross-origin WebSocket protection: verify Origin header if present
  const origin = request.headers.get("Origin");
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const originHost = originUrl.host;
      const requestHost = url.host;
      const isLocalhost =
        originHost.startsWith("localhost") ||
        originHost.startsWith("127.0.0.1") ||
        requestHost.startsWith("localhost") ||
        requestHost.startsWith("127.0.0.1");

      if (!isLocalhost && originHost !== requestHost) {
        return addSecurityHeaders(
          Response.json(
            { ok: false, error: "Cross-origin WebSocket connection forbidden" },
            { status: 403 },
          ),
          true,
        );
      }
    } catch {
      return addSecurityHeaders(
        Response.json({ ok: false, error: "Invalid Origin header" }, { status: 403 }),
        true,
      );
    }
  }

  const match = /^\/ws\/([^/]+)$/.exec(url.pathname);
  const boardId = match?.[1] ?? "";

  // Unified 404 for invalid OR unwhitelisted board IDs to prevent enumeration
  const allowed = await isBoardAllowed(boardId, env);
  if (!isValidBoardId(boardId) || !allowed) {
    return addSecurityHeaders(
      Response.json({ ok: false, error: "Board not found" }, { status: 404 }),
      true,
    );
  }

  const nick = sanitizeNickname(url.searchParams.get("nick"));
  if (!nick) {
    return addSecurityHeaders(
      Response.json(
        {
          ok: false,
          error:
            "Invalid nick: must be 1..32 characters after trimming and stripping control characters",
        },
        { status: 400 },
      ),
      true,
    );
  }

  const doId = env.BOARD.idFromName(boardId);
  const stub = env.BOARD.get(doId);

  const forwardUrl = new URL(request.url);
  forwardUrl.searchParams.set("nick", nick);

  const doResponse = await stub.fetch(
    new Request(forwardUrl.toString(), {
      method: "GET",
      headers: request.headers,
    }),
  );

  return addSecurityHeaders(doResponse, true);
}

async function handleApiRequest(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/api/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return addSecurityHeaders(
        Response.json(
          { ok: false, error: "Method Not Allowed" },
          { status: 405, headers: { Allow: "GET, HEAD" } },
        ),
        true,
      );
    }
    return addSecurityHeaders(createHealthResponse(), true);
  }

  const isKnownCabinetEndpoint =
    url.pathname === "/api/me" ||
    url.pathname === "/api/students" ||
    url.pathname.startsWith("/api/students/") ||
    url.pathname === "/api/boards" ||
    url.pathname.startsWith("/api/boards/");

  if (!isKnownCabinetEndpoint) {
    return addSecurityHeaders(
      Response.json({ ok: false, error: "Not Found" }, { status: 404 }),
      true,
    );
  }

  // All cabinet API endpoints require D1 database binding
  if (!env.DB) {
    return addSecurityHeaders(
      Response.json({ ok: false, error: "D1 database not configured" }, { status: 500 }),
      true,
    );
  }

  // Authenticate teacher
  const teacher = await authenticateTeacher(request, env);
  if (!teacher) {
    return addSecurityHeaders(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
      true,
    );
  }

  // GET /api/me
  if (url.pathname === "/api/me") {
    if (request.method !== "GET") {
      return addSecurityHeaders(
        Response.json({ ok: false, error: "Method Not Allowed" }, { status: 405 }),
        true,
      );
    }
    return addSecurityHeaders(
      Response.json({ ok: true, teacher: { id: teacher.id, name: teacher.name } }),
      true,
    );
  }

  // /api/students
  if (url.pathname === "/api/students") {
    if (request.method === "GET") {
      const includeArchived = url.searchParams.get("include_archived") === "1";
      const query = includeArchived
        ? "SELECT id, teacher_id, nickname, notes, archived, created_at FROM students WHERE teacher_id = ?1 ORDER BY archived ASC, nickname ASC"
        : "SELECT id, teacher_id, nickname, notes, archived, created_at FROM students WHERE teacher_id = ?1 AND archived = 0 ORDER BY nickname ASC";

      const rows = await env.DB.prepare(query).bind(teacher.id).all();
      return addSecurityHeaders(Response.json({ ok: true, students: rows.results }), true);
    }

    if (request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return addSecurityHeaders(
          Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 }),
          true,
        );
      }

      const rawNick =
        typeof (body as Record<string, unknown>)?.nickname === "string"
          ? ((body as Record<string, unknown>).nickname as string)
          : "";
      const nick = sanitizeNickname(rawNick);
      if (!nick || nick.length > 32) {
        return addSecurityHeaders(
          Response.json(
            { ok: false, error: "Invalid nickname: must be 1..32 characters" },
            { status: 400 },
          ),
          true,
        );
      }

      const rawNotes =
        typeof (body as Record<string, unknown>)?.notes === "string"
          ? ((body as Record<string, unknown>).notes as string)
          : "";
      const notes = rawNotes.slice(0, 2000);
      const id = generateId(22);
      const createdAt = Date.now();

      await env.DB.prepare(
        "INSERT INTO students (id, teacher_id, nickname, notes, archived, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5)",
      )
        .bind(id, teacher.id, nick, notes, createdAt)
        .run();

      return addSecurityHeaders(
        Response.json(
          {
            ok: true,
            student: {
              id,
              teacher_id: teacher.id,
              nickname: nick,
              notes,
              archived: 0,
              created_at: createdAt,
            },
          },
          { status: 201 },
        ),
        true,
      );
    }

    return addSecurityHeaders(
      Response.json({ ok: false, error: "Method Not Allowed" }, { status: 405 }),
      true,
    );
  }

  // PATCH /api/students/:id
  const studentMatch = /^\/api\/students\/([^/]+)$/.exec(url.pathname);
  if (studentMatch) {
    if (request.method !== "PATCH") {
      return addSecurityHeaders(
        Response.json({ ok: false, error: "Method Not Allowed" }, { status: 405 }),
        true,
      );
    }
    const studentId = studentMatch[1];
    if (!isValidBoardId(studentId)) {
      return addSecurityHeaders(
        Response.json({ ok: false, error: "Student not found" }, { status: 404 }),
        true,
      );
    }

    const existing = await env.DB.prepare(
      "SELECT id, nickname, notes, archived, created_at FROM students WHERE id = ?1 AND teacher_id = ?2",
    )
      .bind(studentId, teacher.id)
      .first<{
        id: string;
        nickname: string;
        notes: string;
        archived: number;
        created_at: number;
      }>();

    if (!existing) {
      return addSecurityHeaders(
        Response.json({ ok: false, error: "Student not found" }, { status: 404 }),
        true,
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return addSecurityHeaders(
        Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 }),
        true,
      );
    }

    const payload = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    let newNick = existing.nickname;
    if (typeof payload.nickname === "string") {
      const sanitized = sanitizeNickname(payload.nickname);
      if (!sanitized || sanitized.length > 32) {
        return addSecurityHeaders(
          Response.json({ ok: false, error: "Invalid nickname" }, { status: 400 }),
          true,
        );
      }
      newNick = sanitized;
    }

    let newNotes = existing.notes;
    if (typeof payload.notes === "string") {
      newNotes = payload.notes.slice(0, 2000);
    }

    let newArchived = existing.archived;
    if (typeof payload.archived === "boolean" || typeof payload.archived === "number") {
      newArchived = payload.archived ? 1 : 0;
    }

    await env.DB.prepare(
      "UPDATE students SET nickname = ?1, notes = ?2, archived = ?3 WHERE id = ?4 AND teacher_id = ?5",
    )
      .bind(newNick, newNotes, newArchived, studentId, teacher.id)
      .run();

    return addSecurityHeaders(
      Response.json({
        ok: true,
        student: {
          id: studentId,
          teacher_id: teacher.id,
          nickname: newNick,
          notes: newNotes,
          archived: newArchived,
          created_at: existing.created_at,
        },
      }),
      true,
    );
  }

  // /api/boards
  if (url.pathname === "/api/boards") {
    if (request.method === "GET") {
      const studentId = url.searchParams.get("student_id");
      if (studentId) {
        const rows = await env.DB.prepare(
          "SELECT id, teacher_id, student_id, title, notes, created_at, updated_at FROM boards WHERE teacher_id = ?1 AND student_id = ?2 AND deleted_at IS NULL ORDER BY updated_at DESC",
        )
          .bind(teacher.id, studentId)
          .all();
        return addSecurityHeaders(Response.json({ ok: true, boards: rows.results }), true);
      }

      const rows = await env.DB.prepare(
        "SELECT id, teacher_id, student_id, title, notes, created_at, updated_at FROM boards WHERE teacher_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC",
      )
        .bind(teacher.id)
        .all();
      return addSecurityHeaders(Response.json({ ok: true, boards: rows.results }), true);
    }

    if (request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return addSecurityHeaders(
          Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 }),
          true,
        );
      }

      const payload = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
      const rawTitle = typeof payload.title === "string" ? payload.title.trim() : "";
      const title = (rawTitle || "Новая доска").slice(0, 100);

      const studentId =
        typeof payload.student_id === "string" && isValidBoardId(payload.student_id)
          ? payload.student_id
          : null;

      if (studentId) {
        const student = await env.DB.prepare(
          "SELECT id FROM students WHERE id = ?1 AND teacher_id = ?2 LIMIT 1",
        )
          .bind(studentId, teacher.id)
          .first();
        if (!student) {
          return addSecurityHeaders(
            Response.json({ ok: false, error: "Student not found" }, { status: 404 }),
            true,
          );
        }
      }

      const fromBoardId =
        typeof payload.from_board_id === "string" && isValidBoardId(payload.from_board_id)
          ? payload.from_board_id
          : null;

      let snapshotElements: unknown[] | null = null;
      if (fromBoardId) {
        const sourceBoard = await env.DB.prepare(
          "SELECT id FROM boards WHERE id = ?1 AND teacher_id = ?2 AND deleted_at IS NULL LIMIT 1",
        )
          .bind(fromBoardId, teacher.id)
          .first();
        if (!sourceBoard) {
          return addSecurityHeaders(
            Response.json({ ok: false, error: "Source board not found" }, { status: 404 }),
            true,
          );
        }

        // Export state from source DO
        const sourceStub = env.BOARD.get(env.BOARD.idFromName(fromBoardId));
        const exportRes = await sourceStub.fetch("http://do/internal/export");
        if (exportRes.ok) {
          const exportData = (await exportRes.json()) as { elements?: unknown[] };
          if (Array.isArray(exportData.elements)) {
            snapshotElements = exportData.elements;
          }
        }
      }

      const boardId = generateId(22);
      const now = Date.now();

      // If cloning, import elements into target DO
      if (snapshotElements) {
        const targetStub = env.BOARD.get(env.BOARD.idFromName(boardId));
        await targetStub.fetch("http://do/internal/import", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ elements: snapshotElements }),
        });
      }

      await env.DB.prepare(
        "INSERT INTO boards (id, teacher_id, student_id, title, notes, deleted_at, created_at, updated_at, last_backup_at) VALUES (?1, ?2, ?3, ?4, '', NULL, ?5, ?5, NULL)",
      )
        .bind(boardId, teacher.id, studentId, title, now)
        .run();

      return addSecurityHeaders(
        Response.json(
          {
            ok: true,
            board: {
              id: boardId,
              teacher_id: teacher.id,
              student_id: studentId,
              title,
              notes: "",
              created_at: now,
              updated_at: now,
            },
          },
          { status: 201 },
        ),
        true,
      );
    }

    return addSecurityHeaders(
      Response.json({ ok: false, error: "Method Not Allowed" }, { status: 405 }),
      true,
    );
  }

  // /api/boards/:id (PATCH, DELETE)
  const boardMatch = /^\/api\/boards\/([^/]+)$/.exec(url.pathname);
  if (boardMatch) {
    const boardId = boardMatch[1];
    if (!isValidBoardId(boardId)) {
      return addSecurityHeaders(
        Response.json({ ok: false, error: "Board not found" }, { status: 404 }),
        true,
      );
    }

    const existingBoard = await env.DB.prepare(
      "SELECT id, title, notes, student_id, created_at FROM boards WHERE id = ?1 AND teacher_id = ?2 AND deleted_at IS NULL",
    )
      .bind(boardId, teacher.id)
      .first<{
        id: string;
        title: string;
        notes: string;
        student_id: string | null;
        created_at: number;
      }>();

    if (!existingBoard) {
      return addSecurityHeaders(
        Response.json({ ok: false, error: "Board not found" }, { status: 404 }),
        true,
      );
    }

    if (request.method === "DELETE") {
      const now = Date.now();
      await env.DB.prepare(
        "UPDATE boards SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND teacher_id = ?3",
      )
        .bind(now, boardId, teacher.id)
        .run();

      // Invalidate in-memory allowed board cache immediately
      evictBoardCache(boardId);

      // Revoke all active sockets and block room in Durable Object
      const stub = env.BOARD.get(env.BOARD.idFromName(boardId));
      await stub.fetch("http://do/internal/revoke", { method: "POST" });

      return addSecurityHeaders(Response.json({ ok: true }), true);
    }

    if (request.method === "PATCH") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return addSecurityHeaders(
          Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 }),
          true,
        );
      }

      const payload = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
      let newTitle = existingBoard.title;
      if (typeof payload.title === "string") {
        const trimmed = payload.title.trim();
        if (trimmed) {
          newTitle = trimmed.slice(0, 100);
        }
      }

      let newNotes = existingBoard.notes;
      if (typeof payload.notes === "string") {
        newNotes = payload.notes.slice(0, 2000);
      }

      let newStudentId = existingBoard.student_id;
      if (payload.student_id === null) {
        newStudentId = null;
      } else if (typeof payload.student_id === "string") {
        if (!isValidBoardId(payload.student_id)) {
          return addSecurityHeaders(
            Response.json({ ok: false, error: "Invalid student_id" }, { status: 400 }),
            true,
          );
        }
        const studentExists = await env.DB.prepare(
          "SELECT id FROM students WHERE id = ?1 AND teacher_id = ?2 LIMIT 1",
        )
          .bind(payload.student_id, teacher.id)
          .first();
        if (!studentExists) {
          return addSecurityHeaders(
            Response.json({ ok: false, error: "Student not found" }, { status: 404 }),
            true,
          );
        }
        newStudentId = payload.student_id;
      }

      const now = Date.now();
      await env.DB.prepare(
        "UPDATE boards SET title = ?1, notes = ?2, student_id = ?3, updated_at = ?4 WHERE id = ?5 AND teacher_id = ?6",
      )
        .bind(newTitle, newNotes, newStudentId, now, boardId, teacher.id)
        .run();

      return addSecurityHeaders(
        Response.json({
          ok: true,
          board: {
            id: boardId,
            teacher_id: teacher.id,
            student_id: newStudentId,
            title: newTitle,
            notes: newNotes,
            created_at: existingBoard.created_at,
            updated_at: now,
          },
        }),
        true,
      );
    }

    return addSecurityHeaders(
      Response.json({ ok: false, error: "Method Not Allowed" }, { status: 405 }),
      true,
    );
  }

  return addSecurityHeaders(
    Response.json({ ok: false, error: "Not Found" }, { status: 404 }),
    true,
  );
}

export default {
  async fetch(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Direct robots.txt route
    if (url.pathname === "/robots.txt") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return addSecurityHeaders(
          Response.json(
            { ok: false, error: "Method Not Allowed" },
            {
              status: 405,
              headers: { Allow: "GET, HEAD" },
            },
          ),
          true,
        );
      }
      return addSecurityHeaders(
        new Response("User-agent: *\nDisallow: /\n", {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=86400",
          },
        }),
      );
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env, url);
    }

    if (url.pathname === "/ws" || url.pathname.startsWith("/ws/")) {
      return handleWebSocketUpgrade(request, env, url);
    }

    if (env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      return addSecurityHeaders(assetResponse, false);
    }

    return addSecurityHeaders(new Response("Not Found", { status: 404 }), false);
  },
} satisfies ExportedHandler<Env>;
