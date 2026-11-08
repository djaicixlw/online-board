import { CursorInterpolator } from "./cursor-interpolator.js";
import { isValidBoardId, sanitizeNickname } from "./nick.js";
import { mergeSceneElements, VersionDiffTracker } from "./reconcile.js";
import type {
  CollaboratorInfo,
  ConnectionStatus,
  CursorToolKind,
  ExcalidrawElementLike,
  InterpolatedCursor,
  PointerKind,
  ReconcileElementsFn,
  ServerToClientMessage,
} from "./types.js";

export const SCENE_SYNC_INTERVAL_MS = 100; // 10 Hz max
export const CURSOR_SYNC_INTERVAL_MS = 100; // 10 Hz max
export const PING_INTERVAL_MS = 30_000; // 1 ping per 30s
export const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
export const BOARD_FULL_CLOSE_CODE = 1013;

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface BoardCollabClientOptions {
  boardId: string;
  clientId: string;
  nick: string | null;
  wsBaseUrl?: string;
  createWebSocket?: WebSocketFactory;
  reconcileElements?: ReconcileElementsFn;
  getLocalElements: () => readonly ExcalidrawElementLike[];
  getLocalAppState?: () => Record<string, unknown>;
  onRemoteSceneApplied: (
    elements: ExcalidrawElementLike[],
    collaborators?: CollaboratorInfo[],
  ) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  onCollaboratorsChange?: (collaborators: CollaboratorInfo[]) => void;
  onRemoteCursorsChange?: (cursors: InterpolatedCursor[]) => void;
  now?: () => number;
}

