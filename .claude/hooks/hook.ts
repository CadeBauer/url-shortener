#!/usr/bin/env tsx
/**
 * hook.ts — single entry point for PreToolUse and PostToolUse.
 *
 * One script, dispatching on event name, so there is exactly one writer to the
 * audit log and one place where policy lives.
 *
 * Contract (Claude Code hooks):
 *   - event JSON arrives on stdin
 *   - exit 0  -> allow
 *   - exit 2  -> BLOCK the tool call; stderr is returned to the model as the reason
 *   - exit 2 only blocks on PreToolUse; PostToolUse is observe-only
 *
 * Install: see .claude/settings.json
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const PROJECT_ROOT = path.resolve(process.env.PROJECT_ROOT ?? process.cwd());
const ORCH = path.join(PROJECT_ROOT, ".orchestrator");
const AUDIT_LOG = path.join(ORCH, "audit.jsonl");
const STOP_FILE = path.join(ORCH, "STOP");
const APPROVALS = path.join(ORCH, "approvals");

/** Paths that require explicit human approval before an agent may write them. */
const APPROVAL_REQUIRED = [/migrations?\//, /schema\.(sql|ts|js)$/, /models?\.ts$/];

/** Shell patterns denied outright. */
const DENIED_COMMANDS: [RegExp, string][] = [
  [/\brm\s+-rf\b/, "destructive_command"],
  [/git\s+filter-branch\b/, "destructive_command"],
  [/>\s*\/dev\/sd[a-z]/, "destructive_command"],
];

/**
 * Nothing leaves this machine. Agents may commit locally; publishing is a
 * human action. Covers push and every other command that mutates a remote or
 * opens a PR, including the shorthands that do an implicit push.
 */
const NO_PUBLISH: [RegExp, string][] = [
  [/\bgit\s+push\b/, "git push"],
  [/\bgit\s+(remote|submodule)\s+(add|set-url)\b/, "git remote mutation"],
  [/\bgit\s+(send-email|request-pull|svn\s+dcommit|p4\s+submit)\b/, "git publish"],
  [/\bgh\s+(pr|release|repo|api|gist)\b/, "gh CLI"],
  [/\bglab\s+(mr|release)\b/, "glab CLI"],
  [/\bhub\s+(push|pull-request)\b/, "hub CLI"],
  [/\bgit\s+(pp|publish)\b/, "git alias"],
  [/\bnpm\s+publish\b/, "npm publish"],
  [/\b(twine|cargo)\s+(upload|publish)\b/, "package publish"],
];

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/**
 * Which paths each stage may write. Stages not listed are unrestricted within
 * the project. This is what makes the reasoning artifacts real: an analysis
 * stage physically cannot skip ahead and start writing source, and the test
 * stage cannot make a red suite green by editing the code under test.
 */
const STAGE_WRITE_SCOPE: Record<string, string[]> = {
  requirements:    ["artifacts/"],
  impact_analysis: ["artifacts/"],
  design:          ["artifacts/"],
  implement:       ["src/"],
  write_tests:     ["tests/"],
  verify:          ["src/", "artifacts/"],
  document:        ["README.md"],
};

// ---------------------------------------------------------------------------
// Audit log — the single source of truth for every metric
// ---------------------------------------------------------------------------

function currentStage(): string {
  const f = path.join(ORCH, "current_stage");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf-8").trim() : "unassigned";
}

function emit(event: string, actor: string, detail: Record<string, unknown> = {}) {
  fs.mkdirSync(ORCH, { recursive: true });
  fs.appendFileSync(
    AUDIT_LOG,
    JSON.stringify({
      ts: Date.now() / 1000,
      stage: currentStage(),
      event,
      actor,
      ...detail,
    }) + "\n",
  );
}

/** Log the denial, then block the call with the reason surfaced to Claude. */
function deny(reason: string, rule: string, detail: Record<string, unknown> = {}): never {
  emit("policy_denied", "system", { rule, reason, ...detail });
  process.stderr.write(`BLOCKED by orchestration policy [${rule}]: ${reason}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Path resolution — worktrees are legitimate write targets
// ---------------------------------------------------------------------------

function allowedRoots(): string[] {
  const roots = [PROJECT_ROOT];
  try {
    const out = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 5000,
    }).stdout;
    for (const line of (out ?? "").split("\n")) {
      if (line.startsWith("worktree ")) roots.push(path.resolve(line.slice(9)));
    }
  } catch {
    /* git absent or not a repo; project root alone still applies */
  }
  return roots;
}

function insideAllowed(p: string): boolean {
  const resolved = path.resolve(p);
  return allowedRoots().some(
    (r) => resolved === r || resolved.startsWith(r + path.sep),
  );
}

/**
 * Path of `p` relative to whichever allowed root contains it (project root or
 * an active worktree), using forward slashes. A `worktrees/<id>/` prefix is
 * stripped so a write inside a worktree is scoped exactly like the same write
 * in the main tree — otherwise every worktree write fails the stage check.
 */
function projectRelativePath(p: string): string {
  const resolved = path.resolve(p);
  let base = PROJECT_ROOT;
  for (const r of allowedRoots()) {
    if (
      (resolved === r || resolved.startsWith(r + path.sep)) &&
      r.length > base.length
    ) {
      base = r;
    }
  }
  const rel = path.relative(base, resolved).split(path.sep).join("/");
  return rel.replace(/^worktrees\/[^/]+\//, "");
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** A sentinel file halts all agent activity at the next tool call. */
function checkSafeStop() {
  if (fs.existsSync(STOP_FILE)) {
    deny("Safe-stop is engaged. Remove .orchestrator/STOP to resume.", "safe_stop");
  }
}

/** Policy guardrail: no writes outside the project or its worktrees. */
function checkWriteScope(input: Record<string, any>) {
  const raw = input.file_path ?? input.notebook_path;
  if (!raw) return;
  if (!insideAllowed(raw)) {
    deny(
      `Write to '${raw}' is outside the project and its worktrees.`,
      "write_scope",
      { path: raw },
    );
  }

  // Per-stage write allowlist. A listed stage may only write under one of its
  // allowed prefixes; unlisted stages are unrestricted within the project.
  const stage = currentStage();
  const scope = STAGE_WRITE_SCOPE[stage];
  if (scope) {
    const rel = projectRelativePath(raw);
    if (!scope.some((prefix) => rel === prefix.replace(/\/$/, "") || rel.startsWith(prefix))) {
      deny(
        `Stage '${stage}' may only write under: ${scope.join(", ")}. ` +
          `Target '${rel}' is outside that scope.`,
        "stage_write_scope",
        { path: raw, stage, relative: rel },
      );
    }
  }
}

/** Human approval checkpoint: schema changes need a signed token. */
function checkApproval(input: Record<string, any>) {
  const raw: string = input.file_path ?? "";
  if (!APPROVAL_REQUIRED.some((p) => p.test(raw))) return;

  const token = path.join(APPROVALS, `${currentStage()}.granted`);
  if (fs.existsSync(token)) {
    emit("approval_verified", "system", { path: raw, token });
    return;
  }

  emit("approval_requested", "system", { path: raw });
  deny(
    `'${raw}' is a schema change and requires human approval. Stop and ` +
      `summarize the intended change for the operator. After approval, the ` +
      `operator runs: ./orch approve`,
    "approval_required",
    { path: raw },
  );
}

/**
 * Inspect each statement in a command line separately.
 *
 * Splitting on ; && || | and newlines matters: a single Bash call can chain an
 * innocent command to a denied one, and scanning the whole string as a unit is
 * easy to slip past with a prefix that looks harmless.
 */
function checkCommand(input: Record<string, any>) {
  const raw: string = input.command ?? "";
  for (const stmt of raw.split(/;|&&|\|\||\||\n/).map((s) => s.trim())) {
    if (!stmt) continue;
    for (const [pattern, rule] of DENIED_COMMANDS) {
      if (pattern.test(stmt)) {
        deny(
          `Command matches a denied destructive pattern: ${pattern.source}`,
          rule,
          { command: stmt.slice(0, 200) },
        );
      }
    }
    for (const [pattern, what] of NO_PUBLISH) {
      if (pattern.test(stmt)) {
        deny(
          `'${what}' is blocked: agents may commit locally but never publish. ` +
            `Commit your work and leave pushing to the operator.`,
          "no_publish",
          { command: stmt.slice(0, 200), mechanism: what },
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------

function main() {
  let event: Record<string, any>;
  try {
    event = JSON.parse(fs.readFileSync(0, "utf-8"));
  } catch {
    process.exit(0); // never break the session on a malformed payload
  }

  const name = event.hook_event_name ?? "";
  const tool = event.tool_name ?? "";
  const input = event.tool_input ?? {};

  if (name === "PreToolUse") {
    checkSafeStop();
    if (WRITE_TOOLS.has(tool)) {
      checkWriteScope(input);
      checkApproval(input);
    } else if (tool === "Bash") {
      checkCommand(input);
    }
    process.exit(0);
  }

  if (name === "PostToolUse") {
    const detail: Record<string, unknown> = { tool };
    if (input.file_path) detail.path = input.file_path;
    if (tool === "Bash") detail.command = String(input.command ?? "").slice(0, 200);
    emit("tool_used", "agent", detail);
    process.exit(0);
  }

  process.exit(0);
}

main();
