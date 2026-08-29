/**
 * graph.ts — the stage graph: validation and readiness.
 *
 * Pure graph logic, no state. Every run starts cold: the runner owns an
 * in-memory Map<string, Status> and passes it in. Nothing is persisted, so
 * there is no state.json and no resumability.
 *
 * No content hashing and no staleness propagation — see NG-1 in the
 * orchestration requirements for why those were scoped out.
 */

import type { Stage } from "./stages.js";

export type Status = "pending" | "running" | "passed" | "failed" | "skipped";

/** A dependency is satisfied when it has passed or was skipped. */
const DONE: ReadonlySet<Status> = new Set<Status>(["passed", "skipped"]);

/** Topological sort. Rejects cycles and dangling edges before anything runs. */
export function validateDag(stages: Stage[]): string[] {
  const ids = new Set(stages.map((s) => s.id));
  const remaining = new Map(stages.map((s) => [s.id, new Set(s.dependsOn)]));

  for (const [id, deps] of remaining) {
    const unknown = [...deps].filter((d) => !ids.has(d));
    if (unknown.length) {
      throw new Error(`stage '${id}' depends on unknown: ${unknown.join(", ")}`);
    }
  }

  const order: string[] = [];
  while (remaining.size) {
    const ready = [...remaining]
      .filter(([, deps]) => deps.size === 0)
      .map(([id]) => id)
      .sort();
    if (!ready.length) {
      throw new Error(`cycle among: ${[...remaining.keys()].sort().join(", ")}`);
    }
    order.push(...ready);
    for (const id of ready) remaining.delete(id);
    for (const deps of remaining.values()) {
      for (const id of ready) deps.delete(id);
    }
  }
  return order;
}

/**
 * Every stage that can start right now: "pending" and with every dependency
 * "passed" or "skipped".
 *
 * Returns one stage -> that is a sequential path.
 * Returns two -> they are parallel. Same mechanism, no special casing.
 *
 * Failure is terminal: a "failed" stage is never "pending", so it is never
 * returned here and never handed back on a later iteration.
 */
export function readyStages(
  stages: Stage[],
  status: Map<string, Status>,
): Stage[] {
  const out: Stage[] = [];
  for (const s of stages) {
    if (status.get(s.id) !== "pending") continue;
    if (s.dependsOn.every((d) => DONE.has(status.get(d)!))) out.push(s);
  }
  return out;
}