function defaultWsBaseUrl(): string {
  if (typeof window !== "undefined" && window.location) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}`;
  }
  return "ws://localhost:8787";
}

/**
 * WebSocket collaboration client for `/ws/:id?nick=...` implementing SPEC.md sections 6 & 8:
 * - Waits for a valid nickname before opening a connection.
 * - Sends `hello {client_id, nick}` on connect; merges incoming `snapshot` via `reconcileElements`.
 * - Tracks per-element `version` diffs; batches `scene_update` at most 10 Hz (100 ms), sending
 *   intermediate updates while drawing and flushing the final state on pointer release.
 * - Throttles `cursor` updates to at most 10 Hz (100 ms) and only when coordinates change.
 * - Sends exact `'{"type":"ping"}'` string every 30 seconds.
 * - Reconnects with exponential backoff (1, 2, 4, 8, 15s); preserves local drawing while offline
 *   and reconciles + flushes pending changes upon reconnect.
 * - Switches status to `"full"` («Доска заполнена») and stops reconnecting on close code 1013.
 */
export class BoardCollabClient {
  private readonly boardId: string;
  private readonly clientId: string;
  private nick: string | null;
  private readonly wsBaseUrl: string;
  private readonly createWebSocket: WebSocketFactory;
  private readonly reconcileElements?: ReconcileElementsFn;
  private readonly getLocalElements: () => readonly ExcalidrawElementLike[];
  private readonly getLocalAppState: () => Record<string, unknown>;
  private readonly onRemoteSceneApplied: (
    elements: ExcalidrawElementLike[],
    collaborators?: CollaboratorInfo[],
  ) => void;
  private readonly onStatusChange?: (status: ConnectionStatus) => void;
  private readonly onCollaboratorsChange?: (collaborators: CollaboratorInfo[]) => void;
  private readonly onRemoteCursorsChange?: (cursors: InterpolatedCursor[]) => void;
  private readonly now: () => number;

  public readonly versionTracker = new VersionDiffTracker();
  public readonly cursorInterpolator = new CursorInterpolator();

  private ws: WebSocketLike | null = null;
  private status: ConnectionStatus = "idle";
  private manualDisconnect = false;
  private reconnectAttempt = 0;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private sceneBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorThrottleTimer: ReturnType<typeof setTimeout> | null = null;

  private lastSceneSentAt = -Infinity;
  private lastCursorSentAt = -Infinity;

  private pendingCursor: {
    x: number;
    y: number;
    pointer: PointerKind;
    tool: CursorToolKind;
  } | null = null;

  private lastSentCursor: {
    x: number;
    y: number;
    pointer: PointerKind;
    tool: CursorToolKind;
  } | null = null;

  private collaborators: CollaboratorInfo[] = [];

  constructor(options: BoardCollabClientOptions) {
    if (!isValidBoardId(options.boardId)) {
      throw new Error(`Invalid boardId "${options.boardId}": expected 22 base62 characters`);
    }
    this.boardId = options.boardId;
    this.clientId = options.clientId;
    this.nick = sanitizeNickname(options.nick);
    this.wsBaseUrl = (options.wsBaseUrl ?? defaultWsBaseUrl()).replace(/\/$/, "");
    this.createWebSocket =
      options.createWebSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    if (options.reconcileElements) {
      this.reconcileElements = options.reconcileElements;
    }
    this.getLocalElements = options.getLocalElements;
    this.getLocalAppState = options.getLocalAppState ?? (() => ({}));
    this.onRemoteSceneApplied = options.onRemoteSceneApplied;
    if (options.onStatusChange) {
      this.onStatusChange = options.onStatusChange;
    }
    if (options.onCollaboratorsChange) {
      this.onCollaboratorsChange = options.onCollaboratorsChange;
    }
    if (options.onRemoteCursorsChange) {
      this.onRemoteCursorsChange = options.onRemoteCursorsChange;
    }
    this.now = options.now ?? (() => Date.now());
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public getNick(): string | null {
    return this.nick;
  }

  public getCollaborators(): CollaboratorInfo[] {
    return [...this.collaborators];
  }

  private setStatus(nextStatus: ConnectionStatus): void {
    if (this.status === nextStatus) {
      return;
    }
    this.status = nextStatus;
    this.onStatusChange?.(nextStatus);
  }

  /**
   * Opens the WebSocket connection if a valid nickname is set.
   * Without a nickname, no connection is opened (Requirement 2).
   */
  public connect(): boolean {
    if (!this.nick) {
      this.setStatus("idle");
      return false;
    }

    this.manualDisconnect = false;
    this.clearReconnectTimer();

    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      return true;
    }

    this.setStatus(this.reconnectAttempt > 0 ? "offline" : "connecting");

    const wsUrl = `${this.wsBaseUrl}/ws/${this.boardId}?nick=${encodeURIComponent(this.nick)}`;
    const socket = this.createWebSocket(wsUrl);
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket) {
        return;
      }
      this.reconnectAttempt = 0;
      this.setStatus("connected");

      // Send hello immediately upon opening WebSocket
      this.sendRaw(
        JSON.stringify({
          type: "hello",
          client_id: this.clientId,
          nick: this.nick,
        }),
      );

      this.startPingLoop();
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) {
        return;
      }
      this.handleServerMessage(event.data);
    };

    socket.onclose = (event) => {
      if (this.ws !== socket) {
        return;
      }
      this.ws = null;
      this.stopPingLoop();

      if (this.manualDisconnect) {
        this.setStatus("idle");
        return;
      }

      if (event.code === BOARD_FULL_CLOSE_CODE) {
        this.clearReconnectTimer();
        this.setStatus("full");
        return;
      }

      this.setStatus("offline");
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // Browser/WebSocket automatically triggers onclose after onerror
    };

    return true;
  }

  /**
   * Updates the user's nickname. If not yet connected, starts the connection;
   * if already connected, sends an updated `hello` message with the new nickname.
   */
  public setNick(newNick: string): boolean {
    const sanitized = sanitizeNickname(newNick);
    if (!sanitized) {
      return false;
    }
    const previousNick = this.nick;
    this.nick = sanitized;

    if (!this.ws || this.status === "idle" || this.status === "full") {
      return this.connect();
    }

    if (this.status === "connected" && previousNick !== sanitized) {
      this.sendRaw(
        JSON.stringify({
          type: "hello",
          client_id: this.clientId,
          nick: sanitized,
        }),
      );
    }
    return true;
  }

  public disconnect(): void {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    this.stopPingLoop();
    this.clearSceneBatchTimer();
    this.clearCursorThrottleTimer();
    if (this.ws) {
      const activeWs = this.ws;
      this.ws = null;
      try {
        activeWs.close(1000, "client_disconnect");
      } catch {
        // Ignore close error
      }
    }
    this.setStatus("idle");
  }

  /**
   * Queues local scene changes for throttled/batched sending (at most 10 Hz = every 100 ms).
   * During active drawing, sends intermediate updates every 100 ms.
   */
  public queueSceneUpdate(elements?: readonly ExcalidrawElementLike[]): void {
    const currentElements = elements ?? this.getLocalElements();
    const changed = this.versionTracker.getChangedElements(currentElements);
    if (changed.length === 0) {
      return;
    }

    if (this.status !== "connected" || !this.ws || this.ws.readyState !== 1) {
      // Offline: keep changes in local elements; VersionDiffTracker will send them after reconnect
      return;
    }

    const nowMs = this.now();
    const elapsed = nowMs - this.lastSceneSentAt;

    if (elapsed >= SCENE_SYNC_INTERVAL_MS && this.sceneBatchTimer === null) {
      this.flushSceneChangesNow();
      return;
    }

    if (this.sceneBatchTimer === null) {
      const waitMs = Math.max(0, SCENE_SYNC_INTERVAL_MS - elapsed);
      this.sceneBatchTimer = setTimeout(() => {
        this.sceneBatchTimer = null;
        this.flushSceneChangesNow();
      }, waitMs);
    }
  }

  /**
   * Called on pointer release (`pointerup`) to ensure the final state of a stroke or shape
   * is sent immediately (or at the end of the active 100 ms 10 Hz window).
   */
  public flushSceneOnPointerRelease(elements?: readonly ExcalidrawElementLike[]): void {
    const currentElements = elements ?? this.getLocalElements();
    const changed = this.versionTracker.getChangedElements(currentElements);
    if (changed.length === 0) {
      return;
    }

    if (this.status !== "connected" || !this.ws || this.ws.readyState !== 1) {
      return;
    }

    const nowMs = this.now();
    const elapsed = nowMs - this.lastSceneSentAt;

    if (elapsed >= SCENE_SYNC_INTERVAL_MS) {
      this.clearSceneBatchTimer();
      this.flushSceneChangesNow(currentElements);
    } else if (this.sceneBatchTimer === null) {
      const waitMs = Math.max(0, SCENE_SYNC_INTERVAL_MS - elapsed);
      this.sceneBatchTimer = setTimeout(() => {
        this.sceneBatchTimer = null;
        this.flushSceneChangesNow();
      }, waitMs);
    }
  }

  private flushSceneChangesNow(overrideElements?: readonly ExcalidrawElementLike[]): void {
    if (this.status !== "connected" || !this.ws || this.ws.readyState !== 1) {
      return;
    }
    const currentElements = overrideElements ?? this.getLocalElements();
    const changed = this.versionTracker.getChangedElements(currentElements);
    if (changed.length === 0) {
      return;
    }

    this.versionTracker.markSynced(changed);
    this.lastSceneSentAt = this.now();
    this.sendRaw(
      JSON.stringify({
        type: "scene_update",
        elements: changed,
      }),
    );
  }

  /**
   * Queues local cursor movement, throttled to at most 10 Hz (100 ms) and sent only when
   * coordinates or tool actually change.
   */
  public queueCursorUpdate(
    x: number,
    y: number,
    pointer: PointerKind = "mouse",
    tool: CursorToolKind = "pointer",
  ): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    const roundedX = Math.round(x * 2) / 2;
    const roundedY = Math.round(y * 2) / 2;

    if (
      this.lastSentCursor &&
      this.lastSentCursor.x === roundedX &&
      this.lastSentCursor.y === roundedY &&
      this.lastSentCursor.tool === tool &&
      this.lastSentCursor.pointer === pointer
    ) {
      return;
    }

    this.pendingCursor = { x: roundedX, y: roundedY, pointer, tool };

    if (this.status !== "connected" || !this.ws || this.ws.readyState !== 1) {
      return;
    }

    const nowMs = this.now();
    const elapsed = nowMs - this.lastCursorSentAt;

    if (elapsed >= CURSOR_SYNC_INTERVAL_MS && this.cursorThrottleTimer === null) {
      this.flushCursorNow();
      return;
    }

    if (this.cursorThrottleTimer === null) {
      const waitMs = Math.max(0, CURSOR_SYNC_INTERVAL_MS - elapsed);
      this.cursorThrottleTimer = setTimeout(() => {
        this.cursorThrottleTimer = null;
        this.flushCursorNow();
      }, waitMs);
    }
  }

  private flushCursorNow(): void {
    if (
      !this.pendingCursor ||
      this.status !== "connected" ||
      !this.ws ||
      this.ws.readyState !== 1
    ) {
      return;
    }
    const cursor = this.pendingCursor;
    this.pendingCursor = null;

    if (
      this.lastSentCursor &&
      this.lastSentCursor.x === cursor.x &&
      this.lastSentCursor.y === cursor.y &&
      this.lastSentCursor.tool === cursor.tool &&
      this.lastSentCursor.pointer === cursor.pointer
    ) {
      return;
    }

    this.lastSentCursor = cursor;
    this.lastCursorSentAt = this.now();
    this.sendRaw(
      JSON.stringify({
        type: "cursor",
        x: cursor.x,
        y: cursor.y,
        pointer: cursor.pointer,
        tool: cursor.tool,
      }),
    );
  }

  private handleServerMessage(rawText: string): void {
    let parsed: ServerToClientMessage;
    try {
      parsed = JSON.parse(rawText) as ServerToClientMessage;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      return;
    }

    if (parsed.type === "pong") {
      return;
    }

    if (parsed.type === "snapshot") {
      const serverElements = Array.isArray(parsed.elements) ? parsed.elements : [];
      const collaborators = Array.isArray(parsed.collaborators) ? parsed.collaborators : [];
      this.collaborators = collaborators;
      this.onCollaboratorsChange?.(collaborators);

      // Record server baseline so any local elements edited while offline remain unsent
      this.versionTracker.applyServerSnapshotBaseline(serverElements);

      const localElements = this.getLocalElements();
      const merged = mergeSceneElements(
        localElements,
        serverElements,
        this.getLocalAppState(),
        this.reconcileElements,
      );

      this.onRemoteSceneApplied(merged, collaborators);

      // Flush any offline local edits that outranked or were absent from the server snapshot
      const offlinePending = this.versionTracker.getChangedElements(merged);
      if (offlinePending.length > 0) {
        this.queueSceneUpdate(merged);
      }
      return;
    }

    if (parsed.type === "scene_update") {
      if (parsed.client_id && parsed.client_id === this.clientId) {
        return;
      }
      const remoteElements = Array.isArray(parsed.elements) ? parsed.elements : [];
      if (remoteElements.length === 0) {
        return;
      }

      // Mark remote elements as synced so we do not re-broadcast them back
      this.versionTracker.markSynced(remoteElements);

      const localElements = this.getLocalElements();
      const merged = mergeSceneElements(
        localElements,
        remoteElements,
        this.getLocalAppState(),
        this.reconcileElements,
      );

      if (parsed.client_id && parsed.nick) {
        this.ensureCollaboratorPresent(parsed.client_id, parsed.nick);
      }

      this.onRemoteSceneApplied(merged);
      return;
    }

    if (parsed.type === "cursor") {
      if (!parsed.client_id || parsed.client_id === this.clientId) {
        return;
      }
      if (typeof parsed.x !== "number" || typeof parsed.y !== "number") {
        return;
      }
      const senderNick = parsed.nick ?? parsed.client_id;
      this.ensureCollaboratorPresent(parsed.client_id, senderNick);
      this.cursorInterpolator.updateTarget(
        {
          client_id: parsed.client_id,
          nick: senderNick,
          x: parsed.x,
          y: parsed.y,
          ...(parsed.pointer !== undefined ? { pointer: parsed.pointer } : {}),
          ...(parsed.tool !== undefined ? { tool: parsed.tool } : {}),
        },
        this.now(),
      );
      this.onRemoteCursorsChange?.(this.cursorInterpolator.getSnapshot());
    }
  }

  private ensureCollaboratorPresent(clientId: string, nick: string): void {
    const existing = this.collaborators.find((c) => c.client_id === clientId);
    if (existing) {
      if (existing.nick !== nick) {
        existing.nick = nick;
        this.onCollaboratorsChange?.([...this.collaborators]);
      }
      return;
    }
    this.collaborators.push({ client_id: clientId, nick });
    this.onCollaboratorsChange?.([...this.collaborators]);
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      if (this.status === "connected" && this.ws && this.ws.readyState === 1) {
        // Exact string required for Cloudflare Durable Objects setWebSocketAutoResponse
        this.sendRaw('{"type":"ping"}');
      }
    }, PING_INTERVAL_MS);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const idx = Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
    const delayMs = RECONNECT_BACKOFF_MS[idx] ?? 15_000;
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualDisconnect && this.status !== "full") {
        this.connect();
      }
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearSceneBatchTimer(): void {
    if (this.sceneBatchTimer !== null) {
      clearTimeout(this.sceneBatchTimer);
      this.sceneBatchTimer = null;
    }
  }

  private clearCursorThrottleTimer(): void {
    if (this.cursorThrottleTimer !== null) {
      clearTimeout(this.cursorThrottleTimer);
      this.cursorThrottleTimer = null;
    }
  }

  private sendRaw(payload: string): void {
    if (!this.ws || this.ws.readyState !== 1) {
      return;
    }
    try {
      this.ws.send(payload);
    } catch {
      // Socket closed mid-send; onclose will handle reconnect
    }
  }
}
