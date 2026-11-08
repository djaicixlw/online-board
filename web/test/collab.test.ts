import { describe, expect, it, vi } from "vitest";
import {
  BoardCollabClient,
  CursorInterpolator,
  loadSavedNickname,
  mergeSceneElements,
  NICK_STORAGE_KEY,
  parseBoardRoute,
  parseExcalidrawDocument,
  RECONNECT_BACKOFF_MS,
  sanitizeNickname,
  saveNickname,
  serializeExcalidrawDocument,
  VersionDiffTracker,
  type ConnectionStatus,
  type ExcalidrawElementLike,
  type WebSocketLike,
} from "../src/collab/index.js";
import {
  normalizePointerKind,
  shouldSuppressTouchOrPalmDrawing,
} from "../src/input/pen-guard.js";

const VALID_BOARD_ID = "BoardFrontendTest12345"; // 22 base62 chars

class FakeWebSocket implements WebSocketLike {
  public readyState = 0; // CONNECTING
  public onopen: ((ev: unknown) => void) | null = null;
  public onmessage: ((ev: { data: string }) => void) | null = null;
  public onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  public onerror: ((ev: unknown) => void) | null = null;
  public readonly sent: string[] = [];
  public readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  public simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  public simulateServerMessage(msg: unknown): void {
    this.onmessage?.({
      data: typeof msg === "string" ? msg : JSON.stringify(msg),
    });
  }

