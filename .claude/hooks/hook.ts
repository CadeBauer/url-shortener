#!/usr/bin/env tsx
/**
 * hook.ts — PreToolUse policy gate for the orchestrator.
 *
 * One script, one place where policy lives, one writer to the audit log.
 *
 * Contract (Claude Code hooks):
 *   - event JSON arrives on stdin
 *   - exit 0  -> allow
 *   - exit 2  -> BLOCK the tool call; stderr is returned to the model as the reason
 *
 * Install: see .claude/settings.json
 */

import * as fs from "node:fs";
import * as path from "node:path";

const PROJECT_ROOT = path.resolve(process.env.PROJECT_ROOT ?? process.cwd());
const ORCH = path.join(PROJECT_ROOT, ".orchestrator");
const AUDIT_LOG = path.join(ORCH, "audit.jsonl");

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
// Controls
// ---------------------------------------------------------------------------

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

  if ((event.hook_event_name ?? "") !== "PreToolUse") process.exit(0);

  const tool = event.tool_name ?? "";
  const input = event.tool_input ?? {};

  if (tool === "Bash") {
    checkCommand(input);
  }
  process.exit(0);
}

main();
