import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import worker, { Board } from "../src/index.js";
import { createBoardTestHarness, type MockSocket } from "./cloudflare-workers-shim.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(currentDir, "..");
const RUNTIME_BOARD_ID = "RtBoArD0123456789AbCdE"; // 22 base62 chars

interface MiniflareLike {
  dispatchFetch(
    input: string,
    init?: { method?: string; headers?: Record<string, string> },
  ): Promise<{
    status: number;
    webSocket?: {
      accept(): void;
      send(data: string): void;
      close(code?: number, reason?: string): void;
      addEventListener(type: string, listener: (ev: { data: unknown }) => void): void;
    };
  }>;
  dispose(): Promise<void>;
}

async function tryLoadMiniflareAndBundle(): Promise<{
  MiniflareClass: new (opts: Record<string, unknown>) => MiniflareLike;
  scriptContent: string;
} | null> {
  const candidateMiniflare = [
    resolve(workerRoot, "node_modules/miniflare"),
    resolve(workerRoot, "../node_modules/miniflare"),
  ];
  if (!candidateMiniflare.some((p) => existsSync(p))) {
    return null;
  }

  try {
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
      return null;
    }

    return {
      MiniflareClass: mfMod.Miniflare,
      scriptContent,
    };
  } catch {
    return null;
  }
}

