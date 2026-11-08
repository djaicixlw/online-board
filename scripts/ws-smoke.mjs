import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "..");

/**
 * Resolves a WebSocket client and server implementation from Node globals or system nodejs packages.
 */
function loadWsBindings() {
  try {
    const req = createRequire(resolve(repoRoot, "package.json"));
    return req("ws");
  } catch {
    const sysReq = createRequire("/usr/share/nodejs/");
    return sysReq("ws");
  }
}

const WsModule = loadWsBindings();
const WebSocketClient = WsModule.WebSocket || WsModule;
const WebSocketServer = WsModule.WebSocketServer || WsModule.Server;

const BOARD_ID = "SmokeTestBoard12345678";

function waitForMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolveMsg, rejectMsg) => {
    const timer = setTimeout(() => {
      rejectMsg(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);

    const onMessage = (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      const parsed = JSON.parse(text);
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolveMsg(parsed);
      }
    };

    ws.on("message", onMessage);
  });
}

function connectWs(url) {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocketClient(url);
    ws.once("open", () => resolveConn(ws));
    ws.once("error", rejectConn);
  });
}

/**
 * Starts an embedded local Worker + Board Durable Object WebSocket server when an external
 * `wrangler dev` process is not already listening on WS_SMOKE_URL.
 */
async function startEmbeddedWorkerServer() {
  const { readFileSync } = await import("node:fs");
  const sysReq = createRequire("/usr/share/nodejs/");
  const babel = sysReq("@babel/core");

  function importTsModule(relPath, replacements = []) {
    let code = readFileSync(resolve(repoRoot, relPath), "utf8");
    code = code.replace(/\s+with\s+\{\s*type:\s*"json"\s*\}/g, "");
    for (const [from, to] of replacements) {
      code = code.replace(from, to);
    }
    const transformed = babel.transformSync(code, {
      filename: relPath,
      presets: [[sysReq.resolve("@babel/preset-typescript"), { allExtensions: true }]],
    });
    const dataUrl = `data:text/javascript;base64,${Buffer.from(transformed.code, "utf8").toString("base64")}`;
    return import(dataUrl);
  }

  const shimMod = await importTsModule("worker/test/cloudflare-workers-shim.ts");
  const shimUrl = `data:text/javascript;base64,${Buffer.from(
    babel.transformSync(readFileSync(resolve(repoRoot, "worker/test/cloudflare-workers-shim.ts"), "utf8"), {
      filename: "cloudflare-workers-shim.ts",
      presets: [[sysReq.resolve("@babel/preset-typescript"), { allExtensions: true }]],
    }).code,
    "utf8",
  ).toString("base64")}`;

  const envUrl = `data:text/javascript;base64,${Buffer.from(
    babel.transformSync(readFileSync(resolve(repoRoot, "worker/src/env.ts"), "utf8"), {
      filename: "env.ts",
      presets: [[sysReq.resolve("@babel/preset-typescript"), { allExtensions: true }]],
    }).code,
    "utf8",
  ).toString("base64")}`;

  const boardMod = await importTsModule("worker/src/board.ts", [
    ['from "cloudflare:workers"', `from "${shimUrl}"`],
    ['from "./env.js"', `from "${envUrl}"`],
  ]);

  const harness = shimMod.createBoardTestHarness(boardMod.Board, {
    SAVE_INTERVAL_MS: "10000",
    ALLOW_ANY_BOARD_ID: "true",
  });

  const httpServer = createServer((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "0.1.0" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", async (req, socket, head) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    const match = /^\/ws\/([^/]+)$/.exec(reqUrl.pathname);
    const boardId = match?.[1] ?? "";
    const nick = boardMod.sanitizeNickname(reqUrl.searchParams.get("nick"));

    if (!boardMod.isValidBoardId(boardId) || !nick) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, async (realWs) => {
      const { board, state } = harness.getInstance(boardId);
      const upgradeReq = new Request(`http://127.0.0.1${req.url}`, {
        method: "GET",
        headers: { Upgrade: "websocket" },
      });
      const res = await board.fetch(upgradeReq);
      const mockClientSocket = res.webSocket;
      const mockServerSocket = mockClientSocket.peer;

      mockClientSocket.addEventListener("message", (ev) => {
        if (realWs.readyState === realWs.OPEN) {
          realWs.send(ev.data);
        }
      });

      mockClientSocket.addEventListener("close", (ev) => {
        if (realWs.readyState === realWs.OPEN) {
          realWs.close(ev.code, ev.reason);
        }
      });

      realWs.on("message", async (data) => {
        const text = typeof data === "string" ? data : data.toString("utf8");
        const autoPair = state.getWebSocketAutoResponse();
        if (autoPair && text === autoPair.request) {
          realWs.send(autoPair.response);
          return;
        }
        await board.webSocketMessage(mockServerSocket, text);
      });

      realWs.on("close", async (code, reason) => {
        await board.webSocketClose(mockServerSocket, code, reason.toString("utf8"), true);
      });
    });
  });

  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 8787;

  return {
    baseUrl: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        wss.close(() => httpServer.close(r));
      }),
  };
}

