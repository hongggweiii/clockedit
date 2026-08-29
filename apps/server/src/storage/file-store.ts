import { HttpError } from "../errors.js";
import type { JsonStore } from "../store.js";
import type { Database } from "../types.js";
import type {
  CommitResult,
  FetchResult,
  FileRef,
  FileWrite,
  MovedFile,
  StoredEventType,
  StoredFile,
} from "./file-store.types.js";

const now = () => new Date().toISOString();

const ABSENT = 0;

const effectiveVersion = (file: StoredFile | undefined): number =>
  !file || file.deleted ? ABSENT : file.version;

export function normalizePath(rawPath: string): string {
  const candidate = rawPath.trim();
  if (!candidate) {
    throw new HttpError(400, "Path must not be empty");
  }
  if (candidate.includes("\\")) {
    throw new HttpError(400, "Path must use forward slashes: " + rawPath);
  }
  if (candidate.startsWith("/")) {
    throw new HttpError(400, "Path must be relative: " + rawPath);
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new HttpError(400, "Path must not contain empty or relative segments: " + rawPath);
  }
  return candidate;
}

function appendEvent(
  database: Database,
  type: StoredEventType,
  agent: string,
  taskId: string,
  detail: string,
): void {
  database.eventSeq += 1;
  database.events.push({
    seq: database.eventSeq,
    type,
    agent,
    taskId,
    detail,
    createdAt: now(),
  });
}

export class FileStore {
  constructor(private readonly store: JsonStore) {}

  list(): FileRef[] {
    return Object.values(this.store.snapshot().files)
      .filter((file) => !file.deleted)
      .map((file) => ({ path: file.path, version: file.version }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async fetch(agent: string, rawPath: string): Promise<FetchResult> {
    const path = normalizePath(rawPath);
    return this.store.mutate((database): FetchResult => {
      const file = database.files[path];
      const version = effectiveVersion(file);
      const reads = database.reads[agent] ?? {};
      reads[path] = version;
      database.reads[agent] = reads;
      if (!file || file.deleted) {
        return { ok: false, code: "NOT_FOUND", path };
      }
      return {
        ok: true,
        kind: "file",
        path,
        version,
        content: file.content,
      };
    });
  }

  async commit(
    agent: string,
    taskId: string,
    rawWrites: FileWrite[],
    rawReads: FileRef[] = [],
  ): Promise<CommitResult> {
    const writes = rawWrites.map((write) => ({
      ...write,
      path: normalizePath(write.path),
    }));
    const seen = new Set<string>();
    for (const write of writes) {
      if (seen.has(write.path)) {
        throw new HttpError(400, "Duplicate path in one commit: " + write.path);
      }
      seen.add(write.path);
      if (write.delete && write.based_on === null) {
        throw new HttpError(400, "Cannot delete a file that is not expected to exist: " + write.path);
      }
    }
    const reportedReads = rawReads.map((read) => ({
      ...read,
      path: normalizePath(read.path),
    }));

    return this.store.mutate((database): CommitResult => {
      const moved: MovedFile[] = [];

      const expected: Record<string, number> = {};
      for (const read of reportedReads) {
        expected[read.path] = read.version;
      }
      Object.assign(expected, database.reads[agent] ?? {});
      for (const path of Object.keys(expected).sort()) {
        const had = expected[path] ?? ABSENT;
        const current = effectiveVersion(database.files[path]);
        if (had !== current) {
          moved.push({ path, had, now: current });
        }
      }

      for (const write of writes) {
        const had = write.based_on ?? ABSENT;
        const current = effectiveVersion(database.files[write.path]);
        if (had !== current) {
          moved.push({ path: write.path, had, now: current });
        }
      }

      if (moved.length > 0) {
        appendEvent(
          database,
          "commit_rejected",
          agent,
          taskId,
          moved.length + " path(s) moved: " + moved.map((entry) => entry.path).join(", "),
        );
        return { ok: false, code: "STALE", moved };
      }

      const timestamp = now();
      const versions: Record<string, number> = {};
      for (const write of writes) {
        const version = (database.files[write.path]?.version ?? ABSENT) + 1;
        database.files[write.path] = {
          path: write.path,
          version,
          content: write.delete ? "" : write.content,
          updatedBy: agent,
          updatedAt: timestamp,
          ...(write.delete ? { deleted: true } : {}),
        };
        versions[write.path] = version;
      }
      delete database.reads[agent];
      const written = writes.filter((write) => !write.delete).map((write) => write.path);
      const deleted = writes.filter((write) => write.delete).map((write) => write.path);
      appendEvent(
        database,
        "commit_ok",
        agent,
        taskId,
        [
          written.length > 0 ? "wrote " + written.join(", ") : "",
          deleted.length > 0 ? "deleted " + deleted.join(", ") : "",
        ]
          .filter(Boolean)
          .join("; "),
      );
      return { ok: true, kind: "committed", versions };
    });
  }

}
