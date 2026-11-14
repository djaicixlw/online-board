import { beforeEach, describe, expect, it } from "vitest";
import worker, { Board, type Env } from "../src/index.js";
import { detectImageMime } from "../src/board.js";
import { createBoardTestHarness } from "./cloudflare-workers-shim.js";
import { InMemoryD1Database } from "./d1-mock.js";

// Helper to compute SHA-1 hex
async function sha1Hex(buf: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Helper to create synthetic PNG with valid 89 50 4E 47 header
function createMockPng(byteLength = 100): Uint8Array {
  const buf = new Uint8Array(byteLength);
  buf[0] = 0x89;
  buf[1] = 0x50; // 'P'
  buf[2] = 0x4e; // 'N'
  buf[3] = 0x47; // 'G'
  for (let i = 4; i < byteLength; i++) {
    buf[i] = (i * 37) % 256;
  }
  return buf;
}

// Helper to create synthetic WebP with valid RIFF....WEBP header
function createMockWebP(byteLength = 100): Uint8Array {
  const buf = new Uint8Array(byteLength);
  buf[0] = 0x52; // 'R'
  buf[1] = 0x49; // 'I'
  buf[2] = 0x46; // 'F'
  buf[3] = 0x46; // 'F'
  buf[8] = 0x57; // 'W'
  buf[9] = 0x45; // 'E'
  buf[10] = 0x42; // 'B'
  buf[11] = 0x50; // 'P'
  for (let i = 12; i < byteLength; i++) {
    buf[i] = (i * 17) % 256;
  }
  return buf;
}

describe("Task T4: Board Image Files & SQLite Storage", () => {
  let mockDb: InMemoryD1Database;
  let harness: ReturnType<typeof createBoardTestHarness>;
  let env: Env;
  const boardId = "TestBoard1234567890123";

  beforeEach(() => {
    mockDb = new InMemoryD1Database();
    harness = createBoardTestHarness(Board, {
      ALLOW_ANY_BOARD_ID: "false",
      PILOT_BOARD_IDS: boardId,
      DB: mockDb as unknown as D1Database,
    });
    env = harness.env;
  });

  it("detectImageMime accurately validates magic bytes and rejects SVG/HTML", () => {
    const png = createMockPng(50);
    expect(detectImageMime(png)).toBe("image/png");

    const webp = createMockWebP(50);
    expect(detectImageMime(webp)).toBe("image/webp");

    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    expect(detectImageMime(jpeg)).toBe("image/jpeg");

    // SVG and HTML rejected to prevent XSS
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><circle/></svg>");
    expect(detectImageMime(svg)).toBeNull();

    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    expect(detectImageMime(html)).toBeNull();
  });

  it("PUT /api/boards/:id/files/:fileId uploads valid image and GET returns it with security headers", async () => {
    const webpData = createMockWebP(1024); // 1 KB
    const fileId = await sha1Hex(webpData);

    // 1. Upload via PUT
    const putReq = new Request(`http://localhost:8787/api/boards/${boardId}/files/${fileId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "image/webp",
        Origin: "http://localhost:8787",
      },
      body: webpData,
    });
    const putRes = await worker.fetch(putReq, env);
    expect(putRes.status).toBe(200);
    const putJson = (await putRes.json()) as { ok: boolean; fileId: string; deduplicated: boolean };
    expect(putJson.ok).toBe(true);
    expect(putJson.fileId).toBe(fileId);
    expect(putJson.deduplicated).toBe(false);

    // 2. Fetch via GET
    const getReq = new Request(`http://localhost:8787/api/boards/${boardId}/files/${fileId}`, {
      method: "GET",
    });
    const getRes = await worker.fetch(getReq, env);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("Content-Type")).toBe("image/webp");
    expect(getRes.headers.get("Cache-Control")).toContain("immutable");
    expect(getRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(getRes.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");

    const downloadedBytes = new Uint8Array(await getRes.arrayBuffer());
    expect(downloadedBytes.byteLength).toBe(webpData.byteLength);
    expect(downloadedBytes[0]).toBe(webpData[0]);
    expect(downloadedBytes[11]).toBe(webpData[11]);
  });

  it("Slices large files (>900 KB) into chunks and successfully reassembles on GET", async () => {
    // 1.5 MB PNG -> requires 2 chunks (900 KB + 636 KB)
    const largePng = createMockPng(1_500_000);
    const fileId = await sha1Hex(largePng);

    const putReq = new Request(`http://localhost:8787/api/boards/${boardId}/files/${fileId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "image/png",
        Origin: "http://localhost:8787",
      },
      body: largePng,
    });
    const putRes = await worker.fetch(putReq, env);
    expect(putRes.status).toBe(200);

    const getReq = new Request(`http://localhost:8787/api/boards/${boardId}/files/${fileId}`, {
      method: "GET",
    });
    const getRes = await worker.fetch(getReq, env);
    expect(getRes.status).toBe(200);
    const downloaded = new Uint8Array(await getRes.arrayBuffer());
    expect(downloaded.byteLength).toBe(largePng.byteLength);

    // Verify first and last bytes match
    expect(downloaded[0]).toBe(largePng[0]);
    expect(downloaded[1_499_999]).toBe(largePng[1_499_999]);
  });

  it("Rejects invalid SHA-1, unsupported format, file > 4 MiB, and cross-origin PUT", async () => {
    const png = createMockPng(100);
    const correctHash = await sha1Hex(png);
    const fakeHash = "0123456789012345678901234567890123456789";

    // 1. SHA-1 mismatch -> 400
    const reqMismatch = new Request(`http://localhost:8787/api/boards/${boardId}/files/${fakeHash}`, {
      method: "PUT",
      headers: { "Content-Type": "image/png", Origin: "http://localhost:8787" },
      body: png,
    });
    const resMismatch = await worker.fetch(reqMismatch, env);
    expect(resMismatch.status).toBe(400);

    // 2. Unsupported format (SVG) -> 415
    const svg = new TextEncoder().encode("<svg></svg>");
    const svgHash = await sha1Hex(svg);
    const reqSvg = new Request(`http://localhost:8787/api/boards/${boardId}/files/${svgHash}`, {
      method: "PUT",
      headers: { "Content-Type": "image/svg+xml", Origin: "http://localhost:8787" },
      body: svg,
    });
    const resSvg = await worker.fetch(reqSvg, env);
    expect(resSvg.status).toBe(415);

    // 3. Cross-origin upload forbidden -> 403
    const reqOrigin = new Request(`http://localhost:8787/api/boards/${boardId}/files/${correctHash}`, {
      method: "PUT",
      headers: { "Content-Type": "image/png", Origin: "https://evil-attacker.com" },
      body: png,
    });
    const resOrigin = await worker.fetch(reqOrigin, env);
    expect(resOrigin.status).toBe(403);
  });

  it("Deduplicates identical files on subsequent PUT without rewriting chunks", async () => {
    const png = createMockPng(500);
    const fileId = await sha1Hex(png);

    // First upload
    const res1 = await worker.fetch(
      new Request(`http://localhost:8787/api/boards/${boardId}/files/${fileId}`, {
        method: "PUT",
        headers: { "Content-Type": "image/png", Origin: "http://localhost:8787" },
        body: png,
      }),
      env,
    );
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { deduplicated: boolean };
    expect(body1.deduplicated).toBe(false);

    // Second upload of same fileId
    const res2 = await worker.fetch(
      new Request(`http://localhost:8787/api/boards/${boardId}/files/${fileId}`, {
        method: "PUT",
        headers: { "Content-Type": "image/png", Origin: "http://localhost:8787" },
        body: png,
      }),
      env,
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { deduplicated: boolean };
    expect(body2.deduplicated).toBe(true);
  });

  it("Purges unreferenced images older than 30 days during snapshot flush while preserving active images", async () => {
    const doId = env.BOARD.idFromName(boardId);
    const stub = env.BOARD.get(doId);

    // 1. Upload two images
    const imageActive = createMockPng(200);
    const hashActive = await sha1Hex(imageActive);
    await stub.fetch(`http://do/internal/files/${hashActive}`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: imageActive,
    });

    const imageOrphan = createMockPng(300);
    const hashOrphan = await sha1Hex(imageOrphan);
    await stub.fetch(`http://do/internal/files/${hashOrphan}`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: imageOrphan,
    });

    // 2. Reference imageActive on the board (scene element)
    const element = {
      id: "el-image-1",
      type: "image",
      fileId: hashActive,
      x: 50,
      y: 50,
      width: 100,
      height: 100,
      version: 1,
      versionNonce: 12345,
      isDeleted: false,
    };
    await stub.fetch("http://do/internal/import", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ elements: [element] }),
    });

    // 3. Artificially age the orphan image in storage beyond 30 days (31 days ago)
    const storage = harness.storages.get(boardId);
    expect(storage).toBeDefined();
    const oldTimestamp = Date.now() - 31 * 24 * 60 * 60 * 1000;
    storage?.sql.exec("UPDATE files SET last_referenced_at = ? WHERE file_id = ?", oldTimestamp, hashOrphan);

    // 4. Trigger snapshot flush
    await stub.fetch("http://do/internal/import", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ elements: [element] }),
    });

    // 5. Verify imageActive is preserved, imageOrphan is deleted
    const resActive = await stub.fetch(`http://do/internal/files/${hashActive}`);
    expect(resActive.status).toBe(200);

    const resOrphan = await stub.fetch(`http://do/internal/files/${hashOrphan}`);
    expect(resOrphan.status).toBe(404);
  });
});
