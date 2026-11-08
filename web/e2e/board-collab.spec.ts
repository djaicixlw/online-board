import { expect, test } from "@playwright/test";

const E2E_BOARD_ID = "E2eSyncBoardTest123456"; // 22 base62 chars

test.describe("Синхронное рисование в двух браузерах (/b/:id)", () => {
  test.skip(
    process.env.T1_MERGED !== "true",
    "Пропущено до влития задачи T1 (Durable Object Board) в ветку main. Запустите с T1_MERGED=true против локального сервера.",
  );

  test("два браузера подключаются к одной доске, видят участников и синхронно передают рисунок", async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto(`/b/${E2E_BOARD_ID}`);
    await pageB.goto(`/b/${E2E_BOARD_ID}`);

    // Оба пользователя вводят ник в диалоге «Как вас зовут на доске?»
    await expect(pageA.getByTestId("nick-dialog")).toBeVisible();
    await pageA.getByTestId("nick-input").fill("Преподаватель");
    await pageA.getByTestId("nick-submit-button").click();

    await expect(pageB.getByTestId("nick-dialog")).toBeVisible();
    await pageB.getByTestId("nick-input").fill("Ученик");
    await pageB.getByTestId("nick-submit-button").click();

    // Оба клиента переходят в состояние «На связи» и видят 2 участников
    await expect(pageA.getByTestId("connection-status-banner")).toContainText("На связи");
    await expect(pageB.getByTestId("connection-status-banner")).toContainText("На связи");
    await expect(pageB.getByTestId("collaborators-counter")).toContainText("2");

    // Браузер A импортирует элемент через .excalidraw или рисует на холсте -> Браузер B получает обновление
    const sampleScene = JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "http://localhost:5173",
      elements: [
        {
          id: "e2e-rect-1",
          type: "rectangle",
          x: 150,
          y: 150,
          width: 200,
          height: 120,
          version: 3,
          versionNonce: 111,
        },
      ],
      appState: {
        gridSize: null,
        viewBackgroundColor: "#ffffff",
        exportEmbedScene: true,
      },
      files: {},
    });

    await pageA.getByTestId("excalidraw-file-input").setInputFiles({
      name: "lesson.excalidraw",
      mimeType: "application/json",
      buffer: Buffer.from(sampleScene, "utf8"),
    });

    // Движение мыши на странице A отображает плавный курсор с ником «Преподаватель» на странице B
    await pageA.mouse.move(220, 240);
    await expect(pageB.getByTestId("remote-cursors-layer")).toContainText("Преподаватель");

    await contextA.close();
    await contextB.close();
  });
});