  public simulateClose(code = 1006, reason = "abnormal"): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

describe("Task T2: Collab Module (throttling, batching, version diff, reconnect, cursors)", () => {
  it("does not open WebSocket connection without a valid nickname and persists board.nick in localStorage", () => {
    const store = new Map<string, string>();
    const mockStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };

    expect(loadSavedNickname(mockStorage)).toBeNull();
    expect(sanitizeNickname("   \u0000\n ")).toBeNull();
    expect(sanitizeNickname("Я".repeat(33))).toBeNull();

    const sockets: FakeWebSocket[] = [];
    const client = new BoardCollabClient({
      boardId: VALID_BOARD_ID,
      clientId: "c-1",
      nick: null,
      wsBaseUrl: "ws://localhost:8787",
      createWebSocket: (url) => {
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        return ws;
      },
      getLocalElements: () => [],
      onRemoteSceneApplied: () => {},
    });

    // Without nick, connect() returns false and creates 0 sockets
    expect(client.connect()).toBe(false);
    expect(sockets.length).toBe(0);
    expect(client.getStatus()).toBe("idle");

    // Save nick to storage and setNick on client -> opens WebSocket immediately
    const saved = saveNickname("  Мария  ", mockStorage);
    expect(saved).toBe("Мария");
    expect(store.get(NICK_STORAGE_KEY)).toBe("Мария");
    expect(loadSavedNickname(mockStorage)).toBe("Мария");

    expect(client.setNick(saved)).toBe(true);
    expect(sockets.length).toBe(1);
    expect(sockets[0]!.url).toBe(
      `ws://localhost:8787/ws/${VALID_BOARD_ID}?nick=%D0%9C%D0%B0%D1%80%D0%B8%D1%8F`,
    );
    expect(client.getStatus()).toBe("connecting");
  });

  it("diffs elements by version & versionNonce and batches scene_update at most 10 Hz (100 ms), flushing final state on pointer release", () => {
    vi.useFakeTimers();
    try {
      let currentNow = 10_000;
      const sockets: FakeWebSocket[] = [];
      let localElements: ExcalidrawElementLike[] = [];

      const client = new BoardCollabClient({
        boardId: VALID_BOARD_ID,
        clientId: "client-draw",
        nick: "Антон",
        wsBaseUrl: "ws://localhost:8787",
        now: () => currentNow,
        createWebSocket: (url) => {
          const s = new FakeWebSocket(url);
          sockets.push(s);
          return s;
        },
        getLocalElements: () => localElements,
        onRemoteSceneApplied: (els) => {
          localElements = els;
        },
      });

      client.connect();
      const ws = sockets[0]!;
      ws.simulateOpen();

      // First message sent on open is hello
      expect(ws.sent.length).toBe(1);
      expect(JSON.parse(ws.sent[0]!)).toEqual({
        type: "hello",
        client_id: "client-draw",
        nick: "Антон",
      });

      // Receive initial snapshot with el-1 (v1) and el-2 (v5)
      ws.simulateServerMessage({
        type: "snapshot",
        elements: [
          { id: "el-1", version: 1, versionNonce: 100 },
          { id: "el-2", version: 5, versionNonce: 200 },
        ],
        collaborators: [{ client_id: "client-draw", nick: "Антон" }],
      });
      expect(localElements.length).toBe(2);

      ws.sent.length = 0;

      // User starts drawing stroke on el-1: v2 at t = 10_000 -> sent immediately (first in window)
      localElements = [
        { id: "el-1", version: 2, versionNonce: 90 },
        { id: "el-2", version: 5, versionNonce: 200 }, // unchanged!
      ];
      client.queueSceneUpdate(localElements);

      expect(ws.sent.length).toBe(1);
      const batch1 = JSON.parse(ws.sent[0]!);
      expect(batch1.type).toBe("scene_update");
      // Only el-1 was sent, el-2 was filtered out by VersionDiffTracker!
      expect(batch1.elements).toEqual([{ id: "el-1", version: 2, versionNonce: 90 }]);

      // Rapid intermediate drawing updates at t = 10_020 (v3), 10_040 (v4), 10_060 (v5)
      currentNow = 10_020;
      localElements = [
        { id: "el-1", version: 3, versionNonce: 80 },
        { id: "el-2", version: 5, versionNonce: 200 },
      ];
      client.queueSceneUpdate(localElements);

      currentNow = 10_040;
      localElements = [
        { id: "el-1", version: 4, versionNonce: 70 },
        { id: "el-2", version: 5, versionNonce: 200 },
      ];
      client.queueSceneUpdate(localElements);

      currentNow = 10_060;
      localElements = [
        { id: "el-1", version: 5, versionNonce: 60 },
        { id: "el-2", version: 5, versionNonce: 200 },
      ];
      client.queueSceneUpdate(localElements);

      // Still within the 100 ms (10 Hz) window -> no new packet sent yet!
      expect(ws.sent.length).toBe(1);

      // Advance 100 ms to t = 10_100 -> intermediate batch sent with v5
      currentNow = 10_100;
      vi.advanceTimersByTime(100);
      expect(ws.sent.length).toBe(2);
      expect(JSON.parse(ws.sent[1]!).elements).toEqual([
        { id: "el-1", version: 5, versionNonce: 60 },
      ]);

      // User finishes stroke (v6) at t = 10_210 and releases pen/mouse -> flushes immediately
      currentNow = 10_210;
      localElements = [
        { id: "el-1", version: 6, versionNonce: 50 },
        { id: "el-2", version: 5, versionNonce: 200 },
      ];
      client.flushSceneOnPointerRelease(localElements);
      expect(ws.sent.length).toBe(3);
      expect(JSON.parse(ws.sent[2]!).elements).toEqual([
        { id: "el-1", version: 6, versionNonce: 50 },
      ]);

      // Calling queueSceneUpdate again with no version changes sends nothing
      client.queueSceneUpdate(localElements);
      vi.advanceTimersByTime(500);
      expect(ws.sent.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttles cursor updates to 10 Hz (100 ms), skips unchanged coordinates, and sends exact ping every 30s", () => {
    vi.useFakeTimers();
    try {
      let currentNow = 50_000;
      const sockets: FakeWebSocket[] = [];
      const client = new BoardCollabClient({
        boardId: VALID_BOARD_ID,
        clientId: "client-cursor",
        nick: "Ирина",
        wsBaseUrl: "ws://localhost:8787",
        now: () => currentNow,
        createWebSocket: (url) => {
          const s = new FakeWebSocket(url);
          sockets.push(s);
          return s;
        },
        getLocalElements: () => [],
        onRemoteSceneApplied: () => {},
      });

      client.connect();
      const ws = sockets[0]!;
      ws.simulateOpen();
      ws.sent.length = 0; // clear hello

      // First cursor movement at t = 50_000 -> sent immediately
      client.queueCursorUpdate(100, 200, "pen", "pointer");
      expect(ws.sent.length).toBe(1);
      expect(JSON.parse(ws.sent[0]!)).toEqual({
        type: "cursor",
        x: 100,
        y: 200,
        pointer: "pen",
        tool: "pointer",
      });

      // Duplicate coordinates -> ignored
      currentNow = 50_200;
      client.queueCursorUpdate(100, 200, "pen", "pointer");
      expect(ws.sent.length).toBe(1);

      // Burst of cursor movements within 100 ms window -> throttled to 1 send at end of window
      currentNow = 50_210;
      client.queueCursorUpdate(110, 210, "pen", "pointer"); // sent immediately because 210ms > 100ms since last send at 50_000
      expect(ws.sent.length).toBe(2);

      currentNow = 50_230;
      client.queueCursorUpdate(120, 220, "pen", "pointer");
      currentNow = 50_250;
      client.queueCursorUpdate(130, 230, "pen", "pointer");
      expect(ws.sent.length).toBe(2);

      currentNow = 50_310;
      vi.advanceTimersByTime(100);
      expect(ws.sent.length).toBe(3);
      expect(JSON.parse(ws.sent[2]!)).toEqual({
        type: "cursor",
        x: 130,
        y: 230,
        pointer: "pen",
        tool: "pointer",
      });

      // Advance 30 seconds -> exact {"type":"ping"} string sent
      ws.sent.length = 0;
      vi.advanceTimersByTime(30_000);
      expect(ws.sent).toContain('{"type":"ping"}');
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects with exponential backoff (1, 2, 4, 8, 15s), preserves local edits while offline, and stops on 1013 (board full)", () => {
    vi.useFakeTimers();
    try {
      let currentNow = 100_000;
      const sockets: FakeWebSocket[] = [];
      const statuses: ConnectionStatus[] = [];
      let localElements: ExcalidrawElementLike[] = [
        { id: "init-1", version: 1, versionNonce: 10 },
      ];

      const client = new BoardCollabClient({
        boardId: VALID_BOARD_ID,
        clientId: "client-reconnect",
        nick: "Сергей",
        wsBaseUrl: "ws://localhost:8787",
        now: () => currentNow,
        createWebSocket: (url) => {
          const s = new FakeWebSocket(url);
          sockets.push(s);
          return s;
        },
        getLocalElements: () => localElements,
        onRemoteSceneApplied: (merged) => {
          localElements = merged;
        },
        onStatusChange: (st) => statuses.push(st),
      });

      client.connect();
      expect(sockets.length).toBe(1);
      sockets[0]!.simulateOpen();
      sockets[0]!.simulateServerMessage({
        type: "snapshot",
        elements: [{ id: "init-1", version: 1, versionNonce: 10 }],
        collaborators: [],
      });

      // Connection drops abnormally -> status becomes "offline" («Нет связи, рисуем локально»)
      sockets[0]!.simulateClose(1006, "network drop");
      expect(client.getStatus()).toBe("offline");

      // While offline, user draws a new element `offline-el` and edits `init-1` to v2
      localElements = [
        { id: "init-1", version: 2, versionNonce: 5 },
        { id: "offline-el", version: 1, versionNonce: 77 },
      ];
      client.queueSceneUpdate(localElements);

      // Verify exponential backoff schedule: 1000, 2000, 4000, 8000, 15000 ms
      expect(RECONNECT_BACKOFF_MS).toEqual([1000, 2000, 4000, 8000, 15000]);

      // Attempt 1 after 1000 ms (fails)
      vi.advanceTimersByTime(999);
      expect(sockets.length).toBe(1);
      vi.advanceTimersByTime(1);
      expect(sockets.length).toBe(2);
      sockets[1]!.simulateClose(1006, "still down");

      // Attempt 2 after 2000 ms (fails)
      vi.advanceTimersByTime(1999);
      expect(sockets.length).toBe(2);
      vi.advanceTimersByTime(1);
      expect(sockets.length).toBe(3);
      sockets[2]!.simulateClose(1006, "still down");

      // Attempt 3 after 4000 ms (succeeds!)
      vi.advanceTimersByTime(4000);
      expect(sockets.length).toBe(4);
      const reconnectedWs = sockets[3]!;
      currentNow = 110_000;
      reconnectedWs.simulateOpen();
      expect(client.getStatus()).toBe("connected");

      // Server sends snapshot that has init-1 at v1 plus peer-el at v1
      reconnectedWs.sent.length = 0;
      reconnectedWs.simulateServerMessage({
        type: "snapshot",
        elements: [
          { id: "init-1", version: 1, versionNonce: 10 },
          { id: "peer-el", version: 1, versionNonce: 33 },
        ],
        collaborators: [],
      });

      // Merged scene contains init-1 (v2 from offline edit), offline-el (v1), and peer-el (v1)
      expect(localElements).toEqual([
        { id: "init-1", version: 2, versionNonce: 5 },
        { id: "offline-el", version: 1, versionNonce: 77 },
        { id: "peer-el", version: 1, versionNonce: 33 },
      ]);

      // And the client automatically flushes the offline edits (init-1 v2 and offline-el v1) to the server!
      expect(reconnectedWs.sent.length).toBe(1);
      const flushedAfterReconnect = JSON.parse(reconnectedWs.sent[0]!);
      expect(flushedAfterReconnect).toEqual({
        type: "scene_update",
        elements: [
          { id: "init-1", version: 2, versionNonce: 5 },
          { id: "offline-el", version: 1, versionNonce: 77 },
        ],
      });

      // Now simulate server closing with 1013 (Board Full) -> status becomes "full" and does NOT reconnect
      reconnectedWs.simulateClose(1013, "Board connection limit reached");
      expect(client.getStatus()).toBe("full");
      vi.advanceTimersByTime(60_000);
      expect(sockets.length).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("smoothly interpolates remote cursors and validates pen palm rejection, routes, and .excalidraw files", () => {
    const interpolator = new CursorInterpolator();
    const initial = interpolator.updateTarget(
      { client_id: "peer-1", nick: "Дмитрий", x: 0, y: 0, pointer: "pen", tool: "pointer" },
      1000,
    );
    expect(initial.x).toBe(0);
    expect(initial.y).toBe(0);

    interpolator.updateTarget(
      { client_id: "peer-1", nick: "Дмитрий", x: 100, y: 200, pointer: "pen", tool: "laser" },
      1100,
    );

    const step1 = interpolator.step(30, 1130)[0]!;
    expect(step1.x).toBeGreaterThan(10);
    expect(step1.x).toBeLessThan(100);
    expect(step1.y).toBeGreaterThan(20);
    expect(step1.y).toBeLessThan(200);
    expect(step1.nick).toBe("Дмитрий");
    expect(step1.tool).toBe("laser");

    // Converges to target after multiple steps
    for (let i = 0; i < 20; i++) {
      interpolator.step(50, 1200 + i * 50);
    }
    const converged = interpolator.getSnapshot()[0]!;
    expect(converged.x).toBe(100);
    expect(converged.y).toBe(200);

    // Pen guard & palm rejection
    expect(normalizePointerKind("pen")).toBe("pen");
    expect(normalizePointerKind("touch")).toBe("touch");
    expect(normalizePointerKind("mouse")).toBe("mouse");
    expect(shouldSuppressTouchOrPalmDrawing({ pointerType: "pen" }, true)).toBe(false);
    expect(shouldSuppressTouchOrPalmDrawing({ pointerType: "mouse" }, true)).toBe(false);
    expect(shouldSuppressTouchOrPalmDrawing({ pointerType: "touch" }, true)).toBe(true);
    expect(
      shouldSuppressTouchOrPalmDrawing({ pointerType: "touch", width: 30, height: 30 }, false),
    ).toBe(true);

    // Route parsing & .excalidraw file serialization/parsing
    expect(parseBoardRoute(`/b/${VALID_BOARD_ID}`).boardId).toBe(VALID_BOARD_ID);
    expect(parseBoardRoute("/b/invalid-short").boardId).toBeNull();

    const docJson = serializeExcalidrawDocument([
      { id: "rect-1", version: 2, versionNonce: 11 },
      { id: "deleted-1", version: 3, versionNonce: 12, isDeleted: true },
    ]);
    const parsedDoc = parseExcalidrawDocument(docJson);
    expect(parsedDoc.elements).toEqual([{ id: "rect-1", version: 2, versionNonce: 11 }]);

    // VersionDiffTracker & mergeSceneElements
    const tracker = new VersionDiffTracker();
    const merged = mergeSceneElements(
      [{ id: "a", version: 2, versionNonce: 50 }],
      [
        { id: "a", version: 2, versionNonce: 20 },
        { id: "b", version: 1, versionNonce: 99 },
      ],
    );
    expect(merged).toEqual([
      { id: "a", version: 2, versionNonce: 20 },
      { id: "b", version: 1, versionNonce: 99 },
    ]);
    expect(tracker.getChangedElements(merged).length).toBe(2);
  });
});
