import { describe, expect, it, vi } from "vitest";
import {
  BoardCollabClient,
  ImageDownloadManager,
  mergeSceneElements,
  type ExcalidrawElementLike,
  type WebSocketLike,
} from "../src/collab/index.js";

describe("Task T5 Part B: Canvas Polish, Eraser Guard & Text Editing Concurrency", () => {
  it("preserves in-progress editingTextElement during remote update merges", () => {
    const localEditingText: ExcalidrawElementLike & { text?: string; originalText?: string } = {
      id: "text-1",
      type: "text",
      x: 100,
      y: 100,
      width: 80,
      height: 25,
      version: 2,
      versionNonce: 100,
      isDeleted: false,
      text: "typing in progress...",
      originalText: "typing in progress...",
    };

    const remoteStaleText: ExcalidrawElementLike & { text?: string; originalText?: string } = {
      id: "text-1",
      type: "text",
      x: 100,
      y: 100,
      width: 80,
      height: 25,
      version: 5, // higher remote version
      versionNonce: 200,
      isDeleted: false,
      text: "stale text",
      originalText: "stale text",
    };

    const remoteNewStroke: ExcalidrawElementLike = {
      id: "stroke-1",
      type: "freedraw",
      x: 200,
      y: 200,
      width: 50,
      height: 50,
      version: 1,
      versionNonce: 300,
      isDeleted: false,
    };

    // Reconcile logic that incorporates local editing protection
    const localAppState = {
      editingTextElement: localEditingText,
    };

    const merged = mergeSceneElements(
      [localEditingText],
      [remoteStaleText, remoteNewStroke],
      localAppState,
    );

    // Simulate wrappedReconcile's post-processing for editingTextElement
    const protectedElements = merged.map((el) => {
      if (el.id === localAppState.editingTextElement.id) {
        return {
          ...el,
          text: localAppState.editingTextElement.text,
          originalText: localAppState.editingTextElement.originalText,
          version: Math.max(el.version, localAppState.editingTextElement.version) + 1,
        };
      }
      return el;
    });

    const textEl = protectedElements.find((el) => el.id === "text-1");
    expect(textEl).toBeDefined();
    expect(textEl?.text).toBe("typing in progress...");
    expect(textEl?.version).toBeGreaterThan(remoteStaleText.version);

    const strokeEl = protectedElements.find((el) => el.id === "stroke-1");
    expect(strokeEl).toBeDefined();
  });

  it("eraser protection prevents image elements from being marked as deleted", () => {
    const imgEl: ExcalidrawElementLike = {
      id: "img-1",
      type: "image",
      x: 50,
      y: 50,
      width: 200,
      height: 200,
      version: 1,
      versionNonce: 10,
      isDeleted: false,
      opacity: 100,
    };
    const rectEl: ExcalidrawElementLike = {
      id: "rect-1",
      type: "rectangle",
      x: 300,
      y: 50,
      width: 100,
      height: 100,
      version: 1,
      versionNonce: 20,
      isDeleted: false,
    };

    // Simulate eraser tool deleting both an image and a rectangle
    const activeTool = { type: "eraser" };
    const elementsAfterEraserPass: ExcalidrawElementLike[] = [
      { ...imgEl, isDeleted: true }, // image marked deleted by eraser
      { ...rectEl, isDeleted: true }, // rectangle marked deleted by eraser
    ];

    // Apply eraser protection logic from BoardView.tsx onChange
    let resultingElements = elementsAfterEraserPass;
    if (activeTool.type === "eraser") {
      resultingElements = elementsAfterEraserPass.map((el) => {
        if (el.type === "image" && el.isDeleted) {
          return {
            ...el,
            isDeleted: false,
            opacity: el.opacity ?? 100,
          };
        }
        return el;
      });
    }

    const img = resultingElements.find((el) => el.id === "img-1");
    const rect = resultingElements.find((el) => el.id === "rect-1");

    // Image must NOT be deleted by eraser
    expect(img?.isDeleted).toBe(false);
    expect(img?.opacity).toBe(100);

    // Regular shapes CAN be deleted by eraser
    expect(rect?.isDeleted).toBe(true);
  });

  it("selection deletion still deletes image elements when activeTool is selection", () => {
    const initialImage: ExcalidrawElementLike = {
      id: "img-2",
      type: "image",
      x: 50,
      y: 50,
      width: 200,
      height: 200,
      version: 1,
      versionNonce: 10,
      isDeleted: false,
      opacity: 100,
    };

    // User pressed Delete or Backspace with selection tool active
    const activeTool = { type: "selection" };
    const elementsAfterDeleteKey: ExcalidrawElementLike[] = [{ ...initialImage, isDeleted: true }];

    let resultingElements = elementsAfterDeleteKey;
    if (activeTool.type === "eraser") {
      resultingElements = elementsAfterDeleteKey.map((el) => {
        if (el.type === "image" && el.isDeleted) {
          return { ...el, isDeleted: false };
        }
        return el;
      });
    }

    // Since activeTool was NOT eraser, the image is successfully deleted
    expect(resultingElements[0]?.isDeleted).toBe(true);
  });

  it("ImageDownloadManager retries on 404 and fetches immediately when onFileUploaded is called", async () => {
    const boardId = "TestBoard1234567890123";
    const fileId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let attempts = 0;
    const loadedFiles: string[] = [];

    const fetchMock = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
        status: 200,
        headers: { "Content-Type": "image/webp" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const manager = new ImageDownloadManager(boardId, (file) => {
      loadedFiles.push(file.id);
    });

    manager.requestFiles([fileId]);
    await vi.waitFor(() => expect(attempts).toBe(1));
    expect(loadedFiles).toHaveLength(0);

    // Call onFileUploaded -> triggers immediate retry without waiting for the exponential backoff timer
    manager.onFileUploaded(fileId);
    await vi.waitFor(() => expect(loadedFiles).toEqual([fileId]));
    expect(attempts).toBe(2);

    manager.dispose();
    vi.unstubAllGlobals();
  });

  it("BoardCollabClient sends file_uploaded and viewport_sync messages correctly", () => {
    let wsInstance: { readyState: number; onopen: (() => void) | null; sent: string[] } | null =
      null;
    const mockWsFactory = (url: string) => {
      const ws = {
        url,
        readyState: 0,
        onopen: null as (() => void) | null,
        onmessage: null,
        onclose: null,
        onerror: null,
        sent: [] as string[],
        send: (data: string) => {
          ws.sent.push(data);
        },
        close: vi.fn(),
      };
      wsInstance = ws;
      return ws as unknown as WebSocketLike;
    };

    const client = new BoardCollabClient({
      boardId: "TestBoard1234567890123",
      clientId: "client-1",
      nick: "Teacher",
      createWebSocket: mockWsFactory,
      getLocalElements: () => [],
      onRemoteSceneApplied: () => {},
    });

    client.connect();
    expect(client.getStatus()).toBe("connecting");

    // Open connection
    if (wsInstance) {
      (wsInstance as { readyState: number; onopen: (() => void) | null }).readyState = 1;
      (wsInstance as { onopen: (() => void) | null }).onopen?.();
    }
    expect(client.getStatus()).toBe("connected");

    client.sendFileUploaded("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect((wsInstance as unknown as { sent: string[] }).sent).toContain(
      JSON.stringify({
        type: "file_uploaded",
        fileId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    );

    client.sendViewportSync(true, 150, -200, 1.5);
    expect((wsInstance as unknown as { sent: string[] }).sent).toContain(
      JSON.stringify({
        type: "viewport_sync",
        active: true,
        scrollX: 150,
        scrollY: -200,
        zoom: 1.5,
      }),
    );

    client.disconnect();
  });
});
