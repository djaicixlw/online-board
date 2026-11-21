import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  WelcomeScreen,
  reconcileElements as excalidrawReconcileElements,
  restoreElements,
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
  MAX_EXCALIDRAW_FILE_BYTES,
  mergeSceneElements,
  parseExcalidrawDocument,
  pickCollaboratorColor,
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
  type ViewportSyncMessage,
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
  const safeLocal = restoreElements(
    localElements as unknown as Parameters<typeof restoreElements>[0],
    null,
  );
  const safeRemote = restoreElements(
    remoteElements as unknown as Parameters<typeof restoreElements>[0],
    null,
  );
  let reconciled: ExcalidrawElementLike[];
  if (typeof excalidrawReconcileElements === "function") {
    try {
      const fn = excalidrawReconcileElements as unknown as (
        local: readonly ExcalidrawElementLike[],
        remote: readonly ExcalidrawElementLike[],
        appState: Record<string, unknown>,
      ) => ExcalidrawElementLike[];
      const res = fn(safeLocal, safeRemote, localAppState);
      if (Array.isArray(res) && res.length >= Math.max(safeLocal.length, safeRemote.length)) {
        reconciled = res;
      } else {
        reconciled = mergeSceneElements(safeLocal, safeRemote, localAppState);
      }
    } catch {
      reconciled = mergeSceneElements(safeLocal, safeRemote, localAppState);
    }
  } else {
    reconciled = mergeSceneElements(safeLocal, safeRemote, localAppState);
  }

  // T5 Part B: Preserve local in-progress text editing element against remote overwrites
  const editing = localAppState?.editingTextElement as
    (ExcalidrawElementLike & { text?: string; originalText?: string }) | null | undefined;
  if (editing && editing.id) {
    const localEditing = (safeLocal.find((el) => el.id === editing.id) || editing) as
      (ExcalidrawElementLike & { text?: string; originalText?: string }) | undefined;
    reconciled = reconciled.map((el) => {
      if (el.id === editing.id) {
        return {
          ...el,
          ...localEditing,
          text: editing.text ?? localEditing?.text ?? (el as { text?: string }).text ?? "",
          originalText:
            editing.originalText ??
            localEditing?.originalText ??
            (el as { originalText?: string }).originalText ??
            "",
          version: Math.max(el.version, localEditing?.version ?? 0, editing.version ?? 0),
        };
      }
      return el;
    });
  }

  return reconciled;
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

  // T5.1: Follow Mode & off-screen indicators
  const [isLeading, setIsLeading] = useState<boolean>(false);
  const isLeadingRef = useRef<boolean>(false);
  isLeadingRef.current = isLeading;

  const [followingLeader, setFollowingLeader] = useState<{ leaderId: string; nick: string } | null>(
    null,
  );
  const [isDetached, setIsDetached] = useState<boolean>(false);
  const isDetachedRef = useRef<boolean>(false);
  isDetachedRef.current = isDetached;

  const [isCollabDropdownOpen, setIsCollabDropdownOpen] = useState<boolean>(false);
  const previousEditingTextIdRef = useRef<string | null>(null);
  const lastViewportBroadcastRef = useRef<number>(0);
  const isApplyingFollowerSyncRef = useRef<boolean>(false);

  const excalidrawApiRef = useRef<ExcalidrawImperativeAPILike | null>(null);
  const latestElementsRef = useRef<readonly ExcalidrawElementLike[]>([]);
  const latestAppStateRef = useRef<Record<string, unknown>>({
    exportEmbedScene: true,
    penMode: false,
    penDetected: false,
    viewBackgroundColor: "transparent",
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
  });
  const collabClientRef = useRef<BoardCollabClient | null>(null);
  const downloadManagerRef = useRef<ImageDownloadManager | null>(null);
  const activePointerKindRef = useRef<PointerKind>("mouse");
  const isApplyingRemoteRef = useRef<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleJumpToUser = useCallback((targetX: number, targetY: number) => {
    const container = document.querySelector(".board-canvas-container");
    const rect = container?.getBoundingClientRect();
    const width = rect?.width ?? window.innerWidth;
    const height = rect?.height ?? window.innerHeight;
    const appState = latestAppStateRef.current;
    const zoomObj = appState.zoom as { value?: number } | undefined;
    const curZoom =
      zoomObj && typeof zoomObj.value === "number" && zoomObj.value > 0 ? zoomObj.value : 1;

    const newScrollX = width / 2 / curZoom - targetX;
    const newScrollY = height / 2 / curZoom - targetY;

    excalidrawApiRef.current?.updateScene({
      appState: {
        scrollX: newScrollX,
        scrollY: newScrollY,
      },
    });
    latestAppStateRef.current = {
      ...latestAppStateRef.current,
      scrollX: newScrollX,
      scrollY: newScrollY,
    };
  }, []);

  const handleRemoteViewportSync = useCallback((msg: ViewportSyncMessage) => {
    if (isLeadingRef.current) {
      return;
    }
    if (msg.active && msg.leader_id && msg.nick) {
      const leaderId = msg.leader_id;
      const leaderNick = msg.nick;
      setFollowingLeader((prev) => {
        if (!prev || prev.leaderId !== leaderId) {
          setIsDetached(false);
          return { leaderId, nick: leaderNick };
        }
        return prev;
      });

      if (!isDetachedRef.current) {
        isApplyingFollowerSyncRef.current = true;
        try {
          excalidrawApiRef.current?.updateScene({
            appState: {
              scrollX: msg.scrollX,
              scrollY: msg.scrollY,
              zoom: { value: msg.zoom },
            },
          });
          latestAppStateRef.current = {
            ...latestAppStateRef.current,
            scrollX: msg.scrollX,
            scrollY: msg.scrollY,
            zoom: { value: msg.zoom },
          };
        } finally {
          setTimeout(() => {
            isApplyingFollowerSyncRef.current = false;
          }, 50);
        }
      }
    } else if (msg.leader_id) {
      const leaderId = msg.leader_id;
      setFollowingLeader((prev) => {
        if (prev && prev.leaderId === leaderId) {
          setIsDetached(false);
          return null;
        }
        return prev;
      });
    }
  }, []);

  const applyRemoteScene = useCallback(
    (mergedElements: ExcalidrawElementLike[], nextCollaborators?: CollaboratorInfo[]) => {
      const restored = restoreElements(
        mergedElements as unknown as Parameters<typeof restoreElements>[0],
        null,
      );
      latestElementsRef.current = restored;
      setSceneElementCount(restored.filter((el) => el.isDeleted !== true).length);
      const api = excalidrawApiRef.current;
      if (!api) {
        // Even if api is not yet mounted, request missing files in the background
        const neededFileIds: string[] = [];
        for (const el of restored) {
          if (!el.isDeleted && el.type === "image" && typeof el.fileId === "string" && el.fileId) {
            neededFileIds.push(el.fileId);
          }
        }
        if (neededFileIds.length > 0) {
          downloadManagerRef.current?.requestFiles(neededFileIds);
        }
        return;
      }
      isApplyingRemoteRef.current = true;
      try {
        // T5 Part B: Preserve local in-progress text editing element during remote patch application without artificial version bumps
        const currentAppState = api.getAppState?.();
        const editing = currentAppState?.editingTextElement as
          (ExcalidrawElementLike & { text?: string; originalText?: string }) | null | undefined;

        let finalElements = restored;
        if (editing && editing.id) {
          finalElements = restored.map((el) => {
            if (el.id === editing.id) {
              return {
                ...el,
                text: editing.text ?? (el as { text?: string }).text ?? "",
                originalText:
                  editing.originalText ?? (el as { originalText?: string }).originalText ?? "",
                version: Math.max(el.version, editing.version ?? 0),
              };
            }
            return el;
          });
        }
        latestElementsRef.current = finalElements;

        const updatePayload: {
          elements: readonly ExcalidrawElementLike[];
          captureUpdate?: unknown;
        } = {
          elements: finalElements,
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
      const existingFiles = api.getFiles?.() || {};
      const neededFileIds: string[] = [];
      for (const el of restored) {
        if (!el.isDeleted && el.type === "image" && typeof el.fileId === "string" && el.fileId) {
          if (!existingFiles[el.fileId]) {
            neededFileIds.push(el.fileId);
          }
        }
      }
      if (neededFileIds.length > 0) {
        downloadManagerRef.current?.requestFiles(neededFileIds);
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
      const api = excalidrawApiRef.current;
      if (api) {
        api.addFiles?.([file]);
        api.updateScene({ elements: api.getSceneElementsIncludingDeleted() });
      }
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
      onFileUploaded: (fileId) => {
        downloadManagerRef.current?.onFileUploaded(fileId);
      },
      onViewportSync: (msg) => {
        handleRemoteViewportSync(msg);
      },
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
      downloadManagerRef.current?.dispose();
      downloadManagerRef.current = null;
      client.disconnect();
      collabClientRef.current = null;
    };
  }, [boardId, applyRemoteScene, handleRemoteViewportSync]);

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

  // T5.1: Native mouse wheel zoom without requiring Ctrl key
  useEffect(() => {
    const container = document.querySelector(".board-canvas-container");
    if (!container) {
      return;
    }

    const handleWheel = (e: WheelEvent) => {
      // If ctrl, meta, shift, or alt is already pressed, let Excalidraw's built-in handlers process it
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
        return;
      }
      // Re-dispatch as a synthetic WheelEvent with ctrlKey: true to invoke Excalidraw's built-in cursor-centric zoom
      e.preventDefault();
      e.stopPropagation();

      const syntheticWheel = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaZ: e.deltaZ,
        deltaMode: e.deltaMode,
        ctrlKey: true,
      });

      e.target?.dispatchEvent(syntheticWheel);
    };

    container.addEventListener("wheel", handleWheel as EventListener, {
      passive: false,
      capture: true,
    });
    return () => {
      container.removeEventListener("wheel", handleWheel as EventListener, {
        capture: true,
      });
    };
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

        // Background upload with retry and WebSocket notification on success
        uploadBoardFile(boardId, fileId, mimeType, arrayBuffer, () => {
          setBannerError(RU_STRINGS.imageQuotaExceededError);
        })
          .then((uploaded) => {
            if (uploaded) {
              collabClientRef.current?.sendFileUploaded(fileId);
            }
          })
          .catch(() => {
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

  const insertImageFile = useCallback(
    async (file: File | Blob, clientX?: number, clientY?: number) => {
      try {
        const { fileId, mimeType, arrayBuffer, dataUrl, width, height } =
          await compressImageFile(file);
        const api = excalidrawApiRef.current;
        if (!api) {
          return;
        }

        api.addFiles?.([
          {
            id: fileId,
            dataURL: dataUrl,
            mimeType,
            created: Date.now(),
          },
        ]);

        const currentAppState = latestAppStateRef.current || {};
        const curScrollX =
          typeof currentAppState.scrollX === "number" ? currentAppState.scrollX : 0;
        const curScrollY =
          typeof currentAppState.scrollY === "number" ? currentAppState.scrollY : 0;
        const zoomObj = currentAppState.zoom as { value?: number } | undefined;
        const curZoom =
          zoomObj && typeof zoomObj.value === "number" && zoomObj.value > 0 ? zoomObj.value : 1;

        let posX = -curScrollX + 200;
        let posY = -curScrollY + 200;

        if (typeof clientX === "number" && typeof clientY === "number") {
          const container = document.querySelector(".board-canvas-container");
          const rect = container?.getBoundingClientRect();
          if (rect) {
            posX = (clientX - rect.left - curScrollX) / curZoom;
            posY = (clientY - rect.top - curScrollY) / curZoom;
          }
        }

        const rawImage = {
          type: "image" as const,
          id: Math.random().toString(36).substring(2, 11),
          fileId,
          status: "saved" as const,
          scale: [1, 1] as [number, number],
          x: posX,
          y: posY,
          width,
          height,
          angle: 0,
          strokeColor: "transparent",
          backgroundColor: "transparent",
          fillStyle: "solid",
          strokeWidth: 1,
          strokeStyle: "solid",
          roughness: 1,
          opacity: 100,
          groupIds: [],
          frameId: null,
          roundness: null,
          seed: Math.floor(Math.random() * 100000),
          version: 1,
          versionNonce: Math.floor(Math.random() * 100000),
          isDeleted: false,
          boundElements: null,
          updated: Date.now(),
          link: null,
          locked: false,
        };

        const restoredList = restoreElements(
          [rawImage as unknown as NonNullable<Parameters<typeof restoreElements>[0]>[number]],
          null,
        );
        const imageElement = restoredList[0] as unknown as ExcalidrawElementLike;
        const current = (latestElementsRef.current || []) as ExcalidrawElementLike[];
        const nextElements = [...current, imageElement];

        latestElementsRef.current = nextElements;
        setSceneElementCount(nextElements.filter((el) => !el.isDeleted).length);
        api.updateScene({ elements: nextElements });
        collabClientRef.current?.queueSceneUpdate(nextElements);
        collabClientRef.current?.flushSceneOnPointerRelease(nextElements);

        uploadBoardFile(boardId, fileId, mimeType, arrayBuffer, () => {
          setBannerError(RU_STRINGS.imageQuotaExceededError);
        })
          .then((uploaded) => {
            if (uploaded) {
              collabClientRef.current?.sendFileUploaded(fileId);
            }
          })
          .catch(() => {
            setBannerError(RU_STRINGS.imageUploadError);
          });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === "image_too_large") {
          setBannerError(RU_STRINGS.imageTooLargeError);
        } else {
          setBannerError(RU_STRINGS.imageUploadError);
        }
      }
    },
    [boardId],
  );

  useEffect(() => {
    const handleWindowPaste = (e: ClipboardEvent) => {
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
        return;
      }
      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item && item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) {
              e.preventDefault();
              e.stopPropagation();
              insertImageFile(file);
              return;
            }
          }
        }
      }
      const files = e.clipboardData?.files;
      if (files && files.length > 0) {
        const file = files[0];
        if (file && file.type.startsWith("image/")) {
          e.preventDefault();
          e.stopPropagation();
          insertImageFile(file);
        }
      }
    };

    window.addEventListener("paste", handleWindowPaste, { capture: true });
    return () => {
      window.removeEventListener("paste", handleWindowPaste, { capture: true });
    };
  }, [insertImageFile]);

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
        <div className="board-top-bar-left">
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

          {collaborators.length > 0 && (
            <div className="board-collab-dropdown-wrapper">
              <button
                type="button"
                className="board-top-chip"
                onClick={() => setIsCollabDropdownOpen((open) => !open)}
                data-testid="collaborators-counter"
                aria-haspopup="true"
                aria-expanded={isCollabDropdownOpen}
              >
                {RU_STRINGS.collaboratorsCountPrefix} {collaborators.length}
              </button>
              {isCollabDropdownOpen && (
                <div className="board-collab-dropdown-menu" data-testid="collaborators-dropdown">
                  {collaborators.map((c) => {
                    const cursor = remoteCursors.find((rc) => rc.clientId === c.client_id);
                    const userColor = cursor?.color ?? pickCollaboratorColor(c.client_id);
                    return (
                      <button
                        key={c.client_id}
                        type="button"
                        className="board-collab-item"
                        onClick={() => {
                          if (cursor) {
                            handleJumpToUser(cursor.x, cursor.y);
                          }
                          setIsCollabDropdownOpen(false);
                        }}
                      >
                        <span style={{ color: userColor, fontWeight: 600 }}>{c.nick}</span>
                        {cursor && (
                          <span style={{ fontSize: 11, color: "#64748b" }}>
                            {RU_STRINGS.jumpToUserPrefix}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="board-top-bar-right">
          <button
            type="button"
            className={`board-top-chip ${isLeading ? "board-top-chip-active" : ""}`}
            onClick={() => {
              const nextLeading = !isLeading;
              setIsLeading(nextLeading);
              const sX = typeof scrollX === "number" ? scrollX : 0;
              const sY = typeof scrollY === "number" ? scrollY : 0;
              collabClientRef.current?.sendViewportSync(nextLeading, sX, sY, zoomValue);
            }}
            data-testid="follow-mode-toggle"
            title={isLeading ? RU_STRINGS.followModeToggleOff : RU_STRINGS.followModeToggleOn}
          >
            {isLeading ? RU_STRINGS.followModeToggleOff : RU_STRINGS.followModeToggleOn}
          </button>
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
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".excalidraw,application/json"
          className="board-hidden-file-input"
          onChange={handleOpenExcalidrawFileChange}
          data-testid="excalidraw-file-input"
        />
      </header>

      {activeErrorText && (
        <div className="board-toast-error" role="alert" data-testid="board-error-banner">
          {activeErrorText}
        </div>
      )}

      {/* T5.1: Follow Mode active banner */}
      {followingLeader && !isDetached && (
        <div className="board-follow-banner" data-testid="follow-mode-banner">
          <span>
            {RU_STRINGS.followModeBanner} <strong>{followingLeader.nick}</strong>
          </span>
          <button
            type="button"
            className="board-follow-detach-btn"
            onClick={() => setIsDetached(true)}
            data-testid="follow-mode-detach-btn"
          >
            {RU_STRINGS.followModeDetach}
          </button>
        </div>
      )}

      {/* T5.1: Canvas navigation hint */}
      <div className="board-canvas-hint" data-testid="board-canvas-hint">
        {RU_STRINGS.canvasHint}
      </div>

      {/* Canvas wrapper: pointer capture is scoped strictly to the canvas container so UI header and modal buttons are never blocked */}
      <div
        className="board-canvas-container"
        onPointerDownCapture={handleCanvasPointerDownCapture}
        onPointerMoveCapture={handleCanvasPointerMoveCapture}
        onPointerCancelCapture={handleCanvasPointerCancel}
        onPasteCapture={(e) => {
          const items = e.clipboardData?.items;
          if (items) {
            for (let i = 0; i < items.length; i++) {
              const item = items[i];
              if (item && item.type.startsWith("image/")) {
                const file = item.getAsFile();
                if (file) {
                  e.preventDefault();
                  e.stopPropagation();
                  insertImageFile(file);
                  return;
                }
              }
            }
          }
          const files = e.clipboardData?.files;
          if (files && files.length > 0) {
            const file = files[0];
            if (file && file.type.startsWith("image/")) {
              e.preventDefault();
              e.stopPropagation();
              insertImageFile(file);
            }
          }
        }}
        onDragOverCapture={(e) => {
          if (e.dataTransfer?.types?.includes("Files")) {
            e.preventDefault();
          }
        }}
        onDropCapture={(e) => {
          const files = e.dataTransfer?.files;
          if (files && files.length > 0) {
            const file = files[0];
            if (file && file.type.startsWith("image/")) {
              e.preventDefault();
              e.stopPropagation();
              insertImageFile(file, e.clientX, e.clientY);
            }
          }
        }}
      >
        {/* T5.1: Visual grid background synchronized with canvas pan and zoom without rigid snapping */}
        <div
          className="board-visual-grid"
          aria-hidden="true"
          data-testid="board-visual-grid"
          style={{
            backgroundPosition: `${((scrollX % (20 * zoomValue)) + 20 * zoomValue) % (20 * zoomValue)}px ${((scrollY % (20 * zoomValue)) + 20 * zoomValue) % (20 * zoomValue)}px`,
            backgroundSize: `${20 * zoomValue}px ${20 * zoomValue}px`,
          }}
        />

        {/* T5.1: Off-screen collaborator indicators layer */}
        <div
          className="board-offscreen-indicators-layer"
          aria-hidden="true"
          data-testid="offscreen-indicators-layer"
        >
          {remoteCursors.map((cursor) => {
            const sX = (cursor.x + scrollX) * zoomValue;
            const sY = (cursor.y + scrollY) * zoomValue;
            const w = typeof window !== "undefined" ? window.innerWidth : 1200;
            const h = typeof window !== "undefined" ? window.innerHeight : 800;
            const padding = 40;

            const isOffscreen = sX < 0 || sX > w || sY < 0 || sY > h;
            if (!isOffscreen) {
              return null;
            }

            const clampedX = Math.max(padding, Math.min(w - padding, sX));
            const clampedY = Math.max(padding, Math.min(h - padding, sY));

            let arrow = "→";
            if (sX < 0 && sY < 0) arrow = "↖";
            else if (sX > w && sY < 0) arrow = "↗";
            else if (sX < 0 && sY > h) arrow = "↙";
            else if (sX > w && sY > h) arrow = "↘";
            else if (sX < 0) arrow = "←";
            else if (sX > w) arrow = "→";
            else if (sY < 0) arrow = "↑";
            else if (sY > h) arrow = "↓";

            return (
              <button
                key={`offscreen-${cursor.clientId}`}
                type="button"
                className="board-offscreen-indicator"
                style={{
                  left: `${clampedX}px`,
                  top: `${clampedY}px`,
                  backgroundColor: cursor.color,
                }}
                onClick={() => handleJumpToUser(cursor.x, cursor.y)}
                data-testid={`offscreen-indicator-${cursor.clientId}`}
                title={`${RU_STRINGS.jumpToUserPrefix} ${cursor.nick}`}
              >
                <span>{arrow}</span>
                <span>{cursor.nick}</span>
              </button>
            );
          })}
        </div>

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
                <span
                  className="board-remote-cursor-nick"
                  style={{ backgroundColor: cursor.color }}
                >
                  {cursor.nick}
                </span>
              </div>
            );
          })}
        </div>
        <Excalidraw
          langCode={RU_LOCALE_CODE}
          generateIdForFile={handleGenerateIdForFile}
          excalidrawAPI={(api: unknown) => {
            const typedApi = api as ExcalidrawImperativeAPILike;
            excalidrawApiRef.current = typedApi;

            // T5.1: Smooth free drawing with smart object snapping (no rigid grid snap)
            typedApi.updateScene({
              appState: {
                gridModeEnabled: false,
                objectsSnapModeEnabled: true,
                viewBackgroundColor: "transparent",
              },
            });

            if (latestElementsRef.current && latestElementsRef.current.length > 0) {
              const safeElements = restoreElements(
                latestElementsRef.current as unknown as Parameters<typeof restoreElements>[0],
                null,
              );
              typedApi.updateScene({ elements: safeElements });

              // Check for image elements needing download on initial mount
              const existingFiles = typedApi.getFiles?.() || {};
              const needed: string[] = [];
              for (const el of safeElements) {
                if (
                  !el.isDeleted &&
                  el.type === "image" &&
                  typeof el.fileId === "string" &&
                  el.fileId
                ) {
                  if (!existingFiles[el.fileId]) {
                    needed.push(el.fileId);
                  }
                }
              }
              if (needed.length > 0) {
                downloadManagerRef.current?.requestFiles(needed);
              }
            }
          }}
          initialData={{
            appState: {
              exportEmbedScene: true,
              penMode: false,
              penDetected: false,
              viewBackgroundColor: "transparent",
              gridModeEnabled: false,
              objectsSnapModeEnabled: true,
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
            let typedElements = elements as unknown as readonly ExcalidrawElementLike[];

            // T5 Part B: Protect images from eraser tool while allowing selection + Delete
            const activeToolType = (
              currentAppState as { activeTool?: { type?: string } } | undefined
            )?.activeTool?.type;
            if (activeToolType === "eraser") {
              let hasErasedImage = false;
              const protectedElements = typedElements.map((el) => {
                if (el.type === "image" && el.isDeleted) {
                  hasErasedImage = true;
                  return {
                    ...el,
                    isDeleted: false,
                    opacity: el.opacity ?? 100,
                  };
                }
                return el;
              });
              if (hasErasedImage) {
                typedElements = protectedElements;
                excalidrawApiRef.current?.updateScene({
                  elements: protectedElements,
                });
              }
            }

            // T5.1: Detect when user finishes editing text (blur/commit) and ensure immediate propagation
            const curEditing = (
              currentAppState as { editingTextElement?: { id?: string } } | undefined
            )?.editingTextElement;
            const currentEditingTextId = curEditing?.id ?? null;
            const wasEditingTextId = previousEditingTextIdRef.current;
            previousEditingTextIdRef.current = currentEditingTextId;

            if (wasEditingTextId && !currentEditingTextId) {
              typedElements = typedElements.map((el) => {
                if (el.id === wasEditingTextId) {
                  return {
                    ...el,
                    version: el.version + 1,
                    versionNonce: Math.floor(Math.random() * 1000000),
                    updated: Date.now(),
                  };
                }
                return el;
              });
              latestElementsRef.current = typedElements;
              collabClientRef.current?.queueSceneUpdate(typedElements);
              collabClientRef.current?.flushSceneOnPointerRelease(typedElements);
            }

            // T5.1: If follower manually moves or zooms the viewport, detach from the leader
            if (followingLeader && !isDetachedRef.current && !isApplyingFollowerSyncRef.current) {
              const curAppState = currentAppState as unknown as Record<string, unknown>;
              const prevAppState = latestAppStateRef.current;
              if (
                curAppState.scrollX !== prevAppState.scrollX ||
                curAppState.scrollY !== prevAppState.scrollY ||
                (curAppState.zoom as { value?: number } | undefined)?.value !==
                  (prevAppState.zoom as { value?: number } | undefined)?.value
              ) {
                setIsDetached(true);
              }
            }

            // T5.1: If current user is leading, broadcast viewport updates (~15 Hz)
            if (isLeadingRef.current) {
              const nowMs = Date.now();
              if (nowMs - lastViewportBroadcastRef.current >= 66) {
                lastViewportBroadcastRef.current = nowMs;
                const curAppState = currentAppState as unknown as Record<string, unknown>;
                const sX = typeof curAppState.scrollX === "number" ? curAppState.scrollX : 0;
                const sY = typeof curAppState.scrollY === "number" ? curAppState.scrollY : 0;
                const zObj = curAppState.zoom as { value?: number } | undefined;
                const zVal =
                  zObj && typeof zObj.value === "number" && zObj.value > 0 ? zObj.value : 1;
                collabClientRef.current?.sendViewportSync(true, sX, sY, zVal);
              }
            }

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
                  try {
                    const blob = dataUrlToBlob(fileObj.dataURL);
                    blob
                      .arrayBuffer()
                      .then((buf) => {
                        uploadBoardFile(boardId, fId, fileObj.mimeType || "image/webp", buf, () => {
                          setBannerError(RU_STRINGS.imageQuotaExceededError);
                        })
                          .then((uploaded) => {
                            if (uploaded) {
                              collabClientRef.current?.sendFileUploaded(fId);
                            }
                          })
                          .catch(() => {
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
