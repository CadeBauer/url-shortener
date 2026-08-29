/**
 * state.ts — run state, kept deliberately minimal.
 *
 * state.ts is code. state.json is the inert file this code reads and writes.
 * Only the runner touches it; agents never do. That is what makes it credible
 * as an audit artifact: an agent cannot mark itself passed.
 *
 * No content hashing and no staleness propagation — see NG-1 in the
 * orchestration requirements for why those were scoped out.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Stage } from "./stages.js";

export const STATE_PATH = ".orchestrator/state.json";

export type Status =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "skipped";

const NEEDS_WORK: ReadonlySet<Status> = new Set<Status>(["pending", "failed"]);

export interface StageState {
  status: Status;
  attempts: number;
  startedAt: number | null;
  endedAt: number | null;
  lastFailure: string | null;
}

export class State {
  runId: string;
  stages: Record<string, StageState>;

  private constructor(stages: Stage[]) {
    this.runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    this.stages = Object.fromEntries(
      stages.map((s) => [
        s.id,
        {
          status: "pending" as Status,
          attempts: 0,
          startedAt: null,
          endedAt: null,
          lastFailure: null,
        },
      ]),
    );
  }

  /** Resumability: re-running picks up where the last run stopped. */
  static loadOrNew(stages: Stage[]): State {
    const self = new State(stages);
    if (!fs.existsSync(STATE_PATH)) return self;

    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
    self.runId = raw.runId;
    for (const [id, st] of Object.entries(raw.stages ?? {})) {
      if (id in self.stages) self.stages[id] = st as StageState;
    }
    // A stage interrupted mid-flight left unknown side effects.
    for (const st of Object.values(self.stages)) {
      if (st.status === "running") {
        st.status = "failed";
        st.lastFailure = "interrupted";
      }
    }
    return self;
  }

  /** Atomic: a crash mid-write must not corrupt the run. */
  save(): void {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ runId: this.runId, stages: this.stages }, null, 2),
    );
    fs.renameSync(tmp, STATE_PATH);
  }

  set(id: string, patch: Partial<StageState>): void {
    Object.assign(this.stages[id], patch);
    this.save();
  }

  status(id: string): Status {
    return this.stages[id].status;
  }
}

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
 * Every stage that can start right now.
 *
 * Returns one stage -> that is a sequential path.
 * Returns two -> they are parallel. Same mechanism, no special casing.
 */
export function readyStages(stages: Stage[], state: State): Stage[] {
  const out: Stage[] = [];
  for (const s of stages) {
    const st = state.stages[s.id];
    if (!NEEDS_WORK.has(st.status)) continue;
    if (st.attempts > (s.maxRetries ?? 1)) {
      state.set(s.id, { status: "blocked" });
      continue;
    }
    const depsDone = s.dependsOn.every((d) =>
      ["passed", "skipped"].includes(state.status(d)),
    );
    if (depsDone) out.push(s);
  }
  return out;
}
