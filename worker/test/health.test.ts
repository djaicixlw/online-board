import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import worker, { Board, resolveSaveIntervalMs, type Env } from "../src/index.js";

function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    BOARD: {} as DurableObjectNamespace<Board>,
    SAVE_INTERVAL_MS: "10000",
    ALLOW_ANY_BOARD_ID: "true",
    ...overrides,
  };
}

describe("Worker API and static asset routing", () => {
  it("GET /api/health returns { ok: true, version } matching package.json", async () => {
    const request = new Request("http://localhost:8787/api/health", {
      method: "GET",
    });
    const env = createMockEnv();

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const data = (await response.json()) as { ok: boolean; version: string };
    expect(data).toEqual({
      ok: true,
      version: pkg.version,
    });
  });

  it("POST /api/health returns 405 Method Not Allowed", async () => {
    const request = new Request("http://localhost:8787/api/health", {
      method: "POST",
    });
    const env = createMockEnv();

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("GET /api/unknown returns 404 JSON error", async () => {
    const request = new Request("http://localhost:8787/api/unknown", {
      method: "GET",
    });
    const env = createMockEnv();

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });

  it("Non-API request delegates to ASSETS binding when available", async () => {
    const request = new Request("http://localhost:8787/", {
      method: "GET",
    });
    const env = createMockEnv({
      ASSETS: {
        fetch: async () =>
          new Response("<!doctype html><html><body>Canvas</body></html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      } as unknown as Fetcher,
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Canvas");
  });
});

describe("Board Durable Object stub and SAVE_INTERVAL_MS helper", () => {
  it("resolveSaveIntervalMs defaults to 10000 and clamps to 5000..15000", () => {
    expect(resolveSaveIntervalMs(undefined)).toBe(10000);
    expect(resolveSaveIntervalMs("invalid")).toBe(10000);
    expect(resolveSaveIntervalMs("10000")).toBe(10000);
    expect(resolveSaveIntervalMs("2000")).toBe(5000);
    expect(resolveSaveIntervalMs("30000")).toBe(15000);
  });

  it("Board stub responds with 501 and configured saveIntervalMs", async () => {
    const mockState = {} as DurableObjectState;
    const env = createMockEnv({ SAVE_INTERVAL_MS: "12000" });
    const board = new Board(mockState, env);

    const response = await board.fetch(new Request("http://localhost:8787/ws/test"));
    expect(response.status).toBe(501);
    const body = (await response.json()) as {
      ok: boolean;
      saveIntervalMs: number;
    };
    expect(body.ok).toBe(false);
    expect(body.saveIntervalMs).toBe(12000);
  });
});
