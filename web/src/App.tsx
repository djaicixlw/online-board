import {
  CaptureUpdateAction,
  Excalidraw,
  reconcileElements as excalidrawReconcileElements,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BoardCollabClient,
  generateBoardId,
  getOrCreateClientId,
  loadSavedNickname,
  MAX_EXCALIDRAW_FILE_BYTES,
  mergeSceneElements,
  parseBoardRoute,
  parseExcalidrawDocument,
  sanitizeNickname,
  saveNickname,
  serializeExcalidrawDocument,
  type CollaboratorInfo,
  type ConnectionStatus,
  type CursorToolKind,
  type ExcalidrawElementLike,
  type InterpolatedCursor,
  type PointerKind,
  type ReconcileElementsFn,
} from "./collab/index.js";
import { RU_LOCALE_CODE, RU_STRINGS } from "./i18n/ru.js";
import { normalizePointerKind, shouldSuppressTouchOrPalmDrawing } from "./input/pen-guard.js";

interface ExcalidrawImperativeAPILike {
  updateScene: (sceneData: {
    elements?: readonly ExcalidrawElementLike[];
    appState?: Record<string, unknown>;
    collaborators?: Map<string, Record<string, unknown>>;
    captureUpdate?: unknown;
  }) => void;
  getSceneElementsIncludingDeleted: () => readonly ExcalidrawElementLike[];
  getAppState: () => Record<string, unknown>;
}

const isDevEnvironment = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);

const wrappedReconcile: ReconcileElementsFn = (localElements, remoteElements, localAppState) => {
  if (typeof excalidrawReconcileElements === "function") {
    try {
      const fn = excalidrawReconcileElements as unknown as (
        local: readonly ExcalidrawElementLike[],
        remote: readonly ExcalidrawElementLike[],
        appState: Record<string, unknown>,
      ) => ExcalidrawElementLike[];
      return fn(localElements, remoteElements, localAppState);
    } catch {
      // Fallback to deterministic version/versionNonce reconciliation
    }
  }
  return [...remoteElements];
};

