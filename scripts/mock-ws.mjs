import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "..");

function loadWsModule() {
  try {
    const localReq = createRequire(resolve(repoRoot, "package.json"));
    return localReq("ws");
  } catch {
    const sysReq = createRequire("/usr/share/nodejs/");
    return sysReq("ws");
  }
}

const WsPkg = loadWsModule();
const WebSocketServer = WsPkg.WebSocketServer || WsPkg.Server;

const BOARD_ID_REGEX = /^[0-9A-Za-z]{22}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F-\u009F]+/g;
const MAX_CONNECTIONS_PER_BOARD = 20;

export function sanitizeMockNick(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const cleaned = raw.replace(CONTROL_CHARS_REGEX, "").trim();
  const len = Array.from(cleaned).length;
  return len >= 1 && len <= 32 ? cleaned : null;
}

export function shouldReplaceMockElement(existing, incoming) {
  if (!existing) {
    return true;
  }
  if (incoming.version > existing.version) {
    return true;
  }
  if (incoming.version === existing.version && incoming.versionNonce < existing.versionNonce) {
    return true;
  }
  return false;
}

/**
 * Starts the mock WebSocket collaboration server for Task T2 development and testing.
 * Implements SPEC.md section 6 protocol: hello -> snapshot, scene_update broadcast, cursor broadcast, ping -> pong.
 */
export async function startMockWsServer(options = {}) {
  const port = options.port ?? Number.parseInt(process.env.MOCK_WS_PORT || "8787", 10);
  const host = options.host ?? "127.0.0.1";
  const maxConnections = options.maxConnections ?? MAX_CONNECTIONS_PER_BOARD;

  // Map: boardId -> { elements: Map<id, element>, clients: Map<ws, { clientId, nick }> }
  const rooms = new Map();

  function getOrCreateRoom(boardId) {
    let room = rooms.get(boardId);
    if (!room) {
      room = {
        elements: new Map(),
        clients: new Map(),
      };
      rooms.set(boardId, room);
    }
    return room;
  }

  const httpServer = createServer((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, version: "0.1.0" }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "Not Found" }));
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const reqUrl = new URL(req.url || "/", `http://${host}:${port}`);
    const match = /^\/ws\/([^/]+)$/.exec(reqUrl.pathname);
    const boardId = match?.[1] ?? "";
    const nick = sanitizeMockNick(reqUrl.searchParams.get("nick"));
    const simulateFull = reqUrl.searchParams.get("simulate_full") === "1";

    if (!BOARD_ID_REGEX.test(boardId) || !nick) {
      socket.write("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{\"ok\":false}");
      socket.destroy();
      return;
    }

    const room = getOrCreateRoom(boardId);

    wss.handleUpgrade(req, socket, head, (ws) => {
      if (simulateFull || room.clients.size >= maxConnections) {
        ws.close(1013, "Board connection limit reached (max 20)");
        return;
      }

      const clientMeta = {
        clientId: null,
        nick,
      };
      room.clients.set(ws, clientMeta);

      ws.on("message", (rawData) => {
        const text = typeof rawData === "string" ? rawData : rawData.toString("utf8");
        if (text === '{"type":"ping"}') {
          ws.send('{"type":"pong"}');
          return;
        }

        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
          return;
        }

        if (msg.type === "ping") {
          ws.send('{"type":"pong"}');
          return;
        }

        if (msg.type === "hello") {
          if (typeof msg.client_id === "string" && msg.client_id.trim()) {
            clientMeta.clientId = msg.client_id.trim();
          }
          if (typeof msg.nick === "string") {
            const updatedNick = sanitizeMockNick(msg.nick);
            if (updatedNick) {
              clientMeta.nick = updatedNick;
            }
          }

          const collaborators = [];
          for (const peerMeta of room.clients.values()) {
            if (peerMeta.clientId) {
              collaborators.push({
                client_id: peerMeta.clientId,
                nick: peerMeta.nick,
              });
            }
          }

          ws.send(
            JSON.stringify({
              type: "snapshot",
              elements: Array.from(room.elements.values()),
              collaborators,
            }),
          );
          return;
        }

        if (msg.type === "scene_update" && Array.isArray(msg.elements)) {
          const accepted = [];
          for (const el of msg.elements) {
            if (
              el &&
              typeof el === "object" &&
              typeof el.id === "string" &&
              typeof el.version === "number" &&
              typeof el.versionNonce === "number"
            ) {
              const existing = room.elements.get(el.id);
              if (shouldReplaceMockElement(existing, el)) {
                room.elements.set(el.id, el);
                accepted.push(el);
              }
            }
          }

          const outbound = JSON.stringify({
            type: "scene_update",
            client_id: clientMeta.clientId ?? "anonymous",
            nick: clientMeta.nick,
            elements: accepted.length > 0 ? accepted : msg.elements,
          });

          for (const peerWs of room.clients.keys()) {
            if (peerWs !== ws && peerWs.readyState === peerWs.OPEN) {
              peerWs.send(outbound);
            }
          }
          return;
        }

        if (
          msg.type === "cursor" &&
          typeof msg.x === "number" &&
          typeof msg.y === "number"
        ) {
          const outbound = JSON.stringify({
            type: "cursor",
            client_id: clientMeta.clientId ?? "anonymous",
            nick: clientMeta.nick,
            x: msg.x,
            y: msg.y,
            ...(msg.pointer !== undefined ? { pointer: msg.pointer } : {}),
            ...(msg.tool !== undefined ? { tool: msg.tool } : {}),
          });

          for (const peerWs of room.clients.keys()) {
            if (peerWs !== ws && peerWs.readyState === peerWs.OPEN) {
              peerWs.send(outbound);
            }
          }
        }
      });

      ws.on("close", () => {
        room.clients.delete(ws);
      });
    });
  });

  await new Promise((resolveListen) => httpServer.listen(port, host, resolveListen));
  const addr = httpServer.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    port: actualPort,
    host,
    wsBaseUrl: `ws://${host}:${actualPort}`,
    httpBaseUrl: `http://${host}:${actualPort}`,
    rooms,
    close: () =>
      new Promise((resolveClose) => {
        for (const room of rooms.values()) {
          for (const ws of room.clients.keys()) {
            ws.terminate();
          }
        }
        wss.close(() => httpServer.close(resolveClose));
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startMockWsServer().then((srv) => {
    console.log(`[mock-ws] Мок-сервер WebSocket запущен на ${srv.wsBaseUrl} (HTTP: ${srv.httpBaseUrl}/api/health)`);
  });
}
