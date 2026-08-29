# Agentic SDLC Orchestration Layer

An orchestration layer that drives a full software lifecycle — requirements, design, implementation, testing, documentation — through Claude Code subagents under enforced governance. The URL shortener it builds is the workload, not the deliverable.

---

## Quick start

```bash
npm install
npm run plan               # print the dependency graph, run nothing
npm run run                # execute the pipeline
npm run run -- --resume    # re-run only the stages that did not pass last time
npm run metrics            # reliability metrics from the audit log
```

Requires Node 22+ and the `claude` CLI on `PATH`. Set `CLAUDE_BIN` to override.

---

## Layout

```
.claude/
  settings.json         hook wiring
  agents/               subagent definitions (tool-scoped)
  hooks/hook.ts         policy enforcement + audit logging
orchestrator/
  stages.ts             the pipeline, as data
  graph.ts              graph validation + stage readiness
  runner.ts             the execution loop
  metrics.ts            metrics derived from the audit log
inbox/request.md        the incoming requirement
artifacts/              stage outputs — the context channel between stages
src/  tests/            the workload being built
```

---

## The orchestration layer

### `stages.ts` — the pipeline
The dependency graph, declared as data. Each stage names its `dependsOn`, its input and output artifact paths, and a one-sentence prompt. **Execution order is never written down** — it's computed from the dependencies.

### `graph.ts` — graph validation and stage readiness
`validateDag` rejects cycles and dangling edges before anything runs. `readyStages` returns every stage whose dependencies have passed. One result is a sequential path; two are parallel — same mechanism, no special casing.

The file holds no state. The runner owns stage status in an in-memory map and passes it in. By default every run starts cold; `npm run run -- --resume` seeds that map from the most recent recorded outcome of each stage in the audit log — `stage_passed` / `stage_skipped` carries over, a failed or interrupted stage comes back pending — so an interrupted run picks up where it stopped, across repeated resumes, with no separate `state.json` to drift from the record. Only the runner writes status, so an agent cannot mark itself passed.

### `runner.ts` — the execution loop
Repeatedly asks for ready stages and runs them. For each: entry gate → invoke the subagent → exit gate. A stage gets one attempt per run; if it fails it stays failed, and the run ends once nothing else is ready. `npm run run -- --resume` then replays the audit log, carries over whatever already passed, and gives the failed or interrupted stages a fresh attempt. Parallel stages run directly against the shared working tree — `implement` and `write_tests` are guaranteed by the design contract to never touch the same file, so no isolation is needed. The runner does not commit on your behalf; git history is entirely the operator's call.

### `hook.ts` — governance
Runs inside Claude Code on every `PreToolUse`. Exit code 2 blocks the call and returns the reason to the agent. Two controls:

- **No publish** — agents commit locally but can never push. Covers `git push`, `gh pr`, `npm publish`, remote mutation, and compound statements that chain them.
- **Destructive commands** — `rm -rf`, `git filter-branch`, and raw writes to block devices are denied outright.

Denials are logged, not silent: the record of what the system refused to do is the evidence of controlled autonomy.

### `metrics.ts` — reliability metrics
Success rate (stages passed / stages attempted), rollback frequency, MTTR, and end-to-end latency, all derived from `audit.jsonl`. Nothing is tracked in a parallel counter, so the metrics can't drift from the record. Metrics with no qualifying events report `n/a` rather than zero.

### The audit log
`.orchestrator/audit.jsonl` — append-only, two writers (hooks for tool-level events, runner for stage boundaries), no coordination needed. The single source of truth.

### Subagents
Three, in `.claude/agents/`. Each runs in a fresh context window with scoped tools. Because a subagent's context starts empty and the prompt is the only channel into it, cross-stage context has to travel through artifacts on disk — the architecture enforces the lineage requirement rather than relying on discipline.

---

## Scenarios

A. Greenfield  — build from cold start; parallel implementation stages 

B. Brownfield  — add analytics; impact_analysis artifact reasons about the store-interface extension.

C. Ambiguous   — "make it reliable at scale"; clarification memo, no code written


---

## Scope

**Built:** dependency graph with gates, sequential and parallel execution with synchronization, cross-stage context and lineage, policy guardrails, audit log, derived metrics.

**Designed but not implemented:** dynamic re-planning on upstream change. Input hashes give the detection primitive; staleness propagation and subgraph re-execution were scoped out under time constraints. See `agentic-orchestration-requirements.md`.

**Known limitations:** local execution only (no distributed scheduler); illustrative rather than regulation-mapped compliance rules; metrics computed over a handful of runs. `--resume` recovers an interrupted run by replaying the audit log, but there is still no automatic in-run retry — a stage that fails stays failed until the next invocation. No graceful in-flight halt — a run in progress can only be stopped by killing the process; a stage-boundary safe-stop was out of scope for this prototype.