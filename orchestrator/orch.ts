#!/usr/bin/env tsx
/**
 * orch.ts — thin CLI over the audit log and git worktrees.
 *
 * Hooks capture what agents do; the runner captures stage boundaries. This
 * captures what YOU do out of band: approvals, safe-stop, manual rollback.
 * Between the three, every event needed for metrics lands in one file.
 *
 *   tsx orch.ts stage <id>             mark the current stage
 *   tsx orch.ts start|pass|fail <id>   stage boundary events
 *   tsx orch.ts retry <id>             retry_triggered
 *   tsx orch.ts approve                grant approval for the current stage
 *   tsx orch.ts stop | resume          engage / clear safe-stop
 *   tsx orch.ts wt-add <name>          create a worktree
 *   tsx orch.ts rollback <name>        discard a worktree  (rollback_executed)
 *   tsx orch.ts merge <name>           merge a worktree branch back
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ORCH = ".orchestrator";
const LOG = path.join(ORCH, "audit.jsonl");
const APPROVALS = path.join(ORCH, "approvals");
const STOP_FILE = path.join(ORCH, "STOP");

fs.mkdirSync(APPROVALS, { recursive: true });
fs.mkdirSync("worktrees", { recursive: true });

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

const git = (...args: string[]) =>
  spawnSync("git", args, { stdio: "inherit", encoding: "utf-8" });

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

  case "retry":
    setStage(need(arg, "<id>"));
    emit("retry_triggered");
    console.log(`↻ ${arg}`);
    break;

  case "approve": {
    const token = path.join(APPROVALS, `${stage()}.granted`);
    fs.writeFileSync(token, "");
    emit("approval_granted", { operator: os.userInfo().username });
    console.log(`approved: ${stage()}`);
    break;
  }

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

  // --- worktrees: parallelism and rollback ---------------------------------
  case "wt-add": {
    const id = need(arg, "<name>");
    git("worktree", "add", path.join("worktrees", id), "-b", `stage/${id}`);
    emit("worktree_created", { worktree: id });
    console.log(`worktree ready: worktrees/${id} (branch stage/${id})`);
    break;
  }

  case "rollback": {
    const id = need(arg, "<name>");
    git("worktree", "remove", "--force", path.join("worktrees", id));
    git("branch", "-D", `stage/${id}`);
    emit("rollback_executed", { worktree: id });
    console.log(`rolled back: ${id} — repo unchanged`);
    break;
  }

  case "merge": {
    const id = need(arg, "<name>");
    git("merge", "--no-ff", `stage/${id}`, "-m", `merge stage/${id}`);
    git("worktree", "remove", "--force", path.join("worktrees", id));
    emit("worktree_merged", { worktree: id });
    console.log(`merged: ${id}`);
    break;
  }

  default:
    console.log(fs.readFileSync(new URL(import.meta.url), "utf-8").split("\n").slice(2, 18).join("\n"));
    process.exit(1);
}
