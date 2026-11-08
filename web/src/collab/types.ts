export interface ExcalidrawElementLike {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  updated?: number;
  index?: string | null;
  [key: string]: unknown;
}

export interface CollaboratorInfo {
  client_id: string;
  nick: string;
}

export type PointerKind = "mouse" | "pen" | "touch";
export type CursorToolKind = "pointer" | "laser";

export interface HelloMessage {
  type: "hello";
  client_id: string;
  nick: string;
}

export interface SnapshotMessage {
  type: "snapshot";
  elements: ExcalidrawElementLike[];
  collaborators: CollaboratorInfo[];
}

export interface SceneUpdateMessage {
  type: "scene_update";
  client_id?: string;
  nick?: string;
  elements: ExcalidrawElementLike[];
}

export interface CursorMessage {
  type: "cursor";
  client_id?: string;
  nick?: string;
  x: number;
  y: number;
  pointer?: PointerKind;
  tool?: CursorToolKind;
}

export interface PingMessage {
  type: "ping";
}

export interface PongMessage {
  type: "pong";
}

export type ClientToServerMessage =
  | HelloMessage
  | SceneUpdateMessage
  | CursorMessage
  | PingMessage;

export type ServerToClientMessage =
  | SnapshotMessage
  | SceneUpdateMessage
  | CursorMessage
  | PongMessage;

/**
 * Connection status state for the UI status banner:
 * - "idle": waiting for nickname before opening WebSocket
 * - "connecting": «Подключение…»
 * - "connected": active WebSocket session
 * - "offline": «Нет связи, рисуем локально»
 * - "full": «Доска заполнена» (closed with code 1013)
 */
export type ConnectionStatus = "idle" | "connecting" | "connected" | "offline" | "full";

export interface RemoteCursorTarget {
  client_id: string;
  nick: string;
  x: number;
  y: number;
  pointer?: PointerKind;
  tool?: CursorToolKind;
}

export interface InterpolatedCursor {
  clientId: string;
  nick: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  pointer: PointerKind;
  tool: CursorToolKind;
  color: string;
  updatedAt: number;
}

export type ReconcileElementsFn = (
  localElements: readonly ExcalidrawElementLike[],
  remoteElements: readonly ExcalidrawElementLike[],
  localAppState: Record<string, unknown>,
) => ExcalidrawElementLike[];
