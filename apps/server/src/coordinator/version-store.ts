export interface VersionStoreCommitInput {
  projectId: string;
  agentId: string;
  taskId: string;
  expectedVersions: Record<string, string>;
  writtenPaths: string[];
}

export type VersionStoreCommitResult =
  | { ok: true; newVersions: Record<string, string> }
  | { ok: false; conflictedPaths: string[] };

export interface VersionStore {
  head(projectId: string, paths: string[]): Promise<Record<string, string>>;
  commit(input: VersionStoreCommitInput): Promise<VersionStoreCommitResult>;
}

interface FileState {
  version: string;
  lastWriter: string | null;
}

export class InMemoryVersionStore implements VersionStore {
  private counters = new Map<string, number>();
  private files = new Map<string, FileState>();

  private key(projectId: string, path: string): string {
    return `${projectId}:${path}`;
  }

  private nextVersion(projectId: string, path: string): string {
    const key = this.key(projectId, path);
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return `v${next}`;
  }

  async head(projectId: string, paths: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const path of paths) {
      const state = this.files.get(this.key(projectId, path));
      if (state) result[path] = state.version;
    }
    return result;
  }

  async commit(input: VersionStoreCommitInput): Promise<VersionStoreCommitResult> {
    const conflicts: string[] = [];
    for (const [path, expected] of Object.entries(input.expectedVersions)) {
      const state = this.files.get(this.key(input.projectId, path));
      const current = state?.version ?? null;
      if ((current ?? null) !== (expected ?? null)) {
        conflicts.push(path);
      }
    }
    for (const path of input.writtenPaths) {
      if (input.expectedVersions[path] !== undefined) continue;
      const state = this.files.get(this.key(input.projectId, path));
      if (state && state.lastWriter !== input.agentId) conflicts.push(path);
    }
    if (conflicts.length > 0) return { ok: false, conflictedPaths: conflicts };

    const newVersions: Record<string, string> = {};
    for (const path of input.writtenPaths) {
      const version = this.nextVersion(input.projectId, path);
      this.files.set(this.key(input.projectId, path), {
        version,
        lastWriter: input.agentId,
      });
      newVersions[path] = version;
    }
    return { ok: true, newVersions };
  }

  // Test helper: force a version bump for a file, simulating an external writer.
  forceBump(projectId: string, path: string, writer = "external"): string {
    const version = this.nextVersion(projectId, path);
    this.files.set(this.key(projectId, path), { version, lastWriter: writer });
    return version;
  }
}