describe("Task T2.5: Board Durable Object Runtime Integration Suite (Miniflare workerd / Shim fallback)", () => {
  it("verifies hello + snapshot, scene_update broadcast, alarm flush, DO restart persistence, and ping/pong auto-response", async () => {
    const mfEnv = await tryLoadMiniflareAndBundle();

    if (mfEnv) {
      const persistDir = resolve(workerRoot, ".wrangler/tmp-runtime-test-sqlite");
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
            SAVE_INTERVAL_MS: "250",
            ALLOW_ANY_BOARD_ID: "false",
            PILOT_BOARD_IDS: RUNTIME_BOARD_ID,
          },
        });

      let mf = createMfInstance();
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

        const wsA = resA.webSocket!;
        const wsB = resB.webSocket!;
        const messagesA: string[] = [];
        const messagesB: string[] = [];

        wsA.accept();
        wsB.accept();
        wsA.addEventListener("message", (ev) => messagesA.push(String(ev.data)));
        wsB.addEventListener("message", (ev) => messagesB.push(String(ev.data)));

        // 1. hello and snapshot
        wsA.send(JSON.stringify({ type: "hello", client_id: "rt-a", nick: "Alice" }));
        wsB.send(JSON.stringify({ type: "hello", client_id: "rt-b", nick: "Bob" }));

        await new Promise((r) => setTimeout(r, 80));
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
        await new Promise((r) => setTimeout(r, 80));
        expect(messagesB.length).toBeGreaterThanOrEqual(1);
        expect(JSON.parse(messagesB[0]!)).toMatchObject({
          type: "scene_update",
          client_id: "rt-a",
          elements: [rectEl],
        });

        // 3. Auto-response on {"type":"ping"} -> {"type":"pong"}
        messagesA.length = 0;
        wsA.send('{"type":"ping"}');
        await new Promise((r) => setTimeout(r, 50));
        expect(messagesA).toContain('{"type":"pong"}');

        // 4. Wait for scheduled alarm (250ms) to flush snapshot to SQLite
        await new Promise((r) => setTimeout(r, 350));
        wsA.close(1000, "done");
        wsB.close(1000, "done");
        await mf.dispose();

        // 5. Restart Miniflare instance on the same SQLite directory and verify snapshot survived
        mf = createMfInstance();
        const resC = await mf.dispatchFetch(
          `http://localhost/ws/${RUNTIME_BOARD_ID}?nick=Charlie`,
          { headers: { Upgrade: "websocket" } },
        );
        expect(resC.status).toBe(101);
        const wsC = resC.webSocket!;
        const messagesC: string[] = [];
        wsC.accept();
        wsC.addEventListener("message", (ev) => messagesC.push(String(ev.data)));
        wsC.send(JSON.stringify({ type: "hello", client_id: "rt-c", nick: "Charlie" }));
        await new Promise((r) => setTimeout(r, 80));

        const restoredSnapshot = JSON.parse(messagesC[0]!);
        expect(restoredSnapshot.type).toBe("snapshot");
        expect(restoredSnapshot.elements).toEqual([rectEl]);
        wsC.close(1000, "done");
      } finally {
        await mf.dispose();
        rmSync(persistDir, { recursive: true, force: true });
      }
      return;
    }

    // Fallback when running in offline sandbox without Miniflare binary installed
    const harness = createBoardTestHarness(Board, {
      SAVE_INTERVAL_MS: "2000",
      ALLOW_ANY_BOARD_ID: "false",
      PILOT_BOARD_IDS: RUNTIME_BOARD_ID,
    });

    const connectRuntimeClient = async (nick: string) => {
      const req = new Request(
        `http://localhost:8787/ws/${RUNTIME_BOARD_ID}?nick=${encodeURIComponent(nick)}`,
        { method: "GET", headers: { Upgrade: "websocket" } },
      );
      const res = await worker.fetch(req, harness.env);
      const { board, state } = harness.getInstance(RUNTIME_BOARD_ID);
      const clientSocket = (res as unknown as { webSocket?: MockSocket }).webSocket!;
      const serverSocket = clientSocket.peer as unknown as WebSocket;
      return { res, clientSocket, serverSocket, board, state };
    };

    const clientA = await connectRuntimeClient("Alice");
    const clientB = await connectRuntimeClient("Bob");
    expect(clientA.res.status).toBe(101);
    expect(clientB.res.status).toBe(101);

    // 1. hello + snapshot
    await clientA.board.webSocketMessage(
      clientA.serverSocket,
      JSON.stringify({ type: "hello", client_id: "rt-a", nick: "Alice" }),
    );
    await clientB.board.webSocketMessage(
      clientB.serverSocket,
      JSON.stringify({ type: "hello", client_id: "rt-b", nick: "Bob" }),
    );
    expect(JSON.parse(clientA.clientSocket.sentMessages[0]!).type).toBe("snapshot");
    expect(JSON.parse(clientB.clientSocket.sentMessages[0]!).type).toBe("snapshot");
    clientB.clientSocket.sentMessages.length = 0;

    // 2. scene_update between two clients
    const rectEl = {
      id: "rt-rect-1",
      type: "rectangle",
      x: 50,
      y: 60,
      version: 1,
      versionNonce: 101,
      updated: 1_794_114_000_000,
    };
    await clientA.board.webSocketMessage(
      clientA.serverSocket,
      JSON.stringify({ type: "scene_update", elements: [rectEl] }),
    );
    expect(clientB.clientSocket.sentMessages.length).toBe(1);
    expect(JSON.parse(clientB.clientSocket.sentMessages[0]!)).toMatchObject({
      type: "scene_update",
      client_id: "rt-a",
      elements: [rectEl],
    });

    // 3. Auto-response on {"type":"ping"}
    clientA.clientSocket.send('{"type":"ping"}');
    expect(clientA.clientSocket.sentMessages.at(-1)).toBe('{"type":"pong"}');

    // 4. Alarm execution flushes snapshot to SQLite
    expect(await clientA.state.storage.getAlarm()).not.toBeNull();
    await clientA.board.alarm();
    expect(clientA.board.getMetrics().flushesCount).toBe(1);

    // 5. DO restart preserves data in SQLite
    await harness.recreateBoard(RUNTIME_BOARD_ID);
    const clientC = await connectRuntimeClient("Charlie");
    await clientC.board.webSocketMessage(
      clientC.serverSocket,
      JSON.stringify({ type: "hello", client_id: "rt-c", nick: "Charlie" }),
    );
    const restoredSnapshot = JSON.parse(clientC.clientSocket.sentMessages[0]!);
    expect(restoredSnapshot.type).toBe("snapshot");
    expect(restoredSnapshot.elements).toEqual([rectEl]);
  });
});
