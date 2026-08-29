#!/usr/bin/env tsx
/**
 * metrics.ts — derive reliability metrics from .orchestrator/audit.jsonl
 *
 * Every number here is computed from the log. Nothing is tracked in a parallel
 * counter, so the log stays the single source of truth and the metrics cannot
 * drift from the record.
 *
 * Metrics with no qualifying events report "n/a (no qualifying events)" rather
 * than zero. Zero and "never happened" are different claims, and only one of
 * them is honest.
 *
 *   tsx metrics.ts
 */

import * as fs from "node:fs";

const LOG = ".orchestrator/audit.jsonl";

interface Event {
  ts: number;
  stage: string;
  event: string;
  actor: string;
  [k: string]: unknown;
}

function load(): Event[] {
  if (!fs.existsSync(LOG)) {
    console.error(`no audit log at ${LOG}`);
    process.exit(1);
  }
  const events: Event[] = [];
  for (const line of fs.readFileSync(LOG, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* skip malformed lines rather than abort the report */
    }
  }
  return events.sort((a, b) => a.ts - b.ts);
}

const fmt = (s: number) => (s >= 60 ? `${(s / 60).toFixed(1)}m` : `${s.toFixed(1)}s`);
const pad = (s: string, n: number) => s.padEnd(n);

function main() {
  const events = load();
  if (!events.length) {
    console.error("audit log is empty");
    process.exit(1);
  }

  const of = (t: string) => events.filter((e) => e.event === t);
  const started = of("stage_started");
  const passed = of("stage_passed");
  const denials = of("policy_denied");
  const stagesOf = (es: Event[]) => new Set(es.map((e) => e.stage));

  console.log("\n" + "=".repeat(58));
  console.log("  ORCHESTRATION RELIABILITY METRICS");
  console.log("=".repeat(58));

  // -- end-to-end latency ---------------------------------------------------
  const e2e = events[events.length - 1].ts - events[0].ts;
  console.log(`\nEnd-to-end latency      ${fmt(e2e)}`);
  console.log(`Total events            ${events.length}`);

  // -- success rate ---------------------------------------------------------
  const attempted = stagesOf(started).size;
  const succeeded = stagesOf(passed).size;
  console.log(
    attempted
      ? `\nSuccess rate            ${succeeded}/${attempted} ` +
          `(${Math.round((100 * succeeded) / attempted)}%)`
      : "\nSuccess rate            n/a (no stage_started events)",
  );

  // -- MTTR ------------------------------------------------------------------
  const openFailures = new Map<string, number>();
  const recoveries: number[] = [];
  for (const e of events) {
    if (e.event === "stage_failed" && !openFailures.has(e.stage)) {
      openFailures.set(e.stage, e.ts);
    } else if (e.event === "stage_passed" && openFailures.has(e.stage)) {
      recoveries.push(e.ts - openFailures.get(e.stage)!);
      openFailures.delete(e.stage);
    }
  }
  console.log(
    recoveries.length
      ? `MTTR                    ${fmt(
          recoveries.reduce((a, b) => a + b, 0) / recoveries.length,
        )} (n=${recoveries.length})`
      : "MTTR                    n/a (no failure/recovery pairs)",
  );

  // -- governance ------------------------------------------------------------
  console.log(`\nPolicy denials          ${denials.length}`);
  const byRule = new Map<string, number>();
  for (const d of denials) {
    const r = String(d.rule ?? "?");
    byRule.set(r, (byRule.get(r) ?? 0) + 1);
  }
  for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${pad(rule, 24)} ${n}`);
  }

  // -- per-stage breakdown ---------------------------------------------------
  console.log("\nPer-stage");
  console.log(`  ${pad("stage", 22)}${"duration".padStart(10)}${"tool calls".padStart(12)}`);

  const opens = new Map<string, number>();
  const durations = new Map<string, number>();
  for (const e of events) {
    if (e.event === "stage_started") opens.set(e.stage, e.ts);
    else if (e.event === "stage_passed" && opens.has(e.stage)) {
      durations.set(e.stage, e.ts - opens.get(e.stage)!);
      opens.delete(e.stage);
    }
  }

  const toolCalls = new Map<string, number>();
  for (const e of of("tool_used")) {
    toolCalls.set(e.stage, (toolCalls.get(e.stage) ?? 0) + 1);
  }

  for (const stage of [...new Set(events.map((e) => e.stage))]) {
    if (stage === "unassigned") continue;
    const d = durations.has(stage) ? fmt(durations.get(stage)!) : "—";
    console.log(
      `  ${pad(stage, 22)}${d.padStart(10)}${String(toolCalls.get(stage) ?? 0).padStart(12)}`,
    );
  }

  console.log();
}

main();
