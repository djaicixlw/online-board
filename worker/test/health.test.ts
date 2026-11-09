import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import worker, { Board, resolveSaveIntervalMs, type Env } from "../src/index.js";
import { createBoardTestHarness } from "./cloudflare-workers-shim.js";

function createMockEnv(overrides: Partial<Env> = {}): Env {
  const harness = createBoardTestHarness(Board, overrides);
  return harness.env;
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

  it("resolveSaveIntervalMs defaults to 5000 and clamps to 2000..8000 in prod (below 10s hibernation threshold)", () => {
    expect(resolveSaveIntervalMs(undefined, false)).toBe(5000);
    expect(resolveSaveIntervalMs("invalid", false)).toBe(5000);
    expect(resolveSaveIntervalMs("5000", false)).toBe(5000);
    expect(resolveSaveIntervalMs("1000", false)).toBe(2000);
    expect(resolveSaveIntervalMs("15000", false)).toBe(8000);
    expect(resolveSaveIntervalMs("1000", true)).toBe(1000);
  });
});
