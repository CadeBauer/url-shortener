/**
 * stages.ts — the pipeline, as data.
 *
 * This is the explicit dependency graph. Order of execution is never written
 * down anywhere; it is computed from `dependsOn`. Two stages run in parallel
 * precisely when neither depends on the other.
 *
 * Each stage carries a one-sentence prompt. The runner passes it to Claude
 * Code verbatim along with the input paths, because a subagent's context
 * starts fresh and the prompt is the only channel into it.
 */

export interface Stage {
  id: string;
  agent: string;
  dependsOn: string[];
  inputs: string[];
  outputs: string[];
  prompt: string;
  /** Run in an isolated git worktree so parallel stages cannot collide. */
  worktree?: boolean;
  maxRetries?: number;
  /** Skip when this directory is empty — greenfield has nothing to analyse. */
  skipIfEmpty?: string;
}

export const STAGES: Stage[] = [
  {
    id: "requirements",
    agent: "analyst",
    dependsOn: [],
    inputs: ["inbox/request.md"],
    outputs: ["artifacts/requirements/spec.md"],
    prompt:
      "Read inbox/request.md and write a clear, unambiguous engineering spec " +
      "to artifacts/requirements/spec.md, listing anything genuinely " +
      "underspecified in artifacts/requirements/open_questions.md.",
  },
  {
    id: "impact_analysis",
    agent: "analyst",
    dependsOn: ["requirements"],
    inputs: ["artifacts/requirements/spec.md"],
    outputs: ["artifacts/impact/impact_analysis.md"],
    skipIfEmpty: "src",
    prompt:
      "Read the spec and the existing code under src/, then write " +
      "artifacts/impact/impact_analysis.md naming every module, endpoint and " +
      "data flow this change touches and the blast radius of each.",
  },
  {
    id: "design",
    agent: "analyst",
    dependsOn: ["requirements", "impact_analysis"],
    inputs: ["artifacts/requirements/spec.md"],
    outputs: ["artifacts/design/architecture.md"],
    prompt:
      "Read the spec and write artifacts/design/architecture.md covering " +
      "components, the storage interface and the API surface, recording each " +
      "significant choice with its rationale and consequences.",
  },

  // ---- parallel branch: neither depends on the other ---------------------
  {
    id: "implement_storage",
    agent: "implementer",
    dependsOn: ["design"],
    inputs: ["artifacts/design/architecture.md"],
    outputs: ["src/storage.ts"],
    worktree: true,
    prompt:
      "Following the architecture doc, implement the SQLite storage layer in " +
      "src/storage.ts behind a small interface, with no HTTP concerns in it.",
  },
  {
    id: "implement_api",
    agent: "implementer",
    dependsOn: ["design"],
    inputs: ["artifacts/design/architecture.md"],
    outputs: ["src/api.ts"],
    worktree: true,
    maxRetries: 2,
    prompt:
      "Following the architecture doc, implement the Express routes in " +
      "src/api.ts for link creation, redirect and health, rejecting any " +
      "target URL that resolves to a private or loopback address.",
  },

  // ---- join: waits for both ---------------------------------------------
  {
    id: "integrate",
    agent: "implementer",
    dependsOn: ["implement_storage", "implement_api"],
    inputs: ["src/storage.ts", "src/api.ts"],
    outputs: ["src/main.ts"],
    prompt:
      "Wire the storage layer and API together in src/main.ts and confirm the " +
      "application compiles and starts cleanly.",
  },

  {
    id: "test",
    agent: "test-engineer",
    dependsOn: ["integrate"],
    inputs: ["src/main.ts"],
    outputs: ["tests/shortener.test.ts"],
    maxRetries: 2,
    prompt:
      "Write tests in tests/shortener.test.ts covering create, redirect, " +
      "expiry and at least one negative test proving a private-IP target is " +
      "rejected, then run them; do not modify anything under src/.",
  },
  {
    id: "document",
    agent: "implementer",
    dependsOn: ["integrate"], // parallel with `test`
    inputs: ["src/main.ts"],
    outputs: ["README.md"],
    prompt:
      "Write README.md with setup and run instructions and a short " +
      "description of every endpoint.",
  },
];
