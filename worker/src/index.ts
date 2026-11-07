import pkg from "../package.json" with { type: "json" };
import { Board, resolveSaveIntervalMs } from "./board.js";
import type { Env } from "./env.js";

export { Board, resolveSaveIntervalMs };
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

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ ok: false, error: "Not Found" }, { status: 404 });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
