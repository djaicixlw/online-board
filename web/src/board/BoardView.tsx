import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  WelcomeScreen,
  reconcileElements as excalidrawReconcileElements,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BoardCollabClient,
  compressImageFile,
  dataUrlToBlob,
  getOrCreateClientId,
  ImageDownloadManager,
  isFileUploaded,
  loadSavedNickname,
  markFileUploaded,
  MAX_EXCALIDRAW_FILE_BYTES,
  mergeSceneElements,
  parseExcalidrawDocument,
  sanitizeNickname,
  saveNickname,
  serializeExcalidrawDocument,
  uploadBoardFile,
  type CollaboratorInfo,
  type ConnectionStatus,
  type CursorToolKind,
  type ExcalidrawElementLike,
  type InterpolatedCursor,
  type PointerKind,
  type ReconcileElementsFn,
} from "../collab/index.js";
import { RU_LOCALE_CODE, RU_STRINGS } from "../i18n/ru.js";
import { normalizePointerKind, shouldSuppressTouchOrPalmDrawing } from "../input/pen-guard.js";

interface ExcalidrawImperativeAPILike {
  updateScene: (sceneData: {
    elements?: readonly ExcalidrawElementLike[];
    appState?: Record<string, unknown>;
    collaborators?: Map<string, Record<string, unknown>>;
    captureUpdate?: unknown;
  }) => void;
  getSceneElementsIncludingDeleted: () => readonly ExcalidrawElementLike[];
  getAppState: () => Record<string, unknown>;
  getFiles?: () => Record<
    string,
    { id: string; dataURL: string; mimeType: string; created: number }
  >;
  addFiles?: (
    files: Array<{ id: string; dataURL: string; mimeType: string; created: number }>,
  ) => void;
}

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

export default function BoardView({ boardId }: { boardId: string }) {
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
  const downloadManagerRef = useRef<ImageDownloadManager | null>(null);
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

      // T4: Identify remote image elements that are not yet loaded in Excalidraw
      if (api && typeof api.getFiles === "function") {
        const existingFiles = api.getFiles() || {};
        const neededFileIds: string[] = [];
        for (const el of mergedElements) {
          if (!el.isDeleted && el.type === "image" && typeof el.fileId === "string" && el.fileId) {
            if (!existingFiles[el.fileId]) {
              neededFileIds.push(el.fileId);
            }
          }
        }
        if (neededFileIds.length > 0) {
          downloadManagerRef.current?.requestFiles(neededFileIds);
        }
      }
    },
    [],
  );

  // Initialize BoardCollabClient and ImageDownloadManager once per boardId
  useEffect(() => {
    if (!boardId) {
      return;
    }

    downloadManagerRef.current = new ImageDownloadManager(boardId, (file) => {
      excalidrawApiRef.current?.addFiles?.([file]);
    });

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
      downloadManagerRef.current = null;
      client.disconnect();
      collabClientRef.current = null;
    };
  }, [boardId, applyRemoteScene]);

  // Security: eliminate external promotional/tracking links from Excalidraw subtrees
  // and guarantee rel="noopener noreferrer" for any valid external anchors in the DOM
  useEffect(() => {
    const sanitizeAnchors = () => {
      const anchors = document.querySelectorAll<HTMLAnchorElement>("a[href]");
      for (const a of anchors) {
        try {
          const rawHref = a.getAttribute("href") ?? "";
          if (rawHref.startsWith("http://") || rawHref.startsWith("https://")) {
            const parsed = new URL(rawHref, window.location.href);
            if (parsed.origin !== window.location.origin) {
              if (
                parsed.hostname.includes("twitter.com") ||
                parsed.hostname.includes("x.com") ||
                parsed.hostname.includes("discord.gg") ||
                parsed.hostname.includes("plus.excalidraw.com") ||
                parsed.hostname.includes("github.com/excalidraw")
              ) {
                a.remove();
                continue;
              }
              a.rel = "noopener noreferrer";
            }
          }
        } catch {
          // ignore unparseable
        }
      }
    };

    sanitizeAnchors();
    const observer = new MutationObserver(() => {
      sanitizeAnchors();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

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

  const handleGenerateIdForFile = useCallback(
    async (file: File): Promise<string> => {
      try {
        const { fileId, mimeType, arrayBuffer, dataUrl } = await compressImageFile(file);

        // Pre-register compressed dataURL in Excalidraw so local preview renders immediately
        excalidrawApiRef.current?.addFiles?.([
          {
            id: fileId,
            dataURL: dataUrl,
            mimeType,
            created: Date.now(),
          },
        ]);

        // Background upload with retry
        uploadBoardFile(boardId, fileId, mimeType, arrayBuffer, () => {
          setBannerError(RU_STRINGS.imageQuotaExceededError);
        }).catch(() => {
          setBannerError(RU_STRINGS.imageUploadError);
        });

        return fileId;
      } catch (err: unknown) {
        if (err instanceof Error && err.message === "image_too_large") {
          setBannerError(RU_STRINGS.imageTooLargeError);
        } else {
          setBannerError(RU_STRINGS.imageUploadError);
        }
        throw err;
      }
    },
    [boardId],
  );

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

        <a
          href="/teacher"
          className="board-top-chip"
          title={RU_STRINGS.goToTeacherCabinet}
          data-testid="teacher-cabinet-link"
        >
          {RU_STRINGS.teacherCabinetTitle}
        </a>

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
          generateIdForFile={handleGenerateIdForFile}
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
              loadScene: false,
              saveToActiveFile: false,
              export: { saveFileToDisk: true },
              changeViewBackgroundColor: true,
              clearCanvas: true,
              toggleTheme: true,
            },
          }}
          onChange={(elements, currentAppState, files) => {
            const typedElements = elements as unknown as readonly ExcalidrawElementLike[];
            latestElementsRef.current = typedElements;
            latestAppStateRef.current = currentAppState as unknown as Record<string, unknown>;
            setSceneElementCount(typedElements.filter((el) => el.isDeleted !== true).length);
            if (!isApplyingRemoteRef.current) {
              collabClientRef.current?.queueSceneUpdate(typedElements);
            }

            // T4: Upload any newly added files (e.g. from paste or drop)
            if (files) {
              for (const [fId, fileObj] of Object.entries(files)) {
                if (
                  /^[0-9a-f]{40}$/.test(fId) &&
                  !isFileUploaded(fId) &&
                  fileObj &&
                  typeof fileObj.dataURL === "string"
                ) {
                  markFileUploaded(fId);
                  try {
                    const blob = dataUrlToBlob(fileObj.dataURL);
                    blob
                      .arrayBuffer()
                      .then((buf) => {
                        uploadBoardFile(boardId, fId, fileObj.mimeType || "image/webp", buf, () => {
                          setBannerError(RU_STRINGS.imageQuotaExceededError);
                        }).catch(() => {
                          setBannerError(RU_STRINGS.imageUploadError);
                        });
                      })
                      .catch(() => {});
                  } catch {
                    // ignore malformed data url
                  }
                }
              }
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
        >
          <MainMenu>
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.DefaultItems.ToggleTheme />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
          <WelcomeScreen>
            <WelcomeScreen.Center>
              <WelcomeScreen.Center.Heading>{RU_STRINGS.appTitle}</WelcomeScreen.Center.Heading>
            </WelcomeScreen.Center>
          </WelcomeScreen>
        </Excalidraw>
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