async function main() {
  let baseUrl = process.env.WS_SMOKE_URL || "";
  let embeddedServer = null;

  if (!baseUrl) {
    embeddedServer = await startEmbeddedWorkerServer();
    baseUrl = embeddedServer.baseUrl;
    console.log(`[ws-smoke] Запущен локальный сервер проверки: ${baseUrl}`);
  } else {
    console.log(`[ws-smoke] Подключение к внешнему серверу: ${baseUrl}`);
  }

  try {
    const ws1Url = `${baseUrl}/ws/${BOARD_ID}?nick=${encodeURIComponent("Преподаватель")}`;
    const ws2Url = `${baseUrl}/ws/${BOARD_ID}?nick=${encodeURIComponent("Ученик_Анна")}`;

    // 1. Connect Client 1 and Client 2
    const client1 = await connectWs(ws1Url);
    const client2 = await connectWs(ws2Url);

    const snap1Promise = waitForMessage(client1, (m) => m.type === "snapshot");
    client1.send(JSON.stringify({ type: "hello", client_id: "smoke-client-1", nick: "Преподаватель" }));
    const snap1 = await snap1Promise;
    assert.equal(snap1.type, "snapshot");
    console.log(`[ws-smoke] Клиент 1 (Преподаватель) получил пустой snapshot (элементов: ${snap1.elements.length}).`);

    const snap2Promise = waitForMessage(client2, (m) => m.type === "snapshot");
    client2.send(JSON.stringify({ type: "hello", client_id: "smoke-client-2", nick: "Ученик_Анна" }));
    const snap2 = await snap2Promise;
    assert.equal(snap2.type, "snapshot");
    console.log(`[ws-smoke] Клиент 2 (Ученик_Анна) подключён (активных участников: ${snap2.collaborators.length}).`);

    // 2. Client 1 draws an element -> Client 2 receives scene_update
    const drawnElement = {
      id: "rect-lesson-1",
      type: "rectangle",
      x: 120,
      y: 80,
      width: 200,
      height: 100,
      version: 2,
      versionNonce: 424242,
      updated: Date.now(),
    };

    const updateOnClient2Promise = waitForMessage(client2, (m) => m.type === "scene_update");
    client1.send(
      JSON.stringify({
        type: "scene_update",
        elements: [drawnElement],
      }),
    );

    const updateOnClient2 = await updateOnClient2Promise;
    assert.equal(updateOnClient2.client_id, "smoke-client-1");
    assert.equal(updateOnClient2.nick, "Преподаватель");
    assert.equal(updateOnClient2.elements.length, 1);
    assert.equal(updateOnClient2.elements[0].id, "rect-lesson-1");
    console.log(`[ws-smoke] Клиент 2 получил scene_update от "${updateOnClient2.nick}" (элемент: ${updateOnClient2.elements[0].id}).`);

    // 3. New Client 3 connects and receives snapshot with the drawn element
    const ws3Url = `${baseUrl}/ws/${BOARD_ID}?nick=${encodeURIComponent("Ученик_Иван")}`;
    const client3 = await connectWs(ws3Url);
    const snap3Promise = waitForMessage(client3, (m) => m.type === "snapshot");
    client3.send(JSON.stringify({ type: "hello", client_id: "smoke-client-3", nick: "Ученик_Иван" }));

    const snap3 = await snap3Promise;
    assert.equal(snap3.elements.length, 1);
    assert.equal(snap3.elements[0].id, "rect-lesson-1");
    assert.equal(snap3.collaborators.length, 3);
    console.log(
      `[ws-smoke] Новый Клиент 3 (Ученик_Иван) получил актуальный snapshot (элементов: ${snap3.elements.length}, участников: ${snap3.collaborators.length}).`,
    );

    // 4. Close all connections cleanly
    client1.close(1000, "done");
    client2.close(1000, "done");
    client3.close(1000, "done");
    await new Promise((r) => setTimeout(r, 50));

    console.log("[ws-smoke] УСПЕШНО: все проверки совместного рисования и получения snapshot пройдены.");
  } finally {
    if (embeddedServer) {
      await embeddedServer.close();
    }
  }
}

main().catch((err) => {
  console.error("[ws-smoke] ОШИБКА:", err);
  process.exit(1);
});
