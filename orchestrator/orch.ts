#!/usr/bin/env tsx
/**
 * orch.ts — thin CLI over the audit log.
 *
 * Hooks capture what agents do; the runner captures stage boundaries. This
 * captures what YOU do out of band: safe-stop.
 * Between the three, every event needed for metrics lands in one file.
 *
 *   tsx orch.ts stage <id>             mark the current stage
 *   tsx orch.ts start|pass|fail <id>   stage boundary events
 *   tsx orch.ts stop | resume          engage / clear safe-stop
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ORCH = ".orchestrator";
const LOG = path.join(ORCH, "audit.jsonl");
const STOP_FILE = path.join(ORCH, "STOP");

const stage = () => {
  const f = path.join(ORCH, "current_stage");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf-8").trim() : "unassigned";
};

const setStage = (id: string) => fs.writeFileSync(path.join(ORCH, "current_stage"), id);

function emit(event: string, detail: Record<string, unknown> = {}) {
  fs.appendFileSync(
    LOG,
    JSON.stringify({
      ts: Date.now() / 1000,
      stage: stage(),
      event,
      actor: "human",
      ...detail,
    }) + "\n",
  );
}

const [cmd, arg, arg2] = process.argv.slice(2);
const need = (v: string | undefined, what: string) => {
  if (!v) {
    console.error(`missing argument: ${what}`);
    process.exit(1);
  }
  return v;
};

switch (cmd) {
  case "stage":
    setStage(need(arg, "<id>"));
    console.log(`stage -> ${arg}`);
    break;

  case "start":
    setStage(need(arg, "<id>"));
    emit("stage_started");
    console.log(`▶ ${arg}`);
    break;

  case "pass":
    setStage(need(arg, "<id>"));
    emit("stage_passed");
    console.log(`✓ ${arg}`);
    break;

  case "fail":
    setStage(need(arg, "<id>"));
    emit("stage_failed", { reason: arg2 ?? "unspecified" });
    console.log(`✗ ${arg}`);
    break;

  case "stop":
    fs.writeFileSync(STOP_FILE, "");
    emit("safe_stop");
    console.log("SAFE-STOP engaged");
    break;

  case "resume":
    fs.rmSync(STOP_FILE, { force: true });
    emit("safe_stop_cleared");
    console.log("resumed");
    break;

  default:
    console.log(fs.readFileSync(new URL(import.meta.url), "utf-8").split("\n").slice(2, 11).join("\n"));
    process.exit(1);
}
