# Agentic SDLC Orchestration Layer

An orchestration layer that drives a full software lifecycle — requirements, design, implementation, testing, documentation — through Claude Code subagents under enforced governance. The URL shortener it builds is the workload, not the deliverable.

---

## Quick start

```bash
npm install
npm run plan          # print the dependency graph, run nothing
npm run run           # execute the pipeline
npm run metrics       # reliability metrics from the audit log
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
  state.ts              run state + graph functions
  runner.ts             the execution loop
  metrics.ts            metrics derived from the audit log
  orch.ts               CLI for approvals, safe-stop, rollback
inbox/request.md        the incoming requirement
artifacts/              stage outputs — the context channel between stages
src/  tests/            the workload being built
```

---

## The orchestration layer

### `stages.ts` — the pipeline
The dependency graph, declared as data. Each stage names its `dependsOn`, its input and output artifact paths, and a one-sentence prompt. **Execution order is never written down** — it's computed from the dependencies.

### `state.ts` — state and graph functions
`validateDag` rejects cycles and dangling edges before anything runs. `readyStages` returns every stage whose dependencies have passed. One result is a sequential path; two are parallel — same mechanism, no special casing. The `State` class persists to `.orchestrator/state.json` with atomic writes, so a killed run resumes instead of restarting.

`state.ts` is code. `state.json` is the inert file it writes. Only the runner touches it, so an agent cannot mark itself passed.

### `runner.ts` — the execution loop
Repeatedly asks for ready stages and runs them. For each: entry gate → invoke the subagent → exit gate → commit or roll back. Parallel stages run in isolated git worktrees. Every passing stage commits its outputs, which is both the lineage record and how a parallel stage sees its inputs (worktrees branch from HEAD).

### `hook.ts` — governance
Runs inside Claude Code on every tool call. Exit code 2 blocks the call and returns the reason to the agent. Four controls:

- **Write scope** — nothing outside the project or its worktrees.
- **Per-stage write allowlist** — analysis stages may write only `artifacts/`; `write_tests` may write only `tests/` and `implement` only `src/`, so the stage that writes the tests cannot touch the code and the stage that fixes the code cannot touch the tests. This is what makes the reasoning artifacts real rather than retroactive.
- **No publish** — agents commit locally but can never push. Covers `git push`, `gh pr`, `npm publish`, remote mutation, and compound statements that chain them.
- **Safe-stop** — a sentinel file halts all agent activity at the next tool call.

Schema writes additionally require a human approval token. Denials are logged, not silent: the record of what the system refused to do is the evidence of controlled autonomy.

### `orch.ts` — operator CLI
Approvals, safe-stop, and manual worktree rollback. `tsx orch.ts approve` writes the approval token and logs who granted it.

### `metrics.ts` — reliability metrics
Success rate, retry frequency, rollback frequency, MTTR, and end-to-end latency, all derived from `audit.jsonl`. Nothing is tracked in a parallel counter, so the metrics can't drift from the record. Metrics with no qualifying events report `n/a` rather than zero.

### The audit log
`.orchestrator/audit.jsonl` — append-only, two writers (hooks for tool-level events, runner for stage boundaries), no coordination needed. The single source of truth.

### Subagents
Three, in `.claude/agents/`. Each runs in a fresh context window with scoped tools. Because a subagent's context starts empty and the prompt is the only channel into it, cross-stage context has to travel through artifacts on disk — the architecture enforces the lineage requirement rather than relying on discipline.

---

## Scenarios

> **TODO** — fill in as each is run.

<!--
  A. Greenfield  — build from cold start; parallel implementation stages
  B. Brownfield  — add analytics; impact_analysis artifact + approval halt on schema
  C. Ambiguous   — "make it reliable at scale"; clarification memo, no code written
  For each: the request, what the graph did, and what the audit log shows.
-->

---

## Scope

**Built:** dependency graph with gates, sequential and parallel execution with synchronization, cross-stage context and lineage, approval checkpoints, bounded retries, worktree rollback, safe-stop, policy guardrails, audit log, derived metrics.

**Designed but not implemented:** dynamic re-planning on upstream change. Input hashes give the detection primitive; staleness propagation and subgraph re-execution were scoped out under time constraints. See `agentic-orchestration-requirements.md`.

**Known limitations:** local execution only (no distributed scheduler); single-user CLI approvals; illustrative rather than regulation-mapped compliance rules; metrics computed over a handful of runs.