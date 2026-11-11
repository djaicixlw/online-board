import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(currentDir, "..");
const RUNTIME_BOARD_ID_FAST = "RtBoArDFast0123456789A"; // 22 base62 chars
const RUNTIME_BOARD_ID_SILENCE = "RtBoArDSilence01234567"; // 22 base62 chars

interface MiniflareSocketLike {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: { data: unknown }) => void): void;
}

interface MiniflareLike {
  dispatchFetch(
    input: string,
    init?: { method?: string; headers?: Record<string, string> },
  ): Promise<{
    status: number;
    webSocket?: MiniflareSocketLike;
  }>;
  dispose(): Promise<void>;
}

async function loadMiniflareAndBundle(): Promise<{
  MiniflareClass: new (opts: Record<string, unknown>) => MiniflareLike;
  scriptContent: string;
}> {
  const candidateMiniflare = [
    resolve(workerRoot, "node_modules/miniflare"),
    resolve(workerRoot, "../node_modules/miniflare"),
  ];
  if (!candidateMiniflare.some((p) => existsSync(p))) {
    throw new Error(
      "Miniflare package is not installed in node_modules. Run `npm install` or `npm ci` first.",
    );
  }

  const mfModuleName = "miniflare";
  const esbuildModuleName = "esbuild";
  const mfMod = (await import(mfModuleName)) as {
    Miniflare: new (opts: Record<string, unknown>) => MiniflareLike;
  };
  const esbuildMod = (await import(esbuildModuleName)) as {
    build(opts: Record<string, unknown>): Promise<{
      outputFiles: Array<{ text: string }>;
    }>;
  };

  const buildResult = await esbuildMod.build({
    entryPoints: [resolve(workerRoot, "src/index.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    external: ["cloudflare:workers"],
    write: false,
  });

  const scriptContent = buildResult.outputFiles[0]?.text;
  if (!scriptContent) {
    throw new Error("esbuild produced empty output for worker/src/index.ts");
  }

  return {
    MiniflareClass: mfMod.Miniflare,
    scriptContent,
  };
}

async function requireOrSkipMiniflare(ctx: { skip: () => void }) {
  const requireRuntime =
    Boolean(process.env.CI) || process.env.REQUIRE_RUNTIME === "1";

  try {
    return await loadMiniflareAndBundle();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (requireRuntime) {
      throw new Error(
        `[board.runtime.test] Miniflare runtime is required (CI / REQUIRE_RUNTIME=1), but failed to load: ${msg}`,
      );
    }
    console.warn(
      `[WARN] [board.runtime.test] Skipping real Workers runtime test because Miniflare is unavailable (${msg}). Set REQUIRE_RUNTIME=1 to enforce failure.`,
    );
    ctx.skip();
    return null;
  }
}

describe("Task T2.5, T2.5b & T2.5c: Board Durable Object Runtime Integration Suite (Miniflare workerd + SQLite)", () => {
  it(
    "verifies hello + snapshot, scene_update broadcast, ping/pong auto-response, 2.6s alarm flush, immediate close flush, and SQLite disk persistence across Miniflare restarts",
    { timeout: 60_000 },
    async (ctx) => {
      const mfEnv = await requireOrSkipMiniflare(ctx);
      if (!mfEnv) {
        return;
      }

      const persistDir = resolve(workerRoot, ".wrangler/tmp-runtime-test-fast");
      rmSync(persistDir, { recursive: true, force: true });
      mkdirSync(persistDir, { recursive: true });

      const createMfInstance = () =>
        new mfEnv.MiniflareClass({
          modules: true,
          script: mfEnv.scriptContent,
          compatibilityDate: "2026-11-07",
          durableObjects: {
            BOARD: {
              className: "Board",
              useSQLite: true,
            },
          },
          durableObjectsPersist: persistDir,
          bindings: {
            SAVE_INTERVAL_MS: "2000",
            ALLOW_ANY_BOARD_ID: "false",
            PILOT_BOARD_IDS: RUNTIME_BOARD_ID_FAST,
          },
        });

      let mf = createMfInstance();
      try {
        const resA = await mf.dispatchFetch(
          `http://localhost/ws/${RUNTIME_BOARD_ID_FAST}?nick=Alice`,
          { headers: { Upgrade: "websocket" } },
        );
        const resB = await mf.dispatchFetch(
          `http://localhost/ws/${RUNTIME_BOARD_ID_FAST}?nick=Bob`,
          { headers: { Upgrade: "websocket" } },
        );
        expect(resA.status).toBe(101);
        expect(resB.status).toBe(101);

        const wsA = resA.webSocket;
        const wsB = resB.webSocket;
        if (!wsA || !wsB) {
          throw new Error("Expected upgraded WebSockets from Miniflare");
        }
        const messagesA: string[] = [];
        const messagesB: string[] = [];

        wsA.accept();
        wsB.accept();
        wsA.addEventListener("message", (ev) => messagesA.push(String(ev.data)));
        wsB.addEventListener("message", (ev) => messagesB.push(String(ev.data)));

        // 1. hello and snapshot
        wsA.send(JSON.stringify({ type: "hello", client_id: "rt-a", nick: "Alice" }));
        wsB.send(JSON.stringify({ type: "hello", client_id: "rt-b", nick: "Bob" }));

        await new Promise((r) => setTimeout(r, 100));
        expect(messagesA.some((m) => JSON.parse(m).type === "snapshot")).toBe(true);
        expect(messagesB.some((m) => JSON.parse(m).type === "snapshot")).toBe(true);

        // 2. scene_update between two clients
        messagesB.length = 0;
        const rectEl = {
          id: "rt-rect-1",
          type: "rectangle",
          x: 50,
          y: 60,
          version: 1,
          versionNonce: 101,
          updated: Date.now(),
        };
        wsA.send(JSON.stringify({ type: "scene_update", elements: [rectEl] }));
        await new Promise((r) => setTimeout(r, 100));
        expect(messagesB.length).toBeGreaterThanOrEqual(1);
        expect(JSON.parse(messagesB[0] ?? "{}")).toMatchObject({
          type: "scene_update",
          client_id: "rt-a",
          elements: [rectEl],
        });

        // 3. Auto-response on {"type":"ping"} -> {"type":"pong"}
        messagesA.length = 0;
        wsA.send('{"type":"ping"}');
        await new Promise((r) => setTimeout(r, 60));
        expect(messagesA).toContain('{"type":"pong"}');

        // 4. Wait 2600 ms so the 2000 ms production alarm fires while sockets stay open
        await new Promise((r) => setTimeout(r, 2_600));

        // 5. Immediate flush on socket close: send a second element and close wsA immediately
        const closeStrokeEl = {
          id: "rt-close-stroke-2",
          type: "freedraw",
          x: 10,
          y: 20,
          version: 1,
          versionNonce: 202,
          updated: Date.now(),
        };
        wsA.send(JSON.stringify({ type: "scene_update", elements: [closeStrokeEl] }));
        await new Promise((r) => setTimeout(r, 40));
        wsA.close(1000, "tab-closed-immediately");
        await new Promise((r) => setTimeout(r, 80));
        wsB.close(1000, "done");
        await mf.dispose();

        // 6. Restart Miniflare on the same SQLite directory to verify disk persistence
        mf = createMfInstance();
        const resC = await mf.dispatchFetch(
          `http://localhost/ws/${RUNTIME_BOARD_ID_FAST}?nick=Charlie`,
          { headers: { Upgrade: "websocket" } },
        );
        expect(resC.status).toBe(101);
        const wsC = resC.webSocket;
        if (!wsC) {
          throw new Error("Expected upgraded WebSocket C");
        }
        const messagesC: string[] = [];
        wsC.accept();
        wsC.addEventListener("message", (ev) => messagesC.push(String(ev.data)));
        wsC.send(JSON.stringify({ type: "hello", client_id: "rt-c", nick: "Charlie" }));
        await new Promise((r) => setTimeout(r, 100));

        const restoredSnapshot = JSON.parse(messagesC[0] ?? "{}") as {
          type: string;
          elements: Array<{ id: string }>;
        };
        expect(restoredSnapshot.type).toBe("snapshot");
        expect(restoredSnapshot.elements.map((e) => e.id)).toEqual([
          "rt-rect-1",
          "rt-close-stroke-2",
        ]);
        wsC.close(1000, "done");
      } finally {
        await mf.dispose();
        rmSync(persistDir, { recursive: true, force: true });
      }
    },
  );

  it(
    "persists scene_update across a 15-second silence window with default SAVE_INTERVAL_MS=5000 and survives Miniflare restart on the same SQLite directory",
    { timeout: 60_000 },
    async (ctx) => {
      const mfEnv = await requireOrSkipMiniflare(ctx);
      if (!mfEnv) {
        return;
      }

      const persistDir = resolve(workerRoot, ".wrangler/tmp-runtime-test-silence");
      rmSync(persistDir, { recursive: true, force: true });
      mkdirSync(persistDir, { recursive: true });

      const createMfInstance = () =>
        new mfEnv.MiniflareClass({
          modules: true,
          script: mfEnv.scriptContent,
          compatibilityDate: "2026-11-07",
          durableObjects: {
            BOARD: {
              className: "Board",
              useSQLite: true,
            },
          },
          durableObjectsPersist: persistDir,
          bindings: {
            SAVE_INTERVAL_MS: "5000",
            ALLOW_ANY_BOARD_ID: "false",
            PILOT_BOARD_IDS: RUNTIME_BOARD_ID_SILENCE,
          },
        });

      let mf = createMfInstance();
      try {
        const resA = await mf.dispatchFetch(
          `http://localhost/ws/${RUNTIME_BOARD_ID_SILENCE}?nick=Teacher`,
          { headers: { Upgrade: "websocket" } },
        );
        expect(resA.status).toBe(101);
        const wsA = resA.webSocket;
        if (!wsA) {
          throw new Error("Expected upgraded WebSocket A");
        }
        wsA.accept();
        wsA.send(JSON.stringify({ type: "hello", client_id: "rt-silence-a", nick: "Teacher" }));
        await new Promise((r) => setTimeout(r, 80));

        const silenceEl = {
          id: "rt-15s-silence-el",
          type: "ellipse",
          x: 200,
          y: 200,
          version: 1,
          versionNonce: 303,
          updated: Date.now(),
        };
        wsA.send(JSON.stringify({ type: "scene_update", elements: [silenceEl] }));

        // Wait 15.2 seconds in complete silence (alarm fires at ~5s)
        await new Promise((r) => setTimeout(r, 15_200));
        await mf.dispose();

        // Restart Miniflare on the same SQLite directory and verify the element was persisted on disk
        mf = createMfInstance();
        const resB = await mf.dispatchFetch(
          `http://localhost/ws/${RUNTIME_BOARD_ID_SILENCE}?nick=Student`,
          { headers: { Upgrade: "websocket" } },
        );
        expect(resB.status).toBe(101);
        const wsB = resB.webSocket;
        if (!wsB) {
          throw new Error("Expected upgraded WebSocket B");
        }
        const messagesB: string[] = [];
        wsB.accept();
        wsB.addEventListener("message", (ev) => messagesB.push(String(ev.data)));
        wsB.send(JSON.stringify({ type: "hello", client_id: "rt-silence-b", nick: "Student" }));
        await new Promise((r) => setTimeout(r, 100));

        const finalSnapshot = JSON.parse(messagesB[0] ?? "{}") as {
          type: string;
          elements: Array<{ id: string }>;
        };
        expect(finalSnapshot.type).toBe("snapshot");
        expect(finalSnapshot.elements).toEqual([silenceEl]);
        wsB.close(1000, "done");
      } finally {
        await mf.dispose();
        rmSync(persistDir, { recursive: true, force: true });
      }
    },
  );
});
