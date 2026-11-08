import type { ExcalidrawElementLike, ReconcileElementsFn } from "./types.js";

export function isValidFiniteElement(el: unknown): el is ExcalidrawElementLike {
  if (!el || typeof el !== "object" || Array.isArray(el)) {
    return false;
  }
  const candidate = el as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length >= 1 &&
    candidate.id.length <= 128 &&
    typeof candidate.version === "number" &&
    Number.isFinite(candidate.version) &&
    candidate.version >= 0 &&
    typeof candidate.versionNonce === "number" &&
    Number.isFinite(candidate.versionNonce)
  );
}

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
    if (isValidFiniteElement(localEl)) {
      mergedMap.set(localEl.id, localEl);
    }
  }

  for (const remoteEl of remoteElements) {
    if (!isValidFiniteElement(remoteEl)) {
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
      if (!isValidFiniteElement(el)) {
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
   * Records that the given elements have been sent to or accepted from the server.
   */
  public markSynced(elements: readonly ExcalidrawElementLike[]): void {
    for (const el of elements) {
      if (!isValidFiniteElement(el)) {
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
   * Records only those remote elements that were actually applied into the reconciled `mergedScene`.
   * If `reconcileElements` preserved a locally edited/dragged element with a lower version,
   * its synced version is not bumped to the discarded remote version (fixing Review #8).
   */
  public markRemoteAppliedAfterMerge(
    remoteElements: readonly ExcalidrawElementLike[],
    mergedScene: readonly ExcalidrawElementLike[],
  ): void {
    const mergedById = new Map<string, ExcalidrawElementLike>();
    for (const el of mergedScene) {
      if (isValidFiniteElement(el)) {
        mergedById.set(el.id, el);
      }
    }

    const acceptedRemote: ExcalidrawElementLike[] = [];
    for (const remoteEl of remoteElements) {
      if (!isValidFiniteElement(remoteEl)) {
        continue;
      }
      const inMerged = mergedById.get(remoteEl.id);
      if (
        inMerged &&
        inMerged.version === remoteEl.version &&
        inMerged.versionNonce === remoteEl.versionNonce
      ) {
        acceptedRemote.push(remoteEl);
      }
    }
    this.markSynced(acceptedRemote);
  }

  /**
   * Replaces the known server state from a received `snapshot` so any local elements edited while
   * offline (with higher version than the server snapshot) will still be detected by `getChangedElements`.
   */
  public applyServerSnapshotBaseline(
    snapshotElements: readonly ExcalidrawElementLike[],
    mergedScene?: readonly ExcalidrawElementLike[],
  ): void {
    this.syncedVersions.clear();
    if (mergedScene) {
      this.markRemoteAppliedAfterMerge(snapshotElements, mergedScene);
    } else {
      this.markSynced(snapshotElements);
    }
  }

  public clear(): void {
    this.syncedVersions.clear();
  }
}
