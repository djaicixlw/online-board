import pkg from "../package.json";
import {
  Board,
  DEFAULT_SAVE_INTERVAL_MS,
  DELETED_ELEMENT_RETENTION_MS,
  isBoardAccessAllowed,
  isValidBoardId,
  isValidExcalidrawElement,
  MAX_CONNECTIONS_PER_BOARD,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES_PER_SECOND,
  MAX_PILOT_BOARD_IDS,
  MAX_SNAPSHOT_CHUNK_BYTES,
  parsePilotBoardIds,
  resolveSaveIntervalMs,
  sanitizeNickname,
  shouldReplaceElement,
} from "./board.js";
import type { Env } from "./env.js";

export {
  Board,
  DEFAULT_SAVE_INTERVAL_MS,
  DELETED_ELEMENT_RETENTION_MS,
  isBoardAccessAllowed,
  isValidBoardId,
  isValidExcalidrawElement,
  MAX_CONNECTIONS_PER_BOARD,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES_PER_SECOND,
  MAX_PILOT_BOARD_IDS,
  MAX_SNAPSHOT_CHUNK_BYTES,
  parsePilotBoardIds,
  resolveSaveIntervalMs,
  sanitizeNickname,
  shouldReplaceElement,
};
export type { Env };

export interface HealthResponse {
  ok: true;
  version: string;
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
    return Response.json(
      { ok: false, error: "Invalid method: expected GET for WebSocket upgrade" },
      { status: 400 },
    );
  }

  const upgradeHeader = request.headers.get("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return Response.json(
      { ok: false, error: "Missing or invalid Upgrade: websocket header" },
      { status: 400 },
    );
  }

  const match = /^\/ws\/([^/]+)$/.exec(url.pathname);
  const boardId = match?.[1] ?? "";
  if (!isValidBoardId(boardId)) {
    return Response.json(
      { ok: false, error: "Invalid board id: must be exactly 22 base62 characters" },
      { status: 400 },
    );
  }

  const nick = sanitizeNickname(url.searchParams.get("nick"));
  if (!nick) {
    return Response.json(
      {
        ok: false,
        error:
          "Invalid nick: must be 1..32 characters after trimming and stripping control characters",
      },
      { status: 400 },
    );
  }

  // On pilot (ALLOW_ANY_BOARD_ID !== "true"), only board IDs listed in PILOT_BOARD_IDS are allowed
  if (!isBoardAccessAllowed(boardId, env)) {
    return Response.json({ ok: false, error: "Board not found" }, { status: 404 });
  }

  const doId = env.BOARD.idFromName(boardId);
  const stub = env.BOARD.get(doId);

  const forwardUrl = new URL(request.url);
  forwardUrl.searchParams.set("nick", nick);

  return stub.fetch(
    new Request(forwardUrl.toString(), {
      method: "GET",
      headers: request.headers,
    }),
  );
}

export default {
  async fetch(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return Response.json(
          { ok: false, error: "Method Not Allowed" },
          {
            status: 405,
            headers: { Allow: "GET, HEAD" },
          },
        );
      }
      return createHealthResponse();
    }

    if (url.pathname === "/ws" || url.pathname.startsWith("/ws/")) {
      return handleWebSocketUpgrade(request, env, url);
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ ok: false, error: "Not Found" }, { status: 404 });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
