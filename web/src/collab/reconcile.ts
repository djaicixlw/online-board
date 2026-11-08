import type { ExcalidrawElementLike, ReconcileElementsFn } from "./types.js";

/**
 * Determines whether `incoming` should replace `existing` according to Excalidraw's
 * conflict resolution rules (`packages/excalidraw/data/reconcile.ts`):
 * - Higher `version` wins.
 * - On equal `version`, lower `versionNonce` wins.
 */
export function shouldReplaceElement(
  existing: ExcalidrawElementLike | undefined,
  incoming: ExcalidrawElementLike,
): boolean {
  if (!existing) {
    return true;
  }
  if (incoming.version > existing.version) {
    return true;
  }
  if (incoming.version === existing.version && incoming.versionNonce < existing.versionNonce) {
    return true;
  }
  return false;
}

/**
 * Merges incoming remote elements (either a full snapshot or a partial `scene_update` delta)
 * with local elements using `(version, versionNonce)` rules and optional Excalidraw `reconcileElements`.
 */
export function mergeSceneElements(
  localElements: readonly ExcalidrawElementLike[],
  remoteElements: readonly ExcalidrawElementLike[],
  localAppState: Record<string, unknown> = {},
  excalidrawReconcile?: ReconcileElementsFn,
): ExcalidrawElementLike[] {
  const mergedMap = new Map<string, ExcalidrawElementLike>();

  for (const localEl of localElements) {
    mergedMap.set(localEl.id, localEl);
  }

  for (const remoteEl of remoteElements) {
    if (
      !remoteEl ||
      typeof remoteEl.id !== "string" ||
      typeof remoteEl.version !== "number" ||
      typeof remoteEl.versionNonce !== "number"
    ) {
      continue;
    }
    const current = mergedMap.get(remoteEl.id);
    if (shouldReplaceElement(current, remoteEl)) {
      mergedMap.set(remoteEl.id, remoteEl);
    }
  }

  const candidateMerged = Array.from(mergedMap.values());

  if (typeof excalidrawReconcile === "function") {
    try {
      return excalidrawReconcile(localElements, candidateMerged, localAppState);
    } catch {
      return candidateMerged;
    }
  }

  return candidateMerged;
}

interface VersionStamp {
  version: number;
  versionNonce: number;
}

/**
 * Tracks the last synced `(version, versionNonce)` per element ID so only changed elements
 * are sent in `scene_update` batches.
 */
export class VersionDiffTracker {
  private readonly syncedVersions = new Map<string, VersionStamp>();

  /**
   * Returns elements that are new or have a newer version (or winning versionNonce) compared to the last synced state.
   */
  public getChangedElements(
    elements: readonly ExcalidrawElementLike[],
  ): ExcalidrawElementLike[] {
    const changed: ExcalidrawElementLike[] = [];
    for (const el of elements) {
      if (
        !el ||
        typeof el.id !== "string" ||
        typeof el.version !== "number" ||
        typeof el.versionNonce !== "number"
      ) {
        continue;
      }
      const last = this.syncedVersions.get(el.id);
      if (!last) {
        // Skip brand-new already-deleted tombstones that were never sent
        if (el.isDeleted === true) {
          this.syncedVersions.set(el.id, {
            version: el.version,
            versionNonce: el.versionNonce,
          });
          continue;
        }
        changed.push(el);
        continue;
      }
      if (
        el.version > last.version ||
        (el.version === last.version && el.versionNonce < last.versionNonce)
      ) {
        changed.push(el);
      }
    }
    return changed;
  }

  /**
   * Records that the given elements have been sent to or received from the server.
   */
  public markSynced(elements: readonly ExcalidrawElementLike[]): void {
    for (const el of elements) {
      if (
        !el ||
        typeof el.id !== "string" ||
        typeof el.version !== "number" ||
        typeof el.versionNonce !== "number"
      ) {
        continue;
      }
      const existing = this.syncedVersions.get(el.id);
      if (
        !existing ||
        el.version > existing.version ||
        (el.version === existing.version && el.versionNonce < existing.versionNonce)
      ) {
        this.syncedVersions.set(el.id, {
          version: el.version,
          versionNonce: el.versionNonce,
        });
      }
    }
  }

  /**
   * Replaces the known server state from a received `snapshot` so any local elements edited while
   * offline (with higher version than the server snapshot) will still be detected by `getChangedElements`.
   */
  public applyServerSnapshotBaseline(
    snapshotElements: readonly ExcalidrawElementLike[],
  ): void {
    this.syncedVersions.clear();
    this.markSynced(snapshotElements);
  }

  public clear(): void {
    this.syncedVersions.clear();
  }
}
