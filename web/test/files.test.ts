import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  blobToDataUrl,
  clearUploadedFilesForTesting,
  compressImageFile,
  computeSha1Hex,
  dataUrlToBlob,
  ImageDownloadManager,
  isFileUploaded,
  MAX_IMAGE_FILE_BYTES,
  uploadBoardFile,
} from "../src/collab/files.js";

describe("Task T4: Frontend Image Pipeline (web/src/collab/files.ts)", () => {
  beforeEach(() => {
    clearUploadedFilesForTesting();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("computeSha1Hex computes correct 40-character lowercase hex", async () => {
    const data = new TextEncoder().encode("hello world");
    const hash = await computeSha1Hex(data);
    expect(hash).toHaveLength(40);
    expect(hash).toBe("2aae6c35c94fcfb415dbe95f408b9ce91ee846ed");
  });

  it("dataUrlToBlob and blobToDataUrl correctly round-trip binary data", async () => {
    const originalBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x01, 0x02, 0x03]);
    const originalBlob = new Blob([originalBytes], { type: "image/webp" });
    const dataUrl = await blobToDataUrl(originalBlob);
    expect(dataUrl).toMatch(/^data:image\/webp;base64,/);

    const parsedBlob = dataUrlToBlob(dataUrl);
    expect(parsedBlob.type).toBe("image/webp");
    const parsedBuf = new Uint8Array(await parsedBlob.arrayBuffer());
    expect(parsedBuf).toEqual(originalBytes);
  });

  it("compressImageFile produces valid SHA-1, mimeType and dataUrl in test environment", async () => {
    const rawData = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const file = new Blob([rawData], { type: "image/jpeg" });

    const result = await compressImageFile(file);
    expect(result.fileId).toHaveLength(40);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.dataUrl).toContain("data:image/jpeg;base64,");
    expect(result.arrayBuffer.byteLength).toBe(6);
  });

  it("compressImageFile rejects files larger than 4 MiB", async () => {
    const largeBuffer = new Uint8Array(MAX_IMAGE_FILE_BYTES + 10);
    const largeBlob = new Blob([largeBuffer], { type: "image/png" });

    await expect(compressImageFile(largeBlob)).rejects.toThrow("image_too_large");
  });

  it("uploadBoardFile deduplicates uploads and retries on transient network errors", async () => {
    const boardId = "TestBoard1234567890123";
    const fileId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const buf = new Uint8Array([1, 2, 3]).buffer;

    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        throw new Error("Network transient failure");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await uploadBoardFile(boardId, fileId, "image/webp", buf);
    expect(ok).toBe(true);
    expect(calls).toBe(2);
    expect(isFileUploaded(fileId)).toBe(true);

    // Subsequent call should resolve immediately from in-memory set without fetch
    const ok2 = await uploadBoardFile(boardId, fileId, "image/webp", buf);
    expect(ok2).toBe(true);
    expect(calls).toBe(2);
  });

  it("uploadBoardFile triggers onQuotaExceeded on 507 Insufficient Storage", async () => {
    const boardId = "TestBoard1234567890123";
    const fileId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const buf = new Uint8Array([4, 5, 6]).buffer;

    let quotaCalled = false;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "Board files quota exceeded" }), {
        status: 507,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ok = await uploadBoardFile(boardId, fileId, "image/webp", buf, () => {
      quotaCalled = true;
    });
    expect(ok).toBe(false);
    expect(quotaCalled).toBe(true);
  });

  it("ImageDownloadManager enforces max concurrency of 4 and loads files", async () => {
    const boardId = "TestBoard1234567890123";
    let activeFetches = 0;
    let maxObservedActive = 0;
    const loadedFiles: string[] = [];

    const fetchMock = vi.fn().mockImplementation(async () => {
      activeFetches++;
      if (activeFetches > maxObservedActive) {
        maxObservedActive = activeFetches;
      }
      // Small delay to test concurrency
      await new Promise((r) => setTimeout(r, 20));
      activeFetches--;
      return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
        status: 200,
        headers: { "Content-Type": "image/webp" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const manager = new ImageDownloadManager(boardId, (file) => {
      loadedFiles.push(file.id);
    });

    const fileIds = [
      "1111111111111111111111111111111111111111",
      "2222222222222222222222222222222222222222",
      "3333333333333333333333333333333333333333",
      "4444444444444444444444444444444444444444",
      "5555555555555555555555555555555555555555",
      "6666666666666666666666666666666666666666",
    ];

    manager.requestFiles(fileIds);

    // Wait for all to finish
    await vi.waitFor(() => expect(loadedFiles).toHaveLength(6), { timeout: 1000 });

    expect(maxObservedActive).toBeLessThanOrEqual(4);
    expect(loadedFiles).toEqual(fileIds);
  });
});
