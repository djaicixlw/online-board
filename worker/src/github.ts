/**
 * worker/src/github.ts
 * GitHub Contents & Commits API integration for board backups and restore (Task T5 Part A).
 */

import { uint8ArrayToBase64 } from "./board.js";

export interface GitHubCommitInfo {
  sha: string;
  message: string;
  date: string;
  author: string;
}

export interface ExportBoardParams {
  token: string;
  repo: string;
  boardId: string;
  teacherId?: string | null | undefined;
  elements: unknown[];
  files?: Array<{ fileId: string; mime: string; data: Uint8Array }> | undefined;
  existingGitAssets?: Set<string> | undefined;
}

export interface ExportBoardResult {
  ok: boolean;
  commitSha?: string | undefined;
  error?: string | undefined;
  uploadedAssets?: string[] | undefined;
}

function getFileExtension(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

/**
 * Returns the Git repository file path for a given board.
 */
export function getBoardGitPath(boardId: string, teacherId?: string | null | undefined): string {
  const folder = teacherId ? teacherId : "pilot";
  return `boards/${folder}/${boardId}.excalidraw`;
}

/**
 * Exports board snapshot and associated images to GitHub Contents API.
 */
export async function exportBoardToGitHub(params: ExportBoardParams): Promise<ExportBoardResult> {
  const { token, repo, boardId, teacherId, elements, files, existingGitAssets } = params;

  if (!token || !repo) {
    return { ok: false, error: "Missing GITHUB_BACKUP_TOKEN or GITHUB_BACKUP_REPO" };
  }

  const boardPath = getBoardGitPath(boardId, teacherId);
  const commonHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "online-board-worker",
  };

  const uploadedAssets: string[] = [];

  try {
    // 1. Export active image assets to boards/assets/<file_id>.<ext> if not already committed
    if (Array.isArray(files) && files.length > 0) {
      for (const file of files) {
        if (existingGitAssets && existingGitAssets.has(file.fileId)) {
          continue;
        }

        const ext = getFileExtension(file.mime);
        const assetPath = `boards/assets/${file.fileId}.${ext}`;

        // Check if file already exists on GitHub
        let assetSha: string | undefined;
        try {
          const checkRes = await fetch(
            `https://api.github.com/repos/${repo}/contents/${assetPath}`,
            {
              method: "GET",
              headers: commonHeaders,
            },
          );
          if (checkRes.ok) {
            const checkData = (await checkRes.json()) as { sha?: string };
            assetSha = checkData.sha;
          }
        } catch {
          // If check fails, try put directly
        }

        if (!assetSha) {
          const base64Content = uint8ArrayToBase64(file.data);
          const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${assetPath}`, {
            method: "PUT",
            headers: {
              ...commonHeaders,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message: `Add asset ${file.fileId} for board ${boardId}`,
              content: base64Content,
            }),
          });

          if (putRes.ok || putRes.status === 422 || putRes.status === 409) {
            uploadedAssets.push(file.fileId);
          } else {
            console.error(
              JSON.stringify({
                event: "git_backup_asset_failed",
                board_id: boardId,
                file_id: file.fileId,
                status: putRes.status,
              }),
            );
          }
        } else {
          uploadedAssets.push(file.fileId);
        }
      }
    }

    // 2. Export board file
    let existingSha: string | undefined;
    const checkRes = await fetch(`https://api.github.com/repos/${repo}/contents/${boardPath}`, {
      method: "GET",
      headers: commonHeaders,
    });

    if (checkRes.ok) {
      const checkData = (await checkRes.json()) as { sha?: string };
      existingSha = checkData.sha;
    } else if (checkRes.status !== 404) {
      const errText = await checkRes.text();
      console.error(
        JSON.stringify({
          event: "git_backup_check_failed",
          board_id: boardId,
          status: checkRes.status,
          error: errText,
        }),
      );
    }

    const excalidrawDoc = {
      type: "excalidraw",
      version: 2,
      source: "online-board",
      elements,
      appState: {
        viewBackgroundColor: "#ffffff",
        gridModeEnabled: true,
      },
    };

    const docJson = JSON.stringify(excalidrawDoc, null, 2);
    const docBytes = new TextEncoder().encode(docJson);
    const base64Doc = uint8ArrayToBase64(docBytes);

    const putPayload: {
      message: string;
      content: string;
      sha?: string;
    } = {
      message: `Backup board ${boardId} [automated]`,
      content: base64Doc,
    };
    if (existingSha) {
      putPayload.sha = existingSha;
    }

    const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${boardPath}`, {
      method: "PUT",
      headers: {
        ...commonHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(putPayload),
    });

    if (!putRes.ok) {
      const errBody = await putRes.text();
      console.error(
        JSON.stringify({
          event: "git_backup_failed",
          board_id: boardId,
          status: putRes.status,
          error: errBody,
        }),
      );
      return { ok: false, error: `GitHub API error (${putRes.status}): ${errBody}` };
    }

    const putData = (await putRes.json()) as { commit?: { sha?: string } };
    const commitSha = putData.commit?.sha;

    return {
      ok: true,
      commitSha,
      uploadedAssets,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        event: "git_backup_exception",
        board_id: boardId,
        error: errorMsg,
      }),
    );
    return { ok: false, error: errorMsg };
  }
}

/**
 * Fetches up to 10 latest Git commits for a board file from GitHub Commits API.
 */
export async function getBoardGitHubCommits(params: {
  token: string;
  repo: string;
  boardId: string;
  teacherId?: string | null | undefined;
  limit?: number | undefined;
}): Promise<GitHubCommitInfo[]> {
  const { token, repo, boardId, teacherId, limit = 10 } = params;
  if (!token || !repo) {
    return [];
  }

  const boardPath = getBoardGitPath(boardId, teacherId);
  const url = `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(boardPath)}&per_page=${limit}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "online-board-worker",
      },
    });

    if (!res.ok) {
      return [];
    }

    const data = (await res.json()) as Array<{
      sha: string;
      commit?: {
        message?: string;
        author?: {
          name?: string;
          date?: string;
        };
      };
    }>;

    if (!Array.isArray(data)) {
      return [];
    }

    return data.map((item) => ({
      sha: item.sha,
      message: item.commit?.message?.split("\n")[0] || "Backup",
      date: item.commit?.author?.date || new Date().toISOString(),
      author: item.commit?.author?.name || "Git Backup",
    }));
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "git_commits_fetch_error",
        board_id: boardId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return [];
  }
}

