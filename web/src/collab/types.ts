export interface ExcalidrawElementLike {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean | undefined;
  updated?: number | undefined;
  index?: string | null | undefined;
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
  client_id?: string | undefined;
  nick?: string | undefined;
  elements: ExcalidrawElementLike[];
}

export interface CursorMessage {
  type: "cursor";
  client_id?: string | undefined;
  nick?: string | undefined;
  x: number;
  y: number;
  pointer?: PointerKind | undefined;
  tool?: CursorToolKind | undefined;
}

export interface PingMessage {
  type: "ping";
}

export interface PongMessage {
  type: "pong";
}

export interface ServerErrorMessage {
  type: "error";
  code: string;
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
  | PongMessage
  | ServerErrorMessage;

/**
 * Connection status state for the UI status banner:
 * - "idle": waiting for nickname before opening WebSocket
 * - "connecting": initial or reconnecting handshake in progress
 * - "connected": active WebSocket session
 * - "offline": disconnected, drawing continues locally
 * - "full": board room is full (closed with code 1013)
 */
export type ConnectionStatus = "idle" | "connecting" | "connected" | "offline" | "full";

export interface RemoteCursorTarget {
  client_id: string;
  nick: string;
  x: number;
  y: number;
  pointer?: PointerKind | undefined;
  tool?: CursorToolKind | undefined;
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
