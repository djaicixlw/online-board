import { test, expect } from "@playwright/test";

const TEST_BOARD_ID = process.env.TEST_BOARD_ID ?? "5D5s8U8ugdus2jDtyflsJE";

/**
 * E2E test for collaborative work of two browsers on a single board (SPEC section 12 / T2):
 * 1. Open board /b/:id in two isolated browser contexts.
 * 2. Both users enter nicknames in the onboarding dialog.
 * 3. Client A imports a scene with element "e2e-rect-1", and we verify that Client B
 *    actually receives and applies the element via WebSocket scene_update synchronization.
 */
test.describe("Board collaboration E2E (/b/:id)", () => {
  test("two browser contexts connect with nicknames and synchronize scene elements", async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto(`/b/${TEST_BOARD_ID}`);
    await pageB.goto(`/b/${TEST_BOARD_ID}`);

    // Both contexts should display the nickname prompt on first visit
    await expect(pageA.getByTestId("nick-dialog")).toBeVisible();
    await expect(pageB.getByTestId("nick-dialog")).toBeVisible();

    await pageA.getByTestId("nick-input").fill("Алиса");
    await pageA.getByTestId("nick-submit-button").click();

    await pageB.getByTestId("nick-input").fill("Борис");
    await pageB.getByTestId("nick-submit-button").click();

    await expect(pageA.getByTestId("nick-dialog")).toBeHidden();
    await expect(pageB.getByTestId("nick-dialog")).toBeHidden();

    // Load a synthetic .excalidraw file on Client A and verify synchronization on Client B
    const sampleScene = JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "https://localhost",
      elements: [
        {
          id: "e2e-rect-1",
          type: "rectangle",
          x: 120,
          y: 140,
          width: 200,
          height: 100,
          version: 2,
          versionNonce: 42,
          updated: Date.now(),
          isDeleted: false,
        },
      ],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    });

    await pageA.getByTestId("excalidraw-file-input").setInputFiles({
      name: "lesson.excalidraw",
      mimeType: "application/json",
      buffer: Buffer.from(sampleScene, "utf-8"),
    });

    // Verify Client A has 1 element applied locally
    await expect(pageA.getByTestId("board-viewport")).toHaveAttribute(
      "data-scene-elements-count",
      "1",
    );

    // Verify Client B receives the synchronized scene_update and has 1 element applied
    await expect(pageB.getByTestId("board-viewport")).toHaveAttribute(
      "data-scene-elements-count",
      "1",
    );

    // Also verify by exporting .excalidraw on Client B that "e2e-rect-1" is present in Client B's scene
    const [downloadB] = await Promise.all([
      pageB.waitForEvent("download"),
      pageB.getByTestId("save-excalidraw-button").click(),
    ]);
    const streamB = await downloadB.createReadStream();
    const chunksB: Buffer[] = [];
    if (streamB) {
      for await (const chunk of streamB) {
        chunksB.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    }
    const exportedJsonB = JSON.parse(Buffer.concat(chunksB).toString("utf-8")) as {
      elements: Array<{ id: string }>;
    };
    expect(exportedJsonB.elements.some((el) => el.id === "e2e-rect-1")).toBe(true);

    await contextA.close();
    await contextB.close();
  });
});
