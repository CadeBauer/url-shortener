#!/usr/bin/env tsx
/**
 * runner.ts — executes the stage graph.
 *
 *   tsx runner.ts           run until nothing is left to do
 *   tsx runner.ts --plan    print the graph and exit, running nothing
 *
 * Every run starts cold — there is no persisted state and nothing to resume.
 * Stage status lives in an in-memory Map owned by main().
 *
 * Sequencing is never written down. It falls out of `dependsOn` in stages.ts.
 * When readyStages() returns two stages, they run concurrently against the
 * same working tree — safe because their declared outputs never overlap
 * (implement writes src/, write_tests writes tests/); when it returns one,
 * that is a sequential path. Same code path.
 *
 * The runner emits the stage-boundary events metrics.ts needs — so the log
 * stays complete without any out-of-band bookkeeping.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { STAGES, type Stage } from "./stages.js";
import { validateDag, readyStages, type Status } from "./graph.js";

const ORCH = ".orchestrator";
const AUDIT_LOG = path.join(ORCH, "audit.jsonl");
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const TIMEOUT = Number(process.env.STAGE_TIMEOUT ?? 900) * 1000;

function emit(event: string, stage: string, detail: Record<string, unknown> = {}) {
  fs.mkdirSync(ORCH, { recursive: true });
  fs.appendFileSync(
    AUDIT_LOG,
    JSON.stringify({
      ts: Date.now() / 1000,
      stage,
      event,
      actor: "system",
      ...detail,
    }) + "\n",
  );
}

const log = (msg: string) => console.log(`  ${msg}`);

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

function entryGate(stage: Stage, cwd: string): [boolean, string] {
  const missing = stage.inputs.filter((i) => !fs.existsSync(path.join(cwd, i)));
  emit("gate_evaluated", stage.id, {
    gate: "entry",
    result: missing.length ? "fail" : "pass",
    missing,
  });
  return [missing.length === 0, `missing inputs: ${missing.join(", ")}`];
}

/** Ultra-simple but real: declared outputs must exist and be non-empty. */
function exitGate(stage: Stage, cwd: string): [boolean, string] {
  const bad = stage.outputs.filter((o) => {
    const p = path.join(cwd, o);
    return !fs.existsSync(p) || fs.statSync(p).size === 0;
  });
  emit("gate_evaluated", stage.id, {
    gate: "exit",
    result: bad.length ? "fail" : "pass",
    missing: bad,
  });
  return [bad.length === 0, `missing or empty outputs: ${bad.join(", ")}`];
}

// ---------------------------------------------------------------------------
// Stage execution
// ---------------------------------------------------------------------------

/** A fresh subagent gets nothing but this string, so paths go in it. */
function buildPrompt(stage: Stage): string {
  return [
    `Use the ${stage.agent} subagent for this task.`,
    stage.prompt,
    stage.inputs.length ? `Read these inputs: ${stage.inputs.join(", ")}.` : "",
    `You must produce: ${stage.outputs.join(", ")}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function runAgent(
  prompt: string,
  cwd: string,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      CLAUDE_BIN,
      ["-p", prompt, "--permission-mode", "acceptEdits"],
      { cwd },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", () => {});
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: 124, stderr: `timed out after ${TIMEOUT / 1000}s` });
    }, TIMEOUT);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stderr: String(e) });
    });
  });
}

interface Result {
  id: string;
  ok: boolean;
  why: string | null;
}

async function runStage(stage: Stage, status: Map<string, Status>): Promise<Result> {
  const id = stage.id;
  const cwd = ".";

  status.set(id, "running");
  emit("stage_started", id, { cwd });
  log(`▶ ${id}`);

  const [entryOk, entryWhy] = entryGate(stage, cwd);
  if (!entryOk) return { id, ok: false, why: entryWhy };

  // Hooks read this to tag their events with the right stage.
  fs.writeFileSync(path.join(ORCH, "current_stage"), id);

  const { code, stderr } = await runAgent(buildPrompt(stage), cwd);
  if (code !== 0) {
    return { id, ok: false, why: `agent exited ${code}: ${stderr.slice(0, 300)}` };
  }

  const [exitOk, exitWhy] = exitGate(stage, cwd);
  return { id, ok: exitOk, why: exitOk ? null : exitWhy };
}

/**
 * Plain pass/fail bookkeeping. The runner never commits and never rolls back:
 * whatever the agent wrote stays in the working tree exactly as it left it, and
 * committing — at whatever granularity — is the operator's call.
 */
function finish(r: Result, status: Map<string, Status>) {
  if (r.ok) {
    status.set(r.id, "passed");
    emit("stage_passed", r.id);
    log(`✓ ${r.id}`);
  } else {
    status.set(r.id, "failed");
    emit("stage_failed", r.id, { reason: r.why });
    log(`✗ ${r.id}: ${r.why}`);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const order = validateDag(STAGES); // rejects cycles before anything runs

  if (process.argv.includes("--plan")) {
    console.log(`\ntopological order: ${order.join(" -> ")}\n`);
    for (const s of STAGES) {
      console.log(
        `  ${s.id.padEnd(20)} dependsOn: ${s.dependsOn.join(", ") || "(root)"}`,
      );
    }
    return;
  }

  const status = new Map<string, Status>(STAGES.map((s) => [s.id, "pending"]));
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  emit("run_started", "orchestrator", { runId });

  for (;;) {
    let ready = readyStages(STAGES, status);

    // Greenfield: nothing to analyse yet, so skip rather than fail.
    let skippedAny = false;
    for (const s of [...ready]) {
      const probe = s.skipIfEmpty;
      const empty =
        probe && (!fs.existsSync(probe) || fs.readdirSync(probe).length === 0);
      if (empty) {
        status.set(s.id, "skipped");
        emit("stage_skipped", s.id, { reason: `${probe}/ is empty` });
        log(`⊘ ${s.id} (skipped)`);
        ready = ready.filter((x) => x.id !== s.id);
        skippedAny = true;
      }
    }
    if (skippedAny) continue; // recompute: skipping may have unblocked others

    if (!ready.length) break;

    if (ready.length > 1) {
      log(`→ ${ready.length} stages in parallel: ${ready.map((s) => s.id).join(", ")}`);
    }

    const results = await Promise.all(ready.map((s) => runStage(s, status)));
    for (const r of results) finish(r, status);
  }

  emit("run_ended", "orchestrator");
  console.log("\nfinal state:");
  for (const id of order) console.log(`  ${id.padEnd(20)} ${status.get(id)}`);
  console.log("\nrun `tsx metrics.ts` for reliability metrics\n");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
