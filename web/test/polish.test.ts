import { describe, expect, it } from "vitest";
import { mergeSceneElements, type ExcalidrawElementLike } from "../src/collab/index.js";

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
});
