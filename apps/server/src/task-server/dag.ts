// DAG utilities that operate on the shared Task shape's { id, depends_on }.
// Kept schema-agnostic (only reads those two fields) so it works for both
// InternalTask and NewTask.

export interface CycleError {
  kind: "cycle";
  nodes: string[];
}

export interface UnknownDependencyError {
  kind: "unknown-dependency";
  taskId: string;
  missing: string[];
}

export interface DuplicateIdError {
  kind: "duplicate-id";
  ids: string[];
}

export type DagValidationError =
  | CycleError
  | UnknownDependencyError
  | DuplicateIdError;

export interface DagValidationResult {
  ok: boolean;
  errors: DagValidationError[];
  topoOrder: string[];
}

type DagNode = { id: string; depends_on: readonly string[] };

export function validateDag(
  tasks: readonly DagNode[],
  existingIds: ReadonlySet<string> = new Set(),
): DagValidationResult {
  const errors: DagValidationError[] = [];
  const ids = new Set<string>(existingIds);
  const duplicates = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) duplicates.add(task.id);
    ids.add(task.id);
  }
  if (duplicates.size > 0) {
    errors.push({ kind: "duplicate-id", ids: [...duplicates] });
  }

  for (const task of tasks) {
    const missing = task.depends_on.filter((dep) => !ids.has(dep));
    if (missing.length > 0) {
      errors.push({ kind: "unknown-dependency", taskId: task.id, missing });
    }
  }

  const { order, cycleNodes } = topoSort(tasks);
  if (cycleNodes.length > 0) {
    errors.push({ kind: "cycle", nodes: cycleNodes });
  }

  return { ok: errors.length === 0, errors, topoOrder: order };
}

export function topoSort(
  tasks: readonly DagNode[],
): { order: string[]; cycleNodes: string[] } {
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const task of tasks) {
    indegree.set(task.id, indegree.get(task.id) ?? 0);
    adjacency.set(task.id, adjacency.get(task.id) ?? []);
  }
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (!indegree.has(dep)) continue;
      adjacency.get(dep)!.push(task.id);
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);
  queue.sort();

  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const nextDeg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextDeg);
      if (nextDeg === 0) queue.push(next);
    }
    queue.sort();
  }

  const cycleNodes = order.length === indegree.size
    ? []
    : [...indegree.entries()].filter(([, deg]) => deg > 0).map(([id]) => id);
  return { order, cycleNodes };
}

export function unblockedIds<T extends DagNode & { state: string }>(
  tasks: readonly T[],
): Set<string> {
  const done = new Set(tasks.filter((t) => t.state === "done").map((t) => t.id));
  const out = new Set<string>();
  for (const task of tasks) {
    if (task.state !== "blocked" && task.state !== "unassigned") continue;
    if (task.depends_on.every((dep) => done.has(dep))) out.add(task.id);
  }
  return out;
}
