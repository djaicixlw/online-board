import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(currentDir, "..");
const RUNTIME_BOARD_ID = "RtBoArD0123456789AbCdE"; // 22 base62 chars

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

describe("Task T2.5 & T2.5b: Board Durable Object Runtime Integration Suite (Miniflare workerd + SQLite)", () => {
  it(
    "verifies hello + snapshot, scene_update broadcast, real alarm flush, immediate close flush, 15s inactivity survival, DO restart, and ping/pong auto-response",
    { timeout: 35_000 },
    async (ctx) => {
      const requireRuntime =
        Boolean(process.env.CI) || process.env.REQUIRE_RUNTIME === "1";

      let mfEnv: Awaited<ReturnType<typeof loadMiniflareAndBundle>>;
      try {
        mfEnv = await loadMiniflareAndBundle();
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
        return;
      }

      const persistDir = resolve(workerRoot, ".wrangler/tmp-runtime-test-sqlite");
      rmSync(persistDir, { recursive: true, force: true });
      mkdirSync(persistDir, { recursive: true });

      // In production mode (ALLOW_ANY_BOARD_ID="false"), SAVE_INTERVAL_MS="2000" is clamped to 2000 ms.
      const createMfInstance = (saveIntervalMs = "2000") =>
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
            SAVE_INTERVAL_MS: saveIntervalMs,
            ALLOW_ANY_BOARD_ID: "false",
            PILOT_BOARD_IDS: RUNTIME_BOARD_ID,
          },
        });

      let mf = createMfInstance("2000");
      try {
        const resA = await mf.dispatchFetch(
          `http://localhost/ws/${RUNTIME_BOARD_ID}?nick=Alice`,
          { headers: { Upgrade: "websocket" } },
        );
        const resB = await mf.dispatchFetch(
          `http://localhost/ws/${RUNTIME_BOARD_ID}?nick=Bob`,
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

        // 4. Wait >= 2.5s (2600 ms) so the 2000 ms production alarm genuinely fires while sockets stay open (C.13)
        await new Promise((r) => setTimeout(r, 2_600));

        // 5. Immediate flush on socket close (B.5 / C.14): send a second element and close wsA immediately
        // (while wsB is still open and before the next 2000 ms alarm)
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

        // 6. Restart Miniflare on the same SQLite directory (with default 5000 ms interval) and verify BOTH elements survived,
        // then test a new edit followed by 15s of complete silence (C.13)
        mf = createMfInstance("5000");
        const resC = await mf.dispatchFetch(
          `http://localhost/ws/${RUNTIME_BOARD_ID}?nick=Charlie`,
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

        // Send a 3rd element and wait 15 seconds in silence so the 5s alarm flushes before 10s hibernation
        const silenceEl = {
          id: "rt-15s-silence-3",
          type: "ellipse",
          x: 200,
          y: 200,
          version: 1,
          versionNonce: 303,
          updated: Date.now(),
        };
        wsC.send(JSON.stringify({ type: "scene_update", elements: [silenceEl] }));
        await new Promise((r) => setTimeout(r, 15_200));
        await mf.dispose();

        // Reopen Miniflare and confirm all 3 elements are persisted in SQLite
        mf = createMfInstance("5000");
        const resD = await mf.dispatchFetch(
          `http://localhost/ws/${RUNTIME_BOARD_ID}?nick=Dana`,
          { headers: { Upgrade: "websocket" } },
        );
        const wsD = resD.webSocket;
        if (!wsD) {
          throw new Error("Expected upgraded WebSocket D");
        }
        const messagesD: string[] = [];
        wsD.accept();
        wsD.addEventListener("message", (ev) => messagesD.push(String(ev.data)));
        wsD.send(JSON.stringify({ type: "hello", client_id: "rt-d", nick: "Dana" }));
        await new Promise((r) => setTimeout(r, 100));

        const finalSnapshot = JSON.parse(messagesD[0] ?? "{}") as {
          type: string;
          elements: Array<{ id: string }>;
        };
        expect(finalSnapshot.elements.map((e) => e.id)).toEqual([
          "rt-rect-1",
          "rt-close-stroke-2",
          "rt-15s-silence-3",
        ]);
        wsD.close(1000, "done");
      } finally {
        await mf.dispose();
        rmSync(persistDir, { recursive: true, force: true });
      }
    },
  );
});
