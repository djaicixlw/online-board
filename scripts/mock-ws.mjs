#!/usr/bin/env node
/**
 * Local WebSocket mock server (`scripts/mock-ws.mjs`) for developing and testing T2
 * independently or alongside T1.
 *
 * Implements the server-side protocol from SPEC.md (section 6):
 * - Route: GET /ws/:id?nick=<nick>
 * - Validates board id (22 base62 chars) and nick (1..32 chars)
 * - Replies `{"type":"pong"}` to exact string `{"type":"ping"}`
 * - Accepts `hello`, replies with `snapshot { elements, collaborators }`
 * - Merges `scene_update` by `(version, versionNonce)` and broadcasts to other peers in the room
 * - Broadcasts `cursor` to other peers in the room with sender `client_id` and `nick`
 */

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.MOCK_WS_PORT ?? 8788);
const MAX_CLIENTS_PER_BOARD = Number(process.env.MAX_CLIENTS_PER_BOARD ?? 25);
const MAX_WS_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2 MB limit (Fix #10)
const BASE62_BOARD_ID_RE = /^[0-9A-Za-z]{22}$/;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * Map: boardId -> {
 *   elements: Map<string, object>,
 *   clients: Map<WebSocket, { client_id: string, nick: string }>
 * }
 */
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

function sanitizeNick(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL_CHARS_RE, "").trim();
  const len = Array.from(cleaned).length;
  if (len < 1 || len > 32) return null;
  return cleaned;
}

function shouldReplaceElement(existing, incoming) {
  if (!existing) return true;
  if (incoming.version > existing.version) return true;
  if (incoming.version < existing.version) return false;
  return incoming.versionNonce < existing.versionNonce;
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, mock: true }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "Not Found" }));
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const match = /^\/ws\/([^/]+)$/.exec(url.pathname);
  if (!match) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  let boardId = "";
  try {
    boardId = decodeURIComponent(match[1]);
  } catch {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const nick = sanitizeNick(url.searchParams.get("nick"));
  if (!BASE62_BOARD_ID_RE.test(boardId) || !nick) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const room = getOrCreateRoom(boardId);
  if (room.clients.size >= MAX_CLIENTS_PER_BOARD) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.close(1013, "Board room is full");
    });
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const attachment = {
      client_id: `anon-${Math.random().toString(36).slice(2, 10)}`,
      nick,
    };
    room.clients.set(ws, attachment);

    ws.on("message", (rawData, isBinary) => {
      if (isBinary) return;
      const text = rawData.toString("utf-8");

      if (text === '{"type":"ping"}') {
        ws.send('{"type":"pong"}');
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        console.warn("[mock-ws] Invalid JSON ignored");
        return;
      }

      if (!parsed || typeof parsed !== "object") return;

      if (parsed.type === "ping") {
        ws.send('{"type":"pong"}');
        return;
      }

      if (parsed.type === "hello") {
        if (typeof parsed.client_id === "string" && parsed.client_id.trim()) {
          attachment.client_id = parsed.client_id.trim().slice(0, 64);
        }
        const updatedNick = sanitizeNick(parsed.nick);
        if (updatedNick) {
          attachment.nick = updatedNick;
        }
        room.clients.set(ws, attachment);

        ws.send(
          JSON.stringify({
            type: "snapshot",
            elements: Array.from(room.elements.values()),
            collaborators: Array.from(room.clients.values()),
          })
        );
        return;
      }

      if (parsed.type === "scene_update" && Array.isArray(parsed.elements)) {
        const updated = [];
        for (const el of parsed.elements) {
          if (
            el &&
            typeof el === "object" &&
            typeof el.id === "string" &&
            typeof el.version === "number" &&
            Number.isFinite(el.version) &&
            el.version >= 0 &&
            typeof el.versionNonce === "number" &&
            Number.isFinite(el.versionNonce)
          ) {
            const current = room.elements.get(el.id);
            if (shouldReplaceElement(current, el)) {
              room.elements.set(el.id, el);
            }
            updated.push(el);
          }
        }
        if (updated.length === 0) return;

        const payload = JSON.stringify({
          type: "scene_update",
          client_id: attachment.client_id,
          nick: attachment.nick,
          elements: updated,
        });

        for (const peer of room.clients.keys()) {
          if (peer !== ws && peer.readyState === WebSocket.OPEN) {
            peer.send(payload);
          }
        }
        return;
      }

      if (
        parsed.type === "cursor" &&
        typeof parsed.x === "number" &&
        Number.isFinite(parsed.x) &&
        typeof parsed.y === "number" &&
        Number.isFinite(parsed.y)
      ) {
        const payload = JSON.stringify({
          type: "cursor",
          client_id: attachment.client_id,
          nick: attachment.nick,
          x: parsed.x,
          y: parsed.y,
          pointer: parsed.pointer === "pen" || parsed.pointer === "laser" ? parsed.pointer : "mouse",
          tool: typeof parsed.tool === "string" ? parsed.tool.slice(0, 32) : "selection",
        });

        for (const peer of room.clients.keys()) {
          if (peer !== ws && peer.readyState === WebSocket.OPEN) {
            peer.send(payload);
          }
        }
      }
    });

    ws.on("close", () => {
      room.clients.delete(ws);
      if (room.clients.size === 0) {
        rooms.delete(boardId);
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`[mock-ws] Listening on ws://localhost:${PORT}/ws/:id?nick=...`);
});
