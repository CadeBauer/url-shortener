// Mocha configuration for the URL-shortener test suite.
//
// The suite is TypeScript (`tests/shortener.test.ts`) and the package is
// `"type": "module"`, so the spec file is loaded as ESM. Per contract §9 the
// intended loader is `ts-node/register`; however this repo pins
// `typescript@7` (the native compiler, which does not expose the JS compiler
// API that `ts-node` depends on), so `ts-node` cannot transpile here. The
// contract's approved fallback is `tsx`, registered as a Node ESM loader.
// See artifacts/test/results.md for the deviation note.

module.exports = {
  spec: ["tests/**/*.test.ts"],
  extension: ["ts"],
  "node-option": ["import=tsx"],
  timeout: 5000,
};
