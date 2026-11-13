import pkg from "../package.json";
import { Board, isBoardAccessAllowed, isValidBoardId, sanitizeNickname } from "./board.js";
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
  if (!isValidBoardId(boardId) || !isBoardAccessAllowed(boardId, env)) {
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

    if (url.pathname === "/api/health") {
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
      return addSecurityHeaders(createHealthResponse(), true);
    }

    if (url.pathname === "/ws" || url.pathname.startsWith("/ws/")) {
      return handleWebSocketUpgrade(request, env, url);
    }

    if (url.pathname.startsWith("/api/")) {
      return addSecurityHeaders(
        Response.json({ ok: false, error: "Not Found" }, { status: 404 }),
        true,
      );
    }

    if (env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      return addSecurityHeaders(assetResponse, false);
    }

    return addSecurityHeaders(new Response("Not Found", { status: 404 }), false);
  },
} satisfies ExportedHandler<Env>;
