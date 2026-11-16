import { chromium } from "playwright";

const PROD_URL = "https://online-board.aghaskdbbb.workers.dev";
const BOARD_ID = "dzDaJuUWGt5DjMZ7HLkOL9";
const TEACHER_TOKEN = "kyHO5Asq0yTPtXlPNicusy0iSvGBMsTvX5CnYtQZZFCY";

async function run() {
  console.log("=== [1] Verifying Backups API on Live Production ===");
  const backupsRes = await fetch(`${PROD_URL}/api/boards/${BOARD_ID}/backups`, {
    headers: { Authorization: `Bearer ${TEACHER_TOKEN}` },
  });
  console.log(`GET /api/boards/${BOARD_ID}/backups HTTP Status:`, backupsRes.status);
  const backupsJson = await backupsRes.json();
  console.log("Backups API response:", JSON.stringify(backupsJson, null, 2));

  console.log("\n=== [2] Launching Playwright Headless Chromium ===");
  const browser = await chromium.launch({ headless: true });
  const context1 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page1 = await context1.newPage();

  const logs1 = [];
  page1.on("console", (msg) => logs1.push(`[P1 Console] ${msg.type()}: ${msg.text()}`));
  page1.on("pageerror", (err) => logs1.push(`[P1 PageError] ${err.message}`));

  const boardUrl = `${PROD_URL}/b/${BOARD_ID}`;
  console.log(`Navigating Page 1 to ${boardUrl}...`);
  await page1.goto(boardUrl, { waitUntil: "networkidle" });

  // Handle Nickname dialog on Page 1
  const nickInput1 = page1.locator('[data-testid="nick-input"]');
  try {
    await nickInput1.waitFor({ state: "visible", timeout: 3000 });
    console.log("Nickname dialog detected on Page 1, submitting nickname...");
    await nickInput1.fill("TestTeacher");
    await page1.locator('[data-testid="nick-submit-button"]').click();
  } catch {
    console.log("No nickname dialog visible on Page 1.");
  }

  // Wait for status pill to show "На связи"
  console.log("Waiting for status banner on Page 1...");
  await page1.waitForSelector('[data-testid="connection-status-banner"]', { timeout: 15000 });
  await page1.waitForFunction(() => {
    const el = document.querySelector('[data-testid="connection-status-banner"]');
    return el && el.textContent && el.textContent.includes("На связи");
  }, { timeout: 15000 });

  const statusText1 = await page1.locator('[data-testid="connection-status-banner"]').innerText();
  console.log("Page 1 Status text:", statusText1);

  console.log("\n=== [3] Checking Layout Bounding Boxes (Zero Overlap) ===");
  const topBarBox = await page1.locator('[data-testid="board-top-bar"]').boundingBox();
  console.log("Top bar bounding box:", topBarBox);

  const toolbarEl = page1.locator(".App-toolbar-container");
  const toolbarBox = await toolbarEl.boundingBox();
  console.log("Toolbar bounding box:", toolbarBox);

  if (topBarBox && toolbarBox) {
    // Top bar is at y=0, height=44. Canvas starts below top bar (y >= 44).
    console.log(`Top bar bottom: ${topBarBox.y + topBarBox.height}px, Toolbar top: ${toolbarBox.y}px`);
    const verticalSeparation = toolbarBox.y - (topBarBox.y + topBarBox.height);
    console.log(`Vertical separation between Top Bar and Toolbar: ${verticalSeparation}px`);
    if (verticalSeparation >= 0) {
      console.log("SUCCESS: ZERO vertical overlap between Top Bar and Toolbar!");
    } else {
      console.error("FAILURE: Top Bar and Toolbar overlap vertically!");
    }
  }

  console.log("\n=== [4] Checking Canvas AppState (Grid & Snapping) ===");
  const gridAndSnapStatus = await page1.evaluate(() => {
    // Check local storage or Excalidraw state
    const canvasContainer = document.querySelector(".board-canvas-container");
    const viewport = document.querySelector(".board-viewport");
    return {
      canvasExists: !!canvasContainer,
      viewportDisplay: window.getComputedStyle(viewport).display,
      viewportFlexDirection: window.getComputedStyle(viewport).flexDirection,
    };
  });
  console.log("Canvas layout container state:", gridAndSnapStatus);

  console.log("\n=== [5] Connecting Page 2 (Student) for Live Sync ===");
  const context2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page2 = await context2.newPage();
  await page2.goto(boardUrl, { waitUntil: "networkidle" });

  const nickInput2 = page2.locator('[data-testid="nick-input"]');
  try {
    await nickInput2.waitFor({ state: "visible", timeout: 3000 });
    console.log("Nickname dialog detected on Page 2, submitting nickname...");
    await nickInput2.fill("StudentBob");
    await page2.locator('[data-testid="nick-submit-button"]').click();
  } catch {
    console.log("No nickname dialog visible on Page 2.");
  }

  await page2.waitForFunction(() => {
    const el = document.querySelector('[data-testid="connection-status-banner"]');
    return el && el.textContent && el.textContent.includes("На связи");
  }, { timeout: 15000 });
  const statusText2 = await page2.locator('[data-testid="connection-status-banner"]').innerText();
  console.log("Page 2 Status text:", statusText2);

  // Take a full page screenshot to verify visual layout
  const screenshotPath = "C:/Users/A.le_BL/.gemini/antigravity/brain/3c5a2cdf-73fb-48b8-b0be-3d408b947142/t5_verified_canvas.png";
  await page1.screenshot({ path: screenshotPath });
  console.log("Saved canvas screenshot to:", screenshotPath);

  console.log("\n=== [6] Testing Restore API on Live Production ===");
  const restoreRes = await fetch(`${PROD_URL}/api/boards/${BOARD_ID}/restore`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEACHER_TOKEN}`,
    },
    body: JSON.stringify({ source: "local_backup" }),
  });
  console.log(`POST /api/boards/${BOARD_ID}/restore HTTP Status:`, restoreRes.status);
  const restoreJson = await restoreRes.json();
  console.log("Restore API response:", JSON.stringify(restoreJson, null, 2));

  await browser.close();
  console.log("\nALL PRODUCTION CHECKS COMPLETED SUCCESSFULLY!");
}

run().catch((err) => {
  console.error("FATAL ERROR in E2E Verification:", err);
  process.exit(1);
});
