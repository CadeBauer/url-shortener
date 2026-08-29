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
    outputs: [
      "artifacts/design/architecture.md",
      "artifacts/design/contract.md",
    ],
    // impact_analysis is a dependency but not an input: on greenfield the
    // stage is skipped and the entry gate would hard-fail on a missing file.
    // The prompt reads it opportunistically instead.
    prompt:
      "Read artifacts/requirements/spec.md and, if it exists, " +
      "artifacts/impact/impact_analysis.md. Write artifacts/design/" +
      "architecture.md covering components, recording each significant choice with its rationale and " +
      "consequences. Then write artifacts/design/contract.md as the exact " +
      "interface both downstream branches build against without seeing each " +
      "other: every source file path, every exported symbol with its full " +
      "TypeScript signature, and a route table giving method, path, request " +
      "shape, status codes and response shape including every error case.",
  },

  // ---- parallel branch: split by file space, not by layer ---------------
  //   implement writes src/, write_tests writes tests/ — disjoint by
  //   construction, so the same shape works for greenfield and brownfield.
  {
    id: "implement",
    agent: "implementer",
    dependsOn: ["design"],
    inputs: [
      "artifacts/design/architecture.md",
      "artifacts/design/contract.md",
    ],
    outputs: ["src/storage.ts", "src/api.ts", "src/main.ts"],
    prompt:
      "Implement under src/ exactly as artifacts/design/contract.md " +
      "specifies — same file paths, exported names, signatures, routes and " +
      "status codes. Keep storage behind an interface with no HTTP concerns " +
      "in it. Reject any target URL that resolves to a private or loopback " +
      "address. Wire it together in src/main.ts. Confirm it typechecks with " +
      "`npx tsc --noEmit` — do not start a server or run any command that " +
      "does not return on its own. Do not touch anything under tests/.",
  },
  {
    id: "write_tests",
    agent: "test-engineer",
    dependsOn: ["design"],
    inputs: ["artifacts/design/contract.md"],
    outputs: ["tests/shortener.test.ts"],
    prompt:
      "Write the suite in tests/shortener.test.ts against artifacts/design/" +
      "contract.md alone: cover create, redirect, expiry, and at least one " +
      "negative test proving a private-IP target is rejected. The " +
      "implementation is being written concurrently and may not be on disk " +
      "yet — write the tests, do not run them, do not create or modify " +
      "anything under src/, and import only symbols the contract declares.",
  },

  // ---- join: waits for both -----------------------------------------
  {
    id: "verify",
    agent: "implementer",
    dependsOn: ["implement", "write_tests"],
    inputs: ["src/main.ts", "tests/shortener.test.ts"],
    outputs: ["artifacts/test/results.md"],
    prompt:
      "Install dependencies, then run the suite against the merged source " +
      "with `npx mocha --exit --timeout 10000` (or the project's `npm test` " +
      "script). Never leave a command running and never wait on one that " +
      "does not return — if a run hangs instead of finishing, that is a bug " +
      "in src/ to fix, not something to wait out. Fix src/ until it is " +
      "green; you may not edit, skip or delete a test to get there. Write " +
      "artifacts/test/results.md with the final test output, every fix you " +
      "made, and any place the implementation and the contract disagreed.",
  },
  {
    id: "document",
    agent: "implementer",
    dependsOn: ["verify"],
    inputs: ["src/main.ts", "artifacts/test/results.md"],
    outputs: ["README.md"],
    prompt:
      "Write README.md with setup and run instructions and a short " +
      "description of every endpoint.",
  },
];