export function App() {
  const [routeState, setRouteState] = useState(() => parseBoardRoute(window.location.pathname));

  // Only redirect root `/` to a random `/b/<id>` in local development (`import.meta.env.DEV`).
  // In production, `/` displays the prompt to open the board link sent by the teacher (T2.5b section B.9).
  useEffect(() => {
    if (!routeState.matchedRoute && isDevEnvironment) {
      const generatedId = generateBoardId();
      const targetPath = `/b/${generatedId}`;
      window.history.replaceState(null, "", targetPath);
      setRouteState(parseBoardRoute(targetPath));
    }
  }, [routeState.matchedRoute]);

  useEffect(() => {
    const onPopState = () => {
      setRouteState(parseBoardRoute(window.location.pathname));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const boardId = routeState.boardId;

  const [savedNick, setSavedNick] = useState<string | null>(() => loadSavedNickname());
  const initialNickRef = useRef<string | null>(savedNick);
  const [isNickDialogOpen, setIsNickDialogOpen] = useState<boolean>(
    () => loadSavedNickname() === null,
  );
  const [nickDraft, setNickDraft] = useState<string>(() => loadSavedNickname() ?? "");
  const [nickError, setNickError] = useState<string | null>(null);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [collaborators, setCollaborators] = useState<CollaboratorInfo[]>([]);
  const [remoteCursors, setRemoteCursors] = useState<InterpolatedCursor[]>([]);
  const [sceneElementCount, setSceneElementCount] = useState<number>(0);
  // Auto pen mode: starts off (`false`) so finger drawing works by default, automatically activates
  // on the first stylus (`pointerType === "pen"`) contact, and remains manually toggleable (T2.5b section B.10).
  const [penMode, setPenMode] = useState<boolean>(false);
  const penAutoActivatedRef = useRef<boolean>(false);
  const [persistentBoardError, setPersistentBoardError] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const excalidrawApiRef = useRef<ExcalidrawImperativeAPILike | null>(null);
  const latestElementsRef = useRef<readonly ExcalidrawElementLike[]>([]);
  const latestAppStateRef = useRef<Record<string, unknown>>({
    exportEmbedScene: true,
    penMode: false,
    penDetected: false,
    viewBackgroundColor: "#ffffff",
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
  });
  const collabClientRef = useRef<BoardCollabClient | null>(null);
  const activePointerKindRef = useRef<PointerKind>("mouse");
  const isApplyingRemoteRef = useRef<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const applyRemoteScene = useCallback(
    (mergedElements: ExcalidrawElementLike[], nextCollaborators?: CollaboratorInfo[]) => {
      latestElementsRef.current = mergedElements;
      setSceneElementCount(mergedElements.filter((el) => el.isDeleted !== true).length);
      const api = excalidrawApiRef.current;
      if (!api) {
        return;
      }
      isApplyingRemoteRef.current = true;
      try {
        const updatePayload: {
          elements: readonly ExcalidrawElementLike[];
          captureUpdate?: unknown;
        } = {
          elements: mergedElements,
        };
        if (
          CaptureUpdateAction &&
          typeof CaptureUpdateAction === "object" &&
          "NEVER" in CaptureUpdateAction
        ) {
          updatePayload.captureUpdate = (CaptureUpdateAction as { NEVER: unknown }).NEVER;
        }
        api.updateScene(updatePayload);
        if (nextCollaborators) {
          setCollaborators(nextCollaborators);
        }
      } finally {
        isApplyingRemoteRef.current = false;
      }
    },
    [],
  );

  // Initialize BoardCollabClient once per boardId (without savedNick in deps so setting/changing
  // nick never disconnects or recreates the WebSocket — fixing Review #1)
  useEffect(() => {
    if (!boardId) {
      return;
    }

    const clientId = getOrCreateClientId();
    const initialNick = initialNickRef.current;
    const client = new BoardCollabClient({
      boardId,
      clientId,
      nick: initialNick,
      reconcileElements: wrappedReconcile,
      getLocalElements: () => {
        const api = excalidrawApiRef.current;
        if (api && typeof api.getSceneElementsIncludingDeleted === "function") {
          return api.getSceneElementsIncludingDeleted();
        }
        return latestElementsRef.current;
      },
      getLocalAppState: () => {
        const api = excalidrawApiRef.current;
        if (api && typeof api.getAppState === "function") {
          return api.getAppState();
        }
        return latestAppStateRef.current;
      },
      onRemoteSceneApplied: applyRemoteScene,
      onStatusChange: (nextStatus) => setConnectionStatus(nextStatus),
      onCollaboratorsChange: (nextCollabs) => setCollaborators(nextCollabs),
      onRemoteCursorsChange: (cursors) => setRemoteCursors(cursors),
      onServerError: (code) => {
        if (code === "board_not_saved") {
          setPersistentBoardError(RU_STRINGS.boardNotSavedError);
        } else if (code === "board_too_large") {
          setBannerError(RU_STRINGS.boardTooLargeError);
        }
      },
    });

    collabClientRef.current = client;

    if (initialNick) {
      client.connect();
    }

    return () => {
      client.disconnect();
      collabClientRef.current = null;
    };
  }, [boardId, applyRemoteScene]);

  // Smooth 60 FPS cursor interpolation loop that only triggers React state updates when
  // cursors actually move, appear, or expire (fixing Review #5)
  useEffect(() => {
    let rafId = 0;
    let prevTime = performance.now();

    const tick = (nowPerf: number) => {
      const dt = Math.max(0, nowPerf - prevTime);
      prevTime = nowPerf;

      const client = collabClientRef.current;
      if (client) {
        const { cursors, changed, expiredClientIds } = client.cursorInterpolator.stepWithDiff(
          dt,
          Date.now(),
        );
        if (expiredClientIds.length > 0) {
          client.removeExpiredCollaborators(expiredClientIds);
        }
        if (changed) {
          setRemoteCursors(cursors);
        }
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, []);

  const handleNickSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = sanitizeNickname(nickDraft);
    if (!cleaned) {
      setNickError(RU_STRINGS.nickValidationError);
      return;
    }
    saveNickname(cleaned);
    initialNickRef.current = cleaned;
    setNickError(null);
    setSavedNick(cleaned);
    setNickDraft(cleaned);
    setIsNickDialogOpen(false);
    // Connect (if previously idle) or send updated `hello` over the open WebSocket
    collabClientRef.current?.setNick(cleaned);
  };

  const handleOpenNickDialog = () => {
    setNickDraft(savedNick ?? "");
    setNickError(null);
    setIsNickDialogOpen(true);
  };

  const handleTogglePenMode = () => {
    const nextPenMode = !penMode;
    setPenMode(nextPenMode);
    latestAppStateRef.current = {
      ...latestAppStateRef.current,
      penMode: nextPenMode,
    };
    excalidrawApiRef.current?.updateScene({
      appState: {
        penMode: nextPenMode,
      },
    });
  };

  const handleCanvasPointerDownCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    const kind = normalizePointerKind(e.pointerType);
    activePointerKindRef.current = kind;

    if (kind === "pen" && !penAutoActivatedRef.current) {
      penAutoActivatedRef.current = true;
      setPenMode(true);
      latestAppStateRef.current = {
        ...latestAppStateRef.current,
        penMode: true,
        penDetected: true,
      };
      excalidrawApiRef.current?.updateScene({
        appState: { penMode: true, penDetected: true },
      });
    }

    if (
      shouldSuppressTouchOrPalmDrawing(
        {
          pointerType: e.pointerType,
          buttons: e.buttons,
          width: e.width,
          height: e.height,
          isPrimary: e.isPrimary,
          target: e.target,
        },
        penMode,
      )
    ) {
      e.stopPropagation();
    }
  };

  const handleCanvasPointerMoveCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointerKindRef.current = normalizePointerKind(e.pointerType);
    if (
      shouldSuppressTouchOrPalmDrawing(
        {
          pointerType: e.pointerType,
          buttons: e.buttons,
          width: e.width,
          height: e.height,
          isPrimary: e.isPrimary,
          target: e.target,
        },
        penMode,
      )
    ) {
      e.stopPropagation();
    }
  };

  const handleCanvasPointerCancel = () => {
    collabClientRef.current?.flushSceneOnPointerRelease(latestElementsRef.current);
  };

  const handleSaveExcalidrawFile = () => {
    const elements =
      excalidrawApiRef.current?.getSceneElementsIncludingDeleted() ?? latestElementsRef.current;
    const appState = excalidrawApiRef.current?.getAppState() ?? latestAppStateRef.current;
    const bg =
      typeof appState.viewBackgroundColor === "string" ? appState.viewBackgroundColor : "#ffffff";
    const jsonContent = serializeExcalidrawDocument(elements, bg, window.location.origin);
    const blob = new Blob([jsonContent], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `board-${boardId ?? "local"}.excalidraw`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleOpenExcalidrawFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) {
      return;
    }
    if (file.size > MAX_EXCALIDRAW_FILE_BYTES) {
      setBannerError(RU_STRINGS.fileImportError);
      return;
    }
    try {
      const rawText = await file.text();
      const imported = parseExcalidrawDocument(rawText);
      setBannerError(null);

      // Bump imported element versions so they propagate to connected peers
      const nowMs = Date.now();
      const bumpedElements = imported.elements.map((el) => ({
        ...el,
        version: el.version + 1,
        updated: nowMs,
      }));
      const merged = mergeSceneElements(
        latestElementsRef.current,
        bumpedElements,
        latestAppStateRef.current,
        wrappedReconcile,
      );
      latestElementsRef.current = merged;
      setSceneElementCount(merged.filter((el) => el.isDeleted !== true).length);
      excalidrawApiRef.current?.updateScene({
        elements: merged,
        ...(imported.viewBackgroundColor
          ? { appState: { viewBackgroundColor: imported.viewBackgroundColor } }
          : {}),
      });
      collabClientRef.current?.queueSceneUpdate(merged);
      collabClientRef.current?.flushSceneOnPointerRelease(merged);
    } catch {
      setBannerError(RU_STRINGS.fileImportError);
    }
  };

  if (!routeState.matchedRoute) {
    return (
      <main className="board-error-screen" data-testid="prod-root-screen">
        <div className="board-dialog-card">
          <h1 className="board-dialog-title">{RU_STRINGS.openTeacherBoardLinkTitle}</h1>
          <p className="board-dialog-subtitle">{RU_STRINGS.openTeacherBoardLinkDescription}</p>
          {isDevEnvironment && (
            <button
              type="button"
              className="board-btn board-btn-primary"
              onClick={() => {
                const newId = generateBoardId();
                const nextPath = `/b/${newId}`;
                window.history.pushState(null, "", nextPath);
                setRouteState(parseBoardRoute(nextPath));
              }}
            >
              {RU_STRINGS.createNewLocalBoardButton}
            </button>
          )}
        </div>
      </main>
    );
  }

  if (routeState.matchedRoute && !boardId) {
    return (
      <main className="board-error-screen" data-testid="invalid-board-screen">
        <div className="board-dialog-card">
          <h1 className="board-dialog-title">{RU_STRINGS.invalidBoardUrlTitle}</h1>
          <p className="board-dialog-subtitle">
            {isDevEnvironment
              ? RU_STRINGS.invalidBoardUrlDescription
              : RU_STRINGS.openTeacherBoardLinkDescription}
          </p>
          {isDevEnvironment && (
            <button
              type="button"
              className="board-btn board-btn-primary"
              onClick={() => {
                const newId = generateBoardId();
                const nextPath = `/b/${newId}`;
                window.history.pushState(null, "", nextPath);
                setRouteState(parseBoardRoute(nextPath));
              }}
            >
              {RU_STRINGS.createNewLocalBoardButton}
            </button>
          )}
        </div>
      </main>
    );
  }

  const statusText =
    connectionStatus === "connecting"
      ? RU_STRINGS.statusConnecting
      : connectionStatus === "offline"
        ? RU_STRINGS.statusOffline
        : connectionStatus === "full"
          ? RU_STRINGS.statusBoardFull
          : connectionStatus === "connected"
            ? RU_STRINGS.statusConnected
            : null;

  const activeErrorText = persistentBoardError ?? bannerError;

  const appState = latestAppStateRef.current;
  const scrollX = typeof appState.scrollX === "number" ? appState.scrollX : 0;
  const scrollY = typeof appState.scrollY === "number" ? appState.scrollY : 0;
  const zoomObj = appState.zoom as { value?: number } | undefined;
  const zoomValue =
    zoomObj && typeof zoomObj.value === "number" && zoomObj.value > 0 ? zoomObj.value : 1;

  return (
    <main
      className="board-viewport"
      aria-label={RU_STRINGS.canvasAriaLabel}
      data-testid="board-viewport"
      data-scene-elements-count={sceneElementCount}
    >
      {/* Top status bar with connection banner, nickname button, pen mode toggle, and .excalidraw file controls */}
      <header className="board-top-bar" data-testid="board-top-bar">
        {statusText && (
          <div
            className={`board-status-pill board-status-${connectionStatus}`}
            data-testid="connection-status-banner"
            role="status"
            aria-live="polite"
          >
            <span className="board-status-dot" />
            <span>{statusText}</span>
          </div>
        )}

        {savedNick && (
          <button
            type="button"
            className="board-top-chip"
            onClick={handleOpenNickDialog}
            aria-label={RU_STRINGS.changeNickButtonAriaLabel}
            data-testid="change-nick-button"
          >
            {RU_STRINGS.changeNickButtonPrefix} <strong>{savedNick}</strong>
          </button>
        )}

        <button
          type="button"
          className={`board-top-chip ${penMode ? "board-top-chip-active" : ""}`}
          onClick={handleTogglePenMode}
          title={RU_STRINGS.penModeToggleTitle}
          data-testid="pen-mode-toggle"
        >
          {penMode ? RU_STRINGS.penModeActiveLabel : RU_STRINGS.penModeAutoLabel}
        </button>

        <button
          type="button"
          className="board-top-chip"
          onClick={handleSaveExcalidrawFile}
          data-testid="save-excalidraw-button"
        >
          {RU_STRINGS.saveExcalidrawFileButton}
        </button>

        <button
          type="button"
          className="board-top-chip"
          onClick={() => fileInputRef.current?.click()}
          data-testid="open-excalidraw-button"
        >
          {RU_STRINGS.openExcalidrawFileButton}
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept=".excalidraw,application/json"
          className="board-hidden-file-input"
          onChange={handleOpenExcalidrawFileChange}
          data-testid="excalidraw-file-input"
        />

        {collaborators.length > 0 && (
          <span className="board-collab-counter" data-testid="collaborators-counter">
            {RU_STRINGS.collaboratorsCountPrefix} {collaborators.length}
          </span>
        )}
      </header>

      {activeErrorText && (
        <div className="board-toast-error" role="alert" data-testid="board-error-banner">
          {activeErrorText}
        </div>
      )}

      {/* Smooth hardware-accelerated remote collaborator cursors layer */}
      <div className="board-cursors-layer" aria-hidden="true" data-testid="remote-cursors-layer">
        {remoteCursors.map((cursor) => {
          const screenX = (cursor.x + scrollX) * zoomValue;
          const screenY = (cursor.y + scrollY) * zoomValue;
          return (
            <div
              key={cursor.clientId}
              className="board-remote-cursor"
              data-testid={`remote-cursor-${cursor.clientId}`}
              style={{
                transform: `translate3d(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px, 0)`,
              }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill={cursor.color}
                stroke="#ffffff"
                strokeWidth="2"
              >
                <path d="M4 3l16 7-7 2-2 7-7-16z" />
              </svg>
              <span className="board-remote-cursor-nick" style={{ backgroundColor: cursor.color }}>
                {cursor.nick}
              </span>
            </div>
          );
        })}
      </div>

      {/* Canvas wrapper: pointer capture is scoped strictly to the canvas container so UI header and modal buttons are never blocked */}
      <div
        className="board-canvas-container"
        onPointerDownCapture={handleCanvasPointerDownCapture}
        onPointerMoveCapture={handleCanvasPointerMoveCapture}
        onPointerCancelCapture={handleCanvasPointerCancel}
      >
        <Excalidraw
          langCode={RU_LOCALE_CODE}
          excalidrawAPI={(api: unknown) => {
            excalidrawApiRef.current = api as ExcalidrawImperativeAPILike;
          }}
          initialData={{
            appState: {
              exportEmbedScene: true,
              penMode: false,
              penDetected: false,
              viewBackgroundColor: "#ffffff",
            },
          }}
          UIOptions={{
            canvasActions: {
              loadScene: true,
              saveToActiveFile: true,
              export: { saveFileToDisk: true },
              changeViewBackgroundColor: true,
              clearCanvas: true,
              toggleTheme: true,
            },
          }}
          onChange={(elements, currentAppState) => {
            const typedElements = elements as unknown as readonly ExcalidrawElementLike[];
            latestElementsRef.current = typedElements;
            latestAppStateRef.current = currentAppState as unknown as Record<string, unknown>;
            setSceneElementCount(typedElements.filter((el) => el.isDeleted !== true).length);
            if (!isApplyingRemoteRef.current) {
              collabClientRef.current?.queueSceneUpdate(typedElements);
            }
          }}
          onPointerUpdate={(payload: {
            pointer: { x: number; y: number; tool?: CursorToolKind };
            button: "down" | "up";
          }) => {
            const tool: CursorToolKind = payload.pointer.tool === "laser" ? "laser" : "pointer";
            collabClientRef.current?.queueCursorUpdate(
              payload.pointer.x,
              payload.pointer.y,
              activePointerKindRef.current,
              tool,
            );
            if (payload.button === "up") {
              collabClientRef.current?.flushSceneOnPointerRelease(latestElementsRef.current);
            }
          }}
        />
      </div>

      {/* Modal dialog for entering or changing the user's board nickname */}
      {isNickDialogOpen && (
        <div
          className="board-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nick-dialog-title"
          data-testid="nick-dialog"
        >
          <form className="board-dialog-card" onSubmit={handleNickSubmit}>
            <h2 id="nick-dialog-title" className="board-dialog-title">
              {RU_STRINGS.nickDialogTitle}
            </h2>
            <p className="board-dialog-subtitle">{RU_STRINGS.nickDialogSubtitle}</p>
            <label htmlFor="board-nick-input" className="board-input-label">
              {RU_STRINGS.nickInputLabel}
            </label>
            <input
              id="board-nick-input"
              type="text"
              className="board-text-input"
              value={nickDraft}
              onChange={(e) => setNickDraft(e.target.value)}
              placeholder={RU_STRINGS.nickInputPlaceholder}
              maxLength={32}
              autoFocus
              data-testid="nick-input"
            />
            {nickError && (
              <p className="board-input-error" role="alert" data-testid="nick-error">
                {nickError}
              </p>
            )}
            <div className="board-dialog-actions">
              {savedNick && (
                <button
                  type="button"
                  className="board-btn board-btn-secondary"
                  onClick={() => setIsNickDialogOpen(false)}
                >
                  {RU_STRINGS.nickCancelButton}
                </button>
              )}
              <button
                type="submit"
                className="board-btn board-btn-primary"
                data-testid="nick-submit-button"
              >
                {RU_STRINGS.nickSubmitButton}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
