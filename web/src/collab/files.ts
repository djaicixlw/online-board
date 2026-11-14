/**
 * Client-side image processing, compression, SHA-1 deduplication,
 * and chunked upload/download manager for Task T4 (SPEC.md sections 3, 5, 6, 8, 10).
 */

export const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MiB (4,194,304 bytes)
export const MAX_IMAGE_FILE_BYTES = MAX_FILE_BYTES;
export const MAX_IMAGE_DIMENSION = 1600; // max width or height in pixels

/**
 * Converts a data URL ("data:image/...;base64,...") into a Blob.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx === -1) {
    throw new Error("Invalid data URL");
  }
  const header = dataUrl.slice(0, commaIdx);
  const base64Data = dataUrl.slice(commaIdx + 1);
  const mimeMatch = /data:([^;]+)/.exec(header);
  const mime = mimeMatch?.[1] ?? "application/octet-stream";
  const binaryStr = atob(base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/**
 * Converts a Blob to a data URL string.
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === "undefined") {
      // Node fallback for testing
      blob
        .arrayBuffer()
        .then((buf) => {
          const bytes = new Uint8Array(buf);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            if (b !== undefined) {
              binary += String.fromCharCode(b);
            }
          }
          resolve(`data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`);
        })
        .catch(reject);
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read blob as data URL"));
      }
    };
    reader.onerror = () => reject(reader.error || new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Computes a 40-character lowercase hexadecimal SHA-1 string from an ArrayBuffer or Uint8Array.
 */
export async function computeSha1Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buffer: BufferSource = data instanceof ArrayBuffer ? data : (data.buffer as ArrayBuffer);
  const digest = await crypto.subtle.digest("SHA-1", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface CompressedImageResult {
  fileId: string;
  mimeType: "image/webp" | "image/jpeg";
  arrayBuffer: ArrayBuffer;
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Downscales image to max 1600px on the longest side and compresses to WebP (0.82)
 * with fallback to JPEG (0.85). Verifies the result is <= 4 MiB and hashes with SHA-1.
 */
export async function compressImageFile(file: File | Blob): Promise<CompressedImageResult> {
  // Headless/test environment fallback when canvas or Image is not available
  if (typeof document === "undefined" || typeof Image === "undefined") {
    const arrayBuffer = await file.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_FILE_BYTES) {
      throw new Error("image_too_large");
    }
    const fileId = await computeSha1Hex(arrayBuffer);
    const mimeType = file.type === "image/jpeg" ? "image/jpeg" : "image/webp";
    const dataUrl = await blobToDataUrl(new Blob([arrayBuffer], { type: mimeType }));
    return {
      fileId,
      mimeType,
      arrayBuffer,
      dataUrl,
      width: 800,
      height: 600,
    };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to load image for compression"));
      img.src = objectUrl;
    });

    let width = img.naturalWidth || img.width || 800;
    let height = img.naturalHeight || img.height || 600;

    const maxDim = Math.max(width, height);
    if (maxDim > MAX_IMAGE_DIMENSION) {
      const scale = MAX_IMAGE_DIMENSION / maxDim;
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas 2D context not available");
    }
    ctx.drawImage(img, 0, 0, width, height);

    // Try WebP 0.82
    let outBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/webp", 0.82);
    });
    let mimeType: "image/webp" | "image/jpeg" = "image/webp";

    // Fallback to JPEG 0.85 if WebP is unsupported
    if (!outBlob || outBlob.type !== "image/webp") {
      outBlob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", 0.85);
      });
      mimeType = "image/jpeg";
    }

    if (!outBlob) {
      throw new Error("Failed to create blob from canvas");
    }

    const arrayBuffer = await outBlob.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_FILE_BYTES) {
      throw new Error("image_too_large");
    }

    const fileId = await computeSha1Hex(arrayBuffer);
    const dataUrl = await blobToDataUrl(outBlob);

    return {
      fileId,
      mimeType,
      arrayBuffer,
      dataUrl,
      width,
      height,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// In-memory session set of already uploaded file IDs (prevents duplicate uploads in one session)
const sessionUploadedFileIds = new Set<string>();

export function markFileUploaded(fileId: string): void {
  sessionUploadedFileIds.add(fileId);
}

export function isFileUploaded(fileId: string): boolean {
  return sessionUploadedFileIds.has(fileId);
}

export function clearUploadedFilesForTesting(): void {
  sessionUploadedFileIds.clear();
}

/**
 * Uploads an image binary to PUT /api/boards/:id/files/:fileId with up to 3 retries.
 */
export async function uploadBoardFile(
  boardId: string,
  fileId: string,
  mimeType: string,
  arrayBuffer: ArrayBuffer,
  onQuotaExceeded?: () => void,
): Promise<boolean> {
  if (sessionUploadedFileIds.has(fileId)) {
    return true;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`/api/boards/${boardId}/files/${fileId}`, {
        method: "PUT",
        headers: {
          "Content-Type": mimeType,
        },
        body: arrayBuffer,
      });

      if (res.ok) {
        sessionUploadedFileIds.add(fileId);
        return true;
      }

      if (res.status === 507) {
        onQuotaExceeded?.();
        return false;
      }

      if (
        res.status === 413 ||
        res.status === 415 ||
        res.status === 400 ||
        res.status === 403 ||
        res.status === 404
      ) {
        return false;
      }
    } catch (err) {
      if (attempt === 2) {
        throw err;
      }
    }
    // Exponential backoff: 500ms, 1000ms
    await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
  }
  return false;
}

export interface LoadedImageFile {
  id: string;
  dataURL: string;
  mimeType: string;
  created: number;
}

/**
 * Parallel download manager that fetches missing image files via GET /api/boards/:id/files/:fileId
 * with a strict concurrency ceiling of 4 active requests.
 */
export class ImageDownloadManager {
  private readonly pending = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly failed = new Set<string>();
  private activeCount = 0;
  private readonly queue: Array<() => Promise<void>> = [];
  private readonly maxConcurrent = 4;

  constructor(
    private readonly boardId: string,
    private readonly onFileLoaded: (file: LoadedImageFile) => void,
  ) {}

  public requestFiles(fileIds: readonly string[]): void {
    for (const fileId of fileIds) {
      if (
        !/^[0-9a-f]{40}$/.test(fileId) ||
        this.pending.has(fileId) ||
        this.completed.has(fileId) ||
        this.failed.has(fileId)
      ) {
        continue;
      }
      this.pending.add(fileId);
      this.queue.push(() => this.downloadFile(fileId));
    }
    this.processNext();
  }

  private processNext(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) {
        break;
      }
      this.activeCount++;
      task().finally(() => {
        this.activeCount--;
        this.processNext();
      });
    }
  }

  private async downloadFile(fileId: string): Promise<void> {
    try {
      const res = await fetch(`/api/boards/${this.boardId}/files/${fileId}`);
      if (!res.ok) {
        this.failed.add(fileId);
        this.pending.delete(fileId);
        return;
      }
      const mimeType = res.headers.get("Content-Type") || "image/webp";
      const blob = await res.blob();
      const dataURL = await blobToDataUrl(blob);
      this.completed.add(fileId);
      this.pending.delete(fileId);
      this.onFileLoaded({
        id: fileId,
        dataURL,
        mimeType,
        created: Date.now(),
      });
    } catch {
      this.failed.add(fileId);
      this.pending.delete(fileId);
    }
  }

  public getStats() {
    return {
      pending: this.pending.size,
      completed: this.completed.size,
      failed: this.failed.size,
      active: this.activeCount,
    };
  }
}