/**
 * Retrieves the board elements from GitHub at a specific commit ref.
 */
export async function getBoardGitHubContentAtRef(params: {
  token: string;
  repo: string;
  boardId: string;
  teacherId?: string | null | undefined;
  ref: string;
}): Promise<{ ok: boolean; elements?: unknown[]; error?: string }> {
  const { token, repo, boardId, teacherId, ref } = params;
  if (!token || !repo) {
    return { ok: false, error: "Missing GitHub credentials" };
  }

  const boardPath = getBoardGitPath(boardId, teacherId);
  const url = `https://api.github.com/repos/${repo}/contents/${boardPath}?ref=${encodeURIComponent(ref)}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "online-board-worker",
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, error: `GitHub API error (${res.status}): ${errText}` };
    }

    const data = (await res.json()) as { content?: string; encoding?: string };
    if (!data.content) {
      return { ok: false, error: "Empty content returned from GitHub" };
    }

    let jsonString: string;
    if (data.encoding === "base64") {
      const cleanContent = data.content.replace(/\s+/g, "");
      const binary = atob(cleanContent);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      jsonString = new TextDecoder().decode(bytes);
    } else {
      jsonString = data.content;
    }

    const parsed = JSON.parse(jsonString) as { elements?: unknown[] };
    if (!parsed || !Array.isArray(parsed.elements)) {
      return { ok: false, error: "Invalid Excalidraw document in Git" };
    }

    return { ok: true, elements: parsed.elements };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
