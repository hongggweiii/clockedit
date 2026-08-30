import type { FileRef, FileWrite } from "../storage/file-store.types.js";

/**
 * FileStore is the interface my task-server consumes for the "source of
 * truth" file JSONStore. The file-versioning teammate implements it for
 * real; this file also ships an in-memory mock used by tests and MVP.
 *
 * Versions are non-negative integers (matches the shared file schemas).
 */
export interface FileStore {
  /** Return current head versions + contents for the given paths (missing → omitted). */
  fetch(paths: readonly string[]): Promise<Array<{ path: string; version: number; content: string }>>;

  /**
   * Atomic all-or-nothing commit.
   * - Every read's `version` must equal current head.
   * - Every write's `based_on` must equal current head (or null for new files).
   * If any check fails, return { ok: false, conflictedPaths } and DO NOT apply.
   */
  commit(input: {
    agentId: string;
    taskId: string;
    reads: readonly FileRef[];
    writes: readonly FileWrite[];
  }): Promise<
    | { ok: true; newVersions: Record<string, number> }
    | { ok: false; conflictedPaths: string[] }
  >;
}

interface FileState {
  version: number;
  content: string;
  lastWriter: string | null;
}

export class InMemoryFileStore implements FileStore {
  private files = new Map<string, FileState>();

  async fetch(paths: readonly string[]): Promise<Array<{ path: string; version: number; content: string }>> {
    const out: Array<{ path: string; version: number; content: string }> = [];
    for (const path of paths) {
      const state = this.files.get(path);
      if (state) out.push({ path, version: state.version, content: state.content });
    }
    return out;
  }

  async commit(input: {
    agentId: string;
    taskId: string;
    reads: readonly FileRef[];
    writes: readonly FileWrite[];
  }): Promise<
    | { ok: true; newVersions: Record<string, number> }
    | { ok: false; conflictedPaths: string[] }
  > {
    const conflicts: string[] = [];
    for (const read of input.reads) {
      const current = this.files.get(read.path)?.version ?? -1;
      if (current !== read.version) conflicts.push(read.path);
    }
    for (const write of input.writes) {
      const current = this.files.get(write.path)?.version ?? null;
      if (current !== write.based_on) conflicts.push(write.path);
    }
    if (conflicts.length > 0) return { ok: false, conflictedPaths: [...new Set(conflicts)] };

    const newVersions: Record<string, number> = {};
    for (const write of input.writes) {
      const nextVersion = (this.files.get(write.path)?.version ?? -1) + 1;
      this.files.set(write.path, {
        version: nextVersion,
        content: write.content,
        lastWriter: input.agentId,
      });
      newVersions[write.path] = nextVersion;
    }
    return { ok: true, newVersions };
  }

  // Test helper: raise a file's head version without going through commit.
  forceBump(path: string, content = "", writer = "external"): number {
    const next = (this.files.get(path)?.version ?? -1) + 1;
    this.files.set(path, { version: next, content, lastWriter: writer });
    return next;
  }

  headVersion(path: string): number | null {
    return this.files.get(path)?.version ?? null;
  }
}
