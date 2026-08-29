# URL Shortener — Impact Analysis

Source spec: `artifacts/requirements/spec.md`
Open questions: `artifacts/requirements/open_questions.md`
Codebase state examined: working tree at branch `main`, commit `1845a97` plus
one uncommitted modification to `orchestrator/runner.ts`.

---

## 0. Preliminary finding: this is a greenfield change

`src/` contains only `src/.gitkeep`. `tests/` contains only `tests/.gitkeep`.
There is **no existing application code** — no modules, no endpoints, no data
flows to modify. Every module, endpoint, and data flow named below is **net
new**.

Consequences for this analysis:

- The orchestrator would normally **skip** this stage: `orchestrator/stages.ts:42`
  marks `impact_analysis` with `skipIfEmpty: "src"`, and `orchestrator/runner.ts:192-206`
  sets such a stage to `skipped` when the probe directory is empty. This document
  exists because it was explicitly requested; it is being produced against an
  empty `src/`.
- "Blast radius" here therefore means: (a) coupling **between the new modules**
  that will be created, (b) the **downstream pipeline stages** that consume these
  files as inputs, (c) **configuration / dependency / tooling** changes required
  to make the new code run, and (d) the one **pre-existing file** with pending
  changes (`orchestrator/runner.ts`), which is out of scope for the shortener but
  part of the working tree.
- There are **no backward-compatibility constraints** on the HTTP surface or the
  data model, because there is no prior release, no persisted data, and no
  existing client. All persistence is in-memory and discarded on restart
  (spec NFR-13).

### Spec references to artifacts / code that do not yet exist

| Reference in spec | Status | Impact |
| --- | --- | --- |
| `artifacts/design/contract.md` (spec §3 FR-1, §4.1 FR-11, §4.3 FR-17, §6) — "exact exported symbol names and signatures", "exact JSON key names" | **Does not exist.** Produced by the `design` stage (`orchestrator/stages.ts:48-69`). | Every exported symbol name, factory signature, and JSON field name in this analysis is provisional. The `implement` and `write_tests` stages build against `contract.md` **without seeing each other** (`orchestrator/stages.ts:71-104`); any gap in `contract.md` becomes a merge failure at `verify`. |
| `orchestrator/stages.ts` — "blocked ranges enumerated in the design" (spec FR-4.3) | Ranges **not enumerated** anywhere in the repo. Proposed in OQ-3 only. | SSRF blocklist is undefined until `design` fixes it. High-risk area (see §7). |
| `orchestrator/stages.ts` establishes "reject private/loopback target URLs" | Present at `orchestrator/stages.ts:87-88` (implement prompt) — a one-line instruction, no detail. | The only normative source for the SSRF requirement is a prompt string, not a spec section with test vectors. |
| `ts-node` toolchain (spec §2, §13 FR-22) | **Not in `package.json`.** Repo uses `tsx` (`package.json:15`) and `"type": "module"` (`package.json:6`). | Toolchain conflict, OQ-1. High-risk (see §7). |
| `express`, `mocha`, `chai`, `@types/*` (spec §2.1) | **None in `package.json`.** | `implement` / `verify` stages must add them. Express must be 4.x; repo runs TypeScript `^7.0.2` and `@types/node ^26` (`package.json:13-17`) — unusually new; `@types/express@4` compatibility with `tsc` 7.x is unverified. |
| `tsconfig.json` "fixed by repo" (spec §2) | Present (`tsconfig.json`), but `module: ESNext` + `moduleResolution: bundler` + `allowImportingTsExtensions: true` (`tsconfig.json:4-8`) is a bundler-oriented config, not a `ts-node` one. | May force a second `tsconfig` for `src/`+`tests/` (OQ-1 fallback). |

---

## 1. Summary of the change

Build, from nothing, an HTTP URL-shortener service as a single Node process with
an in-memory store behind an async `LinkStore` interface (spec §1). Deliverables:

- **Three HTTP endpoints** (spec §4):
  - `POST /api/links` — create a short link; validated `url`, optional
    `custom_alias`, optional `expires_at`, optional `force_new`; idempotent per
    `(url, custom_alias)`; `201` on create, `200` on idempotent hit.
  - `GET /:code` — `302` redirect to the target URL; records a click as a
    deferred, non-blocking side effect; `404` for unknown, `410` for expired.
  - `GET /api/links/:code` — link metadata plus computed analytics (total clicks,
    daily time series, top referrers, user-agent breakdown).
- **Short-code generation**: 7-char base62, `crypto.randomBytes` only
  (`Math.random` prohibited), rejection sampling to avoid modulo bias, bounded
  collision retry (max 5, then `500` + logged alert) (spec FR-7, FR-8).
- **Custom aliases**: charset allowlist `^[A-Za-z0-9_-]{3,32}$`, reserved words
  `api/admin/static/docs` (case-insensitive), `409` on conflict (spec FR-5).
- **Expiry**: `expires_at` must parse ISO 8601 and be strictly future; expired
  links return `410 Gone`, distinct from `404` (spec FR-6, FR-14).
- **Privacy**: client IPs stored only as salted HMAC-SHA-256 hashes in
  `Link.createdByIpHash` and `Click.ipHash`; raw IPs never stored, logged, or
  returned (spec NFR-1, NFR-4).
- **SSRF mitigation**: reject target URLs whose host is or resolves to a
  loopback / link-local / RFC 1918 / RFC 4193 address (spec FR-4.3, NFR-3).
- **`LinkStore`**: async interface; in-memory implementation with a primary
  `Map<code, Link>`, a secondary `Map<targetUrl, code>` index, and a
  `Map<code, Click[]>` click store (spec §5.3, FR-19/FR-20).
- **Reliability**: analytics write deferred (`setImmediate`) with its own error
  boundary; a failing `recordClick` never fails a redirect and never becomes an
  unhandled rejection (spec FR-16, NFR-10/11).
- **Unit tests**: Mocha + Chai via `ts-node/register`, covering code generation,
  collision retry, expiry, idempotency (spec §13).

---

## 2. Modules touched

All paths fixed by `orchestrator/stages.ts` (spec §3). All are **new files**.

| Module / file | Nature of change | Key contents | Blast radius / downstream dependents | Risk |
| --- | --- | --- | --- | --- |
| `src/storage.ts` | **Create.** Pure data layer, no HTTP. | `Link`, `Click` interfaces (spec §5.1/5.2 verbatim); `LinkStore` interface (spec §5.3 verbatim); `InMemoryLinkStore` class with three `Map`s (spec FR-20). MUST NOT import `express` or reference `req`/`res` (spec FR-2, AC-14). | Imported by `src/api.ts` (type + interface) and `src/main.ts` (concrete class). Imported by `tests/shortener.test.ts` (fresh instance / stub per test). The `design` stage must pin its exported names in `contract.md`; `implement` and `write_tests` both compile against those names concurrently. If the interface shape drifts from spec §5.3, every handler and every test breaks. | **Medium.** Interface is dictated verbatim by the spec, so low ambiguity; risk is in the index-maintenance semantics (OQ-11) and copy-vs-reference return policy (OQ-22). |
| `src/api.ts` | **Create.** All request handling. | `createApp(store, opts?)` factory (spec FR-1) — exact signature TBD by `contract.md`; provisionally `createApp(store: LinkStore, opts?: { generateCode?: () => string; now?: () => Date; baseUrl?: string; ipHashSalt?: string })` (OQ-27). Route registration (order-sensitive), body parsing, URL/alias/expiry validation, SSRF check, code generation + collision loop, idempotency lookup, redirect, click builder, stats aggregation, single error-handling middleware (spec FR-21). | The composition root `src/main.ts` calls `createApp`. `tests/shortener.test.ts` calls `createApp` with stubs (spec FR-24, OQ-26). This is the largest surface: every FR except FR-20 lands here. A change to the factory signature ripples to `main.ts` and every test. Route-ordering mistakes misroute `/api/links` to the `/:code` handler (spec §12.23). | **High.** Most logic, most open questions (OQ-2..OQ-13, OQ-16..OQ-21, OQ-23, OQ-27, OQ-28), highest branching. |
| `src/main.ts` | **Create.** Composition root. | Read config from env (`PORT`, `BASE_URL`, `IP_HASH_SALT`; spec §11); construct `InMemoryLinkStore`; `createApp(store, …)`; `app.listen(PORT)`. Must `tsc --noEmit` clean and start cleanly (spec AC-1). | Consumed as an input by pipeline stages `verify` (`orchestrator/stages.ts:111`) and `document` (`orchestrator/stages.ts:124`). The exit gate for `implement` requires this file non-empty (`orchestrator/runner.ts:64-75`, `orchestrator/stages.ts:82`). Runtime dependents: none (top of the graph). | **Low–Medium.** Small file; risk is env parsing, `trust proxy` decision (OQ-25), and the ESM/`ts-node` start path (OQ-1). |
| `tests/shortener.test.ts` | **Create.** Written by a **separate** stage (`write_tests`, `test-engineer` agent) concurrently with `implement`, from `contract.md` alone (`orchestrator/stages.ts:92-104`). | Mocha + Chai suite; FR-23 coverage: code generation, collision retry, expiry, idempotency. May use in-process assertions on the `createApp` object (OQ-26). MUST NOT modify `src/` (spec FR-25, `.claude/agents/test-engineer.md`). | Consumed by `verify` (`orchestrator/stages.ts:111`), which runs it against the merged source and must make it green without editing tests. Disjoint file space from `implement` by construction (`orchestrator/runner.ts:11-16`). | **Medium.** Author cannot see `src/`; relies entirely on `contract.md` accuracy and on the seams (injectable store, injectable `generateCode`/`now`) being declared there (spec FR-24, OQ-27). |

### Supporting / configuration files touched (not under `src/`)

| File | Nature of change | Blast radius | Risk |
| --- | --- | --- | --- |
| `package.json` | **Modify.** Add runtime dep `express@4.x`; dev deps `@types/express`, `mocha`, `chai`, `ts-node`, `@types/mocha`, `@types/chai` (spec §2.1). Likely add `start` and `test` scripts. `"type": "module"` currently set (`package.json:6`). | Every stage after `implement` runs in this package. `verify` installs and runs (`orchestrator/stages.ts:107-119`). Adding deps changes `package-lock.json`. Must not disturb existing `plan`/`run`/`metrics`/`typecheck` scripts or `tsx`/`typescript` versions that the orchestrator itself depends on. | **Medium.** Dependency resolution against `typescript@^7` / `@types/node@^26`; Express 4 (not 5) pin must hold. |
| `.mocharc.(json\|cjs\|yml)` | **Create (likely).** Mocha needs `--require ts-node/register` (or `--loader ts-node/esm`), spec glob `tests/**/*.test.ts`. | Only affects the test run (`verify`). Wrong loader config = unrunnable suite = `verify` fails. | **High** (part of OQ-1). |
| `tsconfig.json` | **Possibly modify / shadow.** Spec §2 says it is fixed, but OQ-1 permits a CommonJS `tsconfig` scoped to `src/`+`tests/` if ESM + `ts-node/register` proves incompatible. `orchestrator/` tooling config must not change. | A second/!changed tsconfig affects `tsc --noEmit` (AC-1) and how `ts-node` compiles. If the root config is edited, `npm run typecheck` and the orchestrator's own type expectations are affected. | **Medium–High.** Coupled to OQ-1. |
| `.env` / environment | **New env contract** (not a file to commit): `PORT` (default 3000), `BASE_URL` (default `http://localhost:${PORT}`), `IP_HASH_SALT` (default: random per process). See §5. | `main.ts` reads them; `short_url` correctness (AC-2) depends on `BASE_URL`; IP-hash comparability across restarts depends on `IP_HASH_SALT` (OQ-25). | **Low–Medium.** |
| `package-lock.json` | **Modify** (side effect of dep install). | Reproducibility of `verify`; no functional API impact. | **Low.** |

### Pre-existing file with pending changes

| File | State | Relevance |
| --- | --- | --- |
| `orchestrator/runner.ts` | **Modified, uncommitted** (`git status: M`). The diff against `HEAD` could not be inspected in this environment (no shell access); the current working-tree content was read in full. | **Out of scope for the URL-shortener change.** The `analyst` agent may not modify the orchestrator (`.claude/agents/analyst.md`), and `orchestrator/stages.ts` scopes shortener work to `src/`, `tests/`, and `artifacts/`. The pending edit is orchestration plumbing: it governs how stages are sequenced, gated (`entryGate`/`exitGate`, `runner.ts:53-75`), and skipped on greenfield (`runner.ts:192-206`). **Blast radius on the shortener: indirect only** — if the change alters the skip logic or the exit gate, it changes whether `impact_analysis` runs and whether `implement`/`verify` are considered to have passed. Recommend the operator review and commit or revert `runner.ts` separately before the pipeline runs, so stage sequencing is deterministic. |

---

## 3. Endpoints touched

All three are **new**. Handlers live in `src/api.ts`. Route registration order is
load-bearing: `/api/*` routes MUST be registered before the `GET /:code`
catch-all (spec §12.23), otherwise `GET /api/links` is captured by the redirect
handler with `code = "links"` / `"api"`.

### 3.1 `POST /api/links` — create a short link

| Aspect | Detail (spec FR-3..FR-11) |
| --- | --- |
| Method / path | `POST /api/links`, `Content-Type: application/json` |
| Handler | `src/api.ts` create handler |
| Request body | `url` (string, required), `custom_alias` (string, optional), `expires_at` (ISO 8601 string \| null, optional), `force_new` (boolean, optional, default `false`) |
| Response — create | `201` + `{ short_code, short_url, created_at, expires_at }` (FR-11). `short_url = ${BASE_URL}/${short_code}` |
| Response — idempotent hit | `200` + identical body shape (FR-9, OQ-10) |
| Error responses | `400` malformed JSON; `400` `url` missing/not string/not absolute http(s)/over 2048 chars/host resolves private; `400` alias fails allowlist; `400` alias reserved; `409` alias taken by a different link; `400` `expires_at` unparseable or not future; `500` code generation collided 5×; `500` generic. JSON body `{ error, message }` (spec §6, OQ-23) |
| Consumers affected | **None existing.** Future API clients only. No SDK, no front end (out of scope). |
| Blast radius | Owns the entire create data flow (§4.1). Downstream: the codes it mints are the keys every other endpoint reads. A wrong `short_url` base breaks AC-2. A wrong idempotency decision (OQ-11) creates duplicate links or wrongly returns an existing one — visible in `GET /api/links/:code` and in `findByTarget` behaviour. Emits the collision-exhaustion `error` log (FR-8, OQ-9). Performs DNS resolution — the only place the create path can block or throw on network I/O. |

### 3.2 `GET /:code` — redirect

| Aspect | Detail (spec FR-12..FR-16) |
| --- | --- |
| Method / path | `GET /:code` (catch-all; must be last) |
| Handler | `src/api.ts` redirect handler |
| Response — live link | `302` with `Location: <Link.targetUrl>` exactly as stored; `Cache-Control: no-store` recommended (OQ-13) |
| Response — unknown code | `404` JSON error, **no click recorded** (FR-13) |
| Response — expired link | `410 Gone` JSON error, distinct from `404`; **no click recorded** (FR-14, OQ-14) |
| Side effect | Build `Click` and call `store.recordClick` **after** the response is sent, via `setImmediate`, inside its own `try/catch`/`.catch` (FR-16). Failure is logged at `error` level and must not crash the process or raise `unhandledRejection` (NFR-10/11). |
| Request headers read | `Referer` → `Click.referrer` (or `null`); `User-Agent` → `Click.userAgent` truncated to 256 chars (or `null`) (FR-15, OQ-17). Client IP (from `req.socket.remoteAddress` per OQ-25) → `Click.ipHash` only. |
| Consumers affected | **None existing.** End users / browsers following short links. |
| Blast radius | Hot path; performance-sensitive (`findByCode` must be a single `Map.get`, spec NFR-6). The deferred-write design is the single biggest reliability risk in the service: a mistake here can crash the process on an analytics failure (NFR-11, AC-12). Click volume produced here drives every number in the stats endpoint. Route-ordering bug here swallows `/api/*`. Trailing-slash / `GET /` / `favicon.ico` behaviour is undefined (OQ-28). |

### 3.3 `GET /api/links/:code` — metadata + stats

| Aspect | Detail (spec FR-17..FR-19) |
| --- | --- |
| Method / path | `GET /api/links/:code` |
| Handler | `src/api.ts` stats handler |
| Response — known code | `200` + `{ short_code, target_url, created_at, expires_at, is_custom, total_clicks, clicks_by_day[], top_referrers[], user_agents[] }` (exact keys TBD by `contract.md`) |
| Response — unknown code | `404` JSON error (FR-19) |
| Response — expired link | `200` with full metadata + stats (NOT `410`); `expires_at` in body signals expiry (FR-19, OQ-21) |
| Stats computation | From `store.getClicks(code)` only: `total_clicks` = array length; `clicks_by_day` = group by UTC `YYYY-MM-DD`, ascending, sparse (only non-zero days, OQ-18); `top_referrers` = group by `referrer` (`null` a distinct bucket), desc by count, top 10, ties by key asc (OQ-19); `user_agents` = group by raw truncated UA string, `null` distinct, desc, top 10 (OQ-19/OQ-20) |
| Consumers affected | **None existing.** Operator / inspection tooling only. |
| Blast radius | Read-only; cannot corrupt state. Cost must scale with one link's click count, not global volume (spec NFR-8) — depends on `getClicks` returning a per-code array (spec FR-20.3). Aggregation determinism (tie-breaking, date bucketing across UTC midnight, spec §12.21) is the main correctness risk and is directly asserted by AC-10 and §12.18/19. |

### 3.4 Implicit / infrastructure endpoints

| Surface | Concern | Blast radius |
| --- | --- | --- |
| JSON body parser (`express.json()`) | Malformed JSON must yield `400` `{ error, message }` via the error middleware, not Express's default HTML (spec §6 row 1). | All of `POST /api/links`. |
| Error-handling middleware (single, `src/api.ts`) | Converts every thrown/rejected error to the JSON shape; MUST NOT leak stack traces, raw IPs, or filesystem paths (spec FR-21, NFR-5). | Every route. A leak here is a privacy/security finding (AC-17). |
| 404 fallthrough / `GET /` / `GET /favicon.ico` / trailing slash | Undefined (OQ-28). Default Express behaviour would send HTML or hit `/:code` with a junk code. | Minor; noisy `404`s, inconsistent error body. |

---

## 4. Data flows touched

All flows are **new**. No migration in the schema sense (no DB), but the
in-memory index-maintenance rules are the "schema" here and must stay internally
consistent (spec FR-20).

### 4.1 Link-creation flow

**Entry:** `POST /api/links` → `express.json()` body parse.

**Transformations (in `src/api.ts`):**
1. Extract `url`, `custom_alias?`, `expires_at?`, `force_new?`.
2. Validate `url`: non-empty string → WHATWG `URL` parse → scheme ∈ {http, https} (OQ-2) → length ≤ 2048 (OQ-4). Failure ⇒ `400`, no state change.
3. **DNS / IP-literal SSRF check** (FR-4.3, OQ-3): resolve host once; if the literal or any resolved address is loopback / link-local / RFC 1918 / RFC 4193 / `0.0.0.0/8` / `::ffff:` mapped, or host is literally `localhost` ⇒ `400`. Resolution failure ⇒ `400`. **This is async and can throw.**
4. Validate `custom_alias` if present: `^[A-Za-z0-9_-]{3,32}$` (FR-5.1) → not in `{api,admin,static,docs}` case-insensitive (FR-5.2, OQ-5).
5. Validate `expires_at` if present: ISO 8601 parse → strictly `> now` (FR-6, OQ-7). Store as UTC `Date`.
6. **Idempotency lookup** (FR-9, OQ-11): if `!force_new`, call `store.findByTarget(url)` (O(1) via secondary index, spec NFR-7). If it returns a link AND (`custom_alias` absent OR equals that link's `code`) ⇒ return it with `200`, no new code.
7. **Alias conflict** (FR-5.3): if `custom_alias` present and `store.findByCode(alias)` returns a link with a different `targetUrl` (or `force_new`) ⇒ `409`.
8. **Code generation** (FR-7): if no alias, generate 7 chars over base62 `0-9A-Za-z` (OQ-8) using `crypto.randomBytes` + rejection sampling. No `Math.random` anywhere (AC-14 spirit, NFR-12).
9. **Collision-bounded retry** (FR-8): check candidate via `store.findByCode`; on hit regenerate; max 5 attempts. All 5 collide ⇒ `500` + `console.error` alert (OQ-9), no link written.
10. **IP hash** (NFR-1, OQ-24): `HMAC-SHA-256(key = IP_HASH_SALT, msg = clientIp)` hex → `Link.createdByIpHash`. Raw IP discarded.
11. Build `Link { code, targetUrl, createdAt: now, expiresAt, isCustom, createdByIpHash }`.

**Storage (`src/storage.ts` `createLink`):** write primary `Map<code, Link>` **and** secondary `Map<targetUrl, code>` in the same operation (spec FR-20.2). Per OQ-11 the secondary index is **last-write-wins** for a repeated `targetUrl`.

**Output:** `201` (or `200`) `{ short_code, short_url: ${BASE_URL}/${code}, created_at, expires_at }`.

**Blast radius:**
- *Data integrity:* the primary map and the secondary index must never disagree. A `createLink` that updates one but not the other corrupts idempotency for that URL. `force_new` + "same URL, different alias" both repoint the index (OQ-11) — older links become unreachable via `findByTarget` but still reachable by `code`. If the design chooses different OQ-11 semantics, §12.1–12.4 and the idempotency tests (FR-23.4) change.
- *Persistence:* in-memory only; process restart wipes everything (NFR-13). No file/DB (NFR-14).
- *Schema/migration:* none. But the `Link` interface is spec §5.1 **verbatim** — deviating (adding an `id`, renaming a field) breaks the `contract.md` promise and the tests.
- *Backward compatibility:* none required (greenfield).
- *Failure modes:* DNS lookup latency/throw on the create path (step 3); randomness failure → `500` not crash (NFR-12); collision exhaustion → `500` + alert with **no partial write** (§12.17, AC-13).

### 4.2 Redirect + deferred click-capture flow

**Entry:** `GET /:code`.

**Synchronous path:**
1. `store.findByCode(code)` — single `Map.get`, O(1) (spec FR-20.1, NFR-6).
2. `null` ⇒ `404`, return (no click).
3. `link.expiresAt != null && link.expiresAt <= now()` ⇒ `410`, return (no click, OQ-14).
4. Else send `302` `Location: link.targetUrl` (+ `Cache-Control: no-store`, OQ-13). **Response ends here.**

**Deferred path (`setImmediate`, own error boundary — FR-16):**
5. Build `Click { id: crypto.randomUUID() (OQ-16), code, clickedAt: now, referrer: Referer||null, userAgent: (UA truncated 256)||null, ipHash: HMAC-SHA-256(salt, ip) }`.
6. `store.recordClick(click)` → append to `Map<code, Click[]>` bucket for `code` (spec FR-20.3).
7. Any throw/rejection ⇒ `console.error` (OQ-9), swallowed. Never `unhandledRejection`, never crash (NFR-10/11, AC-12).

**Blast radius:**
- *Data integrity:* clicks are append-only per code; a lost click (swallowed failure) undercounts stats — acceptable by design (analytics is best-effort, out-of-scope item "retry beyond a single deferred attempt"). A click recorded against the wrong `code` pollutes another link's stats.
- *Persistence:* in-memory; unbounded growth of `Click[]` per code for the process lifetime (no purge, OQ-15). Long-lived hot links grow memory without bound — noted, accepted for this stage (NFR-13).
- *Privacy:* `ipHash` must be the only IP representation; a raw IP in the `Click`, in a log line, or in the error path is an AC-17 failure and NFR-4 violation.
- *Reliability:* the `setImmediate` + `try/catch` boundary is the crux of NFR-10/11. A missing `.catch` on the `recordClick` promise = unhandled rejection = potential process exit under Node's default. Directly tested (AC-12, §12.16).
- *Performance:* click write must add zero latency to the `302` (NFR-9) — enforced by ordering (send response, then `setImmediate`).
- *Backward compatibility:* none.

### 4.3 Stats-aggregation flow (read-only)

**Entry:** `GET /api/links/:code`.

1. `store.findByCode(code)` → `null` ⇒ `404` (FR-19).
2. `store.getClicks(code)` → that code's `Click[]` only, no global scan (spec FR-20.3, NFR-8).
3. Aggregate in `src/api.ts`: `total_clicks`; `clicks_by_day` (UTC date buckets, ascending, sparse — OQ-18, §12.21); `top_referrers` (group by `referrer`, `null` bucket, desc, top 10, tie by key — OQ-19); `user_agents` (group by raw truncated string, `null` bucket, desc, top 10 — OQ-19/20).
4. `200` + metadata (`is_custom` from `Link.isCustom`, `expires_at` shows expiry state even when expired — OQ-21).

**Blast radius:**
- *Data integrity:* pure read; cannot corrupt. Correctness risk is entirely in aggregation determinism (tie-breaking, midnight boundary) — asserted by AC-10 and §12.18/19/21.
- *Performance:* O(clicks for this code); must not degrade with total click volume across links (NFR-8) — depends on `getClicks` not filtering a flat list.
- *Backward compatibility:* none; exact JSON keys pending `contract.md`.

### 4.4 Configuration / startup flow

**Entry:** `node`/`ts-node` runs `src/main.ts`.

1. Read `PORT` (default 3000), `BASE_URL` (default `http://localhost:${PORT}`, no trailing slash — OQ-12), `IP_HASH_SALT` (env, else 32 random bytes at startup — OQ-25).
2. `new InMemoryLinkStore()`.
3. `createApp(store, { baseUrl, ipHashSalt, ... })`.
4. `app.listen(PORT)` — must start without error (AC-1).

**Blast radius:**
- `BASE_URL` wrong ⇒ every `short_url` in every create response is wrong (AC-2) but links still resolve (resolution is by `code`, not `short_url`).
- `IP_HASH_SALT` unset ⇒ hashes not comparable across restarts (fine — store also wiped; OQ-25) but must be a deliberate logged-once choice, and the salt must never be logged (NFR-4).
- `trust proxy` left off (OQ-25) ⇒ behind a real proxy every client hashes to the proxy IP; acceptable for this stage, must be documented.
- Startup is also where the ESM/`ts-node` toolchain question first bites (OQ-1): `main.ts` importing `./api.ts` vs `./api.js` vs `./api`.

### 4.5 IP-hashing sub-flow (cross-cutting, used by 4.1 and 4.2)

Single helper (in `src/api.ts` or a small util) `hashIp(ip): string` = HMAC-SHA-256
hex over the per-process/env salt (OQ-24). Consumed on create (`createdByIpHash`)
and on every click (`ipHash`). **Blast radius:** a bug that returns empty string
fails AC-17; a bug that logs its input violates NFR-4; changing the algorithm
changes every stored hash (irrelevant across restarts, relevant within a run for
any test that asserts equality of two hashes of the same IP).

---

## 5. Cross-cutting concerns

| Concern | Detail | Where | Risk |
| --- | --- | --- | --- |
| **Config / env vars** | `PORT`, `BASE_URL`, `IP_HASH_SALT` (spec §11). Constants: UA truncation 256 (OQ-17), collision limit 5 (fixed), code length 7 (fixed). | `src/main.ts` reads env; `src/api.ts` receives values via `createApp` opts (so tests can override — spec FR-24). | Constants hard-coded in `api.ts` instead of injected reduce testability; `createApp` opts must expose `generateCode` and `now` at minimum (OQ-27). |
| **Randomness** | `crypto.randomBytes` for codes (rejection sampling), `crypto.randomUUID` for `Click.id`, `crypto.randomBytes` for the default salt. `Math.random` prohibited anywhere in code generation (FR-7) and, per OQ-16, anywhere in identifier generation. | `src/api.ts` (code gen, click id), `src/main.ts` (salt). | A stray `Math.random` is an automatic finding. Randomness failure must surface as `500`, not crash (NFR-12). Code-gen must be injectable for deterministic tests (OQ-27). |
| **Hashing / crypto** | `node:crypto` `createHmac('sha256', salt)` (OQ-24). | IP-hash helper. | Must not be swapped for a fast unsalted hash; must not log salt or input. |
| **Error handling** | Single Express error middleware; uniform `{ error, message }` body (OQ-23); no stack traces / IPs / paths (FR-21, NFR-5). Malformed-JSON path must route through it (spec §6). | `src/api.ts`. | Default Express error output leaks stack traces in non-production — must be overridden. Async handler rejections must reach the middleware (`next(err)` or an async wrapper). |
| **Logging** | `console.error` with stable greppable prefixes (OQ-9): collision-exhaustion alert (FR-8), analytics-write failure (FR-16). No logger dependency. Logs may contain codes, referrers, truncated UAs, hashes — **never raw IPs or the salt** (NFR-4). | `src/api.ts`, possibly `src/main.ts` (startup line). | Any log statement in the click path or error path that interpolates `req.ip` / `remoteAddress` violates NFR-4 and AC-17. |
| **Auth / authz** | **None** — explicitly out of scope (spec §1.1). No API keys, no accounts. | — | Risk is *scope creep*: recent commits (`d7e8a94`, `ef95deb`, `69e27fc` "Removed out of scope features") show scope was deliberately trimmed. Do not add auth, rate limiting, update/delete endpoints, listing, or a UI. |
| **Rate limiting / abuse** | Out of scope beyond the collision-retry bound (spec §1.1). | — | Same scope-creep caution. |
| **HTTP framework coupling** | `src/storage.ts` MUST have zero Express / `req` / `res` references (FR-2, AC-14). `src/api.ts` depends only on the `LinkStore` interface, never the concrete class (FR-1, NFR-15). | Enforced by inspection and AC-14/AC-15. | Easy to violate by importing `InMemoryLinkStore` into `api.ts` for a type — must import the interface. |
| **Toolchain (ESM vs `ts-node`)** | Repo: `"type": "module"`, `tsx`, `moduleResolution: bundler`, `allowImportingTsExtensions` (`package.json:6,15`, `tsconfig.json:4-8`). Spec: `ts-node` + `ts-node/register` for Mocha. | `package.json` scripts, `.mocharc`, import specifiers across `src/` and `tests/`, possibly a second `tsconfig`. | **Highest cross-cutting risk** — see §7.1. Governs whether `verify` can even run the suite. |
| **Dependency supply** | `verify` runs `npm install` (allowed; `npm publish` is blocked by `.claude/hooks/hook.ts:43`). Express pinned to 4.x. TS `^7`, `@types/node ^26` are pre-release-ish; `@types/express@4` type-checking under `tsc@7` is unverified. | `package.json`, `verify` stage. | Type errors from `@types/express` under a very new `tsc` could fail AC-1 independent of app logic. |
| **Pipeline coupling** | `contract.md` is the sole shared artifact between `implement` and `write_tests`, which run **without seeing each other** (`orchestrator/stages.ts:71-104`). Exit gates only check file non-emptiness (`orchestrator/runner.ts:64-75`). | Whole pipeline. | Any symbol/field/route the two stages interpret differently surfaces only at `verify`. The seams (injectable store, `generateCode`, `now`) must be in `contract.md` or FR-23/FR-24 tests cannot be written. |

---

## 6. Testing impact

### 6.1 Existing tests affected

**None.** `tests/` contains only `tests/.gitkeep`. There is no suite to update or
break. `orchestrator/` has no test suite in-repo.

### 6.2 New coverage required

`tests/shortener.test.ts`, Mocha + Chai, run via `ts-node/register`, against
`.ts` source directly (spec FR-22). Written by the `test-engineer` agent from
`contract.md` alone, concurrently with implementation (`orchestrator/stages.ts:92-104`).

| Area (spec FR-23 / AC) | What the test must exercise | Seam / dependency needed |
| --- | --- | --- |
| **Code generation** (FR-23.1, AC-2) | Produced code is exactly 7 chars, all within base62 `0-9A-Za-z`; randomness comes from `crypto.randomBytes` (inject a fake byte source or spy); output is not sequential/monotonic. | Injectable `generateCode` or injectable byte source via `createApp` opts (OQ-27). Without it, this is untestable deterministically (spec FR-24). |
| **Collision retry** (FR-23.2, AC-13) | First N candidates collide: N<5 ⇒ eventually returns a fresh code; N=5 ⇒ `500` path + `error`-level alert logged + **store has no partial link**. | `generateCode` stub that yields colliding values; a `LinkStore` (or stub) pre-seeded with those codes; a spy on `console.error`. |
| **Expiry logic** (FR-23.3, AC-11) | `expiresAt` in the past ⇒ redirect yields `410`; future ⇒ `302`; `null` ⇒ never `410`. | Injectable `now` (OQ-27) or constructing links with explicit dates via a fresh store. |
| **Idempotency** (FR-23.4, AC-3/AC-4) | Same `url` twice, no `force_new` ⇒ one link, second call returns the first (`200`, same `short_code`); `force_new:true` ⇒ a second distinct link; the `targetUrl→code` index is used (no scan). | Fresh `InMemoryLinkStore` per test; a spy/inspection proving `findByTarget` (not iteration) served the lookup. |
| **SSRF rejection** (AC-8, spec §12.20) | `http://127.0.0.1:8080/x`, `http://localhost/x`, `http://[::1]/`, `http://169.254.169.254/`, `http://10.0.0.5/` ⇒ all `400`, nothing created. | Called out explicitly in the `write_tests` prompt (`orchestrator/stages.ts:99-100`). Needs the SSRF check to not require real outbound DNS for literal IPs; DNS-name cases may need a stubbed resolver — **design must expose this seam or restrict the test to IP literals**. |
| **Analytics failure isolation** (AC-12, spec §12.16) | `recordClick` forced to reject ⇒ `GET /:code` still `302`; no unhandled rejection; process stays up; later redirects unaffected. | `LinkStore` stub whose `recordClick` rejects; assertion that the response resolved before/independent of the rejection; `process` listener check. |
| **Alias validation** (AC-5/AC-6, spec §12.6–12.8) | `admin` ⇒ `400`; `ab` ⇒ `400`; `my-link_1` (free) ⇒ `201` + `is_custom:true` on metadata; alias used for a different URL ⇒ `409`; 3 and 32 chars ok, 2 and 33 ⇒ `400`; `.`/space/`/`/unicode ⇒ `400`; `API`/`Docs` ⇒ `400` (case-insensitive). | `createApp` + fresh store. |
| **Expiry validation** (AC-7, spec §12.9/12.10) | Past / `now` `expires_at` ⇒ `400`; malformed ⇒ `400`; omitted ⇒ `expiresAt:null` and `expires_at:null` in responses. | Injectable `now` helps determinism. |
| **Stats aggregation** (AC-10, spec §12.18/12.21) | After a redirect, `total_clicks` +1 and click reflected in `clicks_by_day`, `top_referrers` (by `Referer` or `null`), `user_agents`; zero-click link ⇒ zeros + empty arrays; clicks across UTC midnight split across two day buckets. | Ability to inject clicks (fresh store) and control `clickedAt` timestamps. |
| **Privacy** (AC-17) | Raw IP appears in no stored record, no response body, no captured log; `createdByIpHash`/`ipHash` are non-empty. | Spy on `console.*`; inspect stored `Link`/`Click`. |
| **Structural** (AC-14/AC-15) | `src/storage.ts` has no `express` import / no `req`/`res`; `findByCode` is one `Map.get`; `findByTarget` uses the index; `getClicks` returns a per-code array. | Source inspection and/or targeted unit tests on `InMemoryLinkStore`. |
| **Compile / start** (AC-1, AC-16) | `tsc --noEmit` clean with `strict:true`; server starts and listens; Mocha suite passes under `ts-node/register`. | `verify` stage responsibility. |

### 6.3 Test-infrastructure changes

- New `.mocharc.*` with the `ts-node` loader/register and the spec glob.
- New dev deps: `mocha`, `chai`, `ts-node`, `@types/mocha`, `@types/chai`
  (optionally `supertest` + `@types/supertest` if in-process HTTP assertions are
  chosen — OQ-26).
- New `test` script in `package.json`.
- Possible CommonJS `tsconfig` for `src/`+`tests/` if ESM + `ts-node/register`
  fails at `verify` (OQ-1).

---

## 7. Risk assessment (ranked)

### 7.1 Toolchain: `ts-node` + native ESM + bundler `tsconfig` (OQ-1) — **Critical**

`package.json:6` sets `"type": "module"`; `package.json:15` shows the repo drives
tooling with `tsx`, not `ts-node`; `tsconfig.json:4-8` uses `module: ESNext`,
`moduleResolution: bundler`, `allowImportingTsExtensions: true`. The spec mandates
`ts-node` and `ts-node/register` for Mocha. `ts-node` under native ESM needs
`--loader ts-node/esm`, does not love `moduleResolution: bundler`, and disagrees
with `tsx` about `.ts` import specifiers. **If this is not resolved cleanly by the
design stage, `verify` cannot run the suite (AC-16 fails) regardless of code
correctness.** Compounding: `typescript@^7` and `@types/node@^26` are unusually
new; `@types/express@4` may not type-check under `tsc@7`, threatening AC-1
independent of logic. Mitigation: design stage picks one toolchain explicitly and
pins import-specifier style; allow the OQ-1 fallback (scoped CJS `tsconfig` or
`tsx` as the Mocha loader) and record the deviation.

### 7.2 Idempotency semantics vs the single-key index (OQ-11) — **High**

Idempotency is keyed on `(url, custom_alias)` (FR-9) but the mandated secondary
index is `Map<targetUrl, code>` — one code per URL (FR-20.2). The three
unresolved interactions (same URL then same URL + free alias; same URL with alias
A then alias B; `findByTarget` after `force_new`) each have two defensible
answers. This drives `createLink`/`findByTarget` semantics, index maintenance,
and four spec edge cases (§12.1–12.4) plus the idempotency tests (FR-23.4).
`implement` and `write_tests` must not diverge here — it has to be nailed in
`contract.md`. Mitigation: adopt OQ-11's "last-write-wins, newest link
idempotency-matched" default explicitly, or override, but state it in the
contract with the edge-case table.

### 7.3 SSRF blocklist undefined (FR-4.3, OQ-3) — **High**

The only normative statement is a one-line prompt in `orchestrator/stages.ts:87-88`
plus spec FR-4.3 prose. No ranges are enumerated in-repo. Open sub-questions:
resolve DNS names or only block IP literals; how to handle multi-record DNS;
TOCTOU. Under-blocking is a real security hole (AC-8, §12.20 explicitly test
`127.0.0.1`, `localhost`, `[::1]`, `169.254.169.254`, `10.0.0.5`). Over-blocking
or requiring real DNS in tests makes the suite flaky/non-hermetic. Mitigation:
design fixes the exact range list (OQ-3 default is a good start), decides
DNS-name handling, and exposes a resolver seam so tests don't hit the network.

### 7.4 Deferred analytics write / unhandled rejection (FR-16, NFR-10/11) — **High**

The click write must run after the response, via `setImmediate`, inside its own
`try/catch` or `.catch`. A missing `.catch` on the `recordClick()` promise is an
unhandled rejection, which under recent Node defaults can terminate the process —
directly contradicting AC-12 / §12.16. Also the failure log must not include the
raw IP (NFR-4). Mitigation: single well-tested deferred helper with a guaranteed
catch; a test that forces `recordClick` to reject and asserts process survival.

### 7.5 Code generation: bias-free sampling + collision `500` with no partial write (FR-7/FR-8) — **Medium-High**

Rejection sampling over `crypto.randomBytes` must be correct (no modulo bias,
OQ-8) and must never fall back to `Math.random`. The 5-collision path must emit an
`error` log and leave the store with **no partial link** (§12.17, AC-13). Needs an
injection seam (OQ-27) or the two required tests (FR-23.1/2) cannot be written
deterministically by a stage that can't see `src/`.

### 7.6 Route ordering `/api/*` before `/:code` (spec §12.23) — **Medium**

If the `GET /:code` catch-all is registered before `/api/links` / `/api/links/:code`,
those API calls are captured as redirect lookups with `code = "links"`/`"api"` and
return `404`/`410` JSON instead of doing their job. Cheap to get right, easy to
regress. Covered indirectly by AC-2/AC-3/AC-10 if the tests exercise real routes.

### 7.7 Privacy: raw IP leakage (NFR-1, NFR-4, AC-17) — **Medium**

Raw client IP must appear in no stored record, no response body, and no log line
(including error/debug logs on the click path and in the error middleware). One
careless `console.error(\`click failed for \${req.socket.remoteAddress}\`)` fails
AC-17. Mitigation: hash at the earliest point; never pass the raw IP further; spy
on `console.*` in tests.

### 7.8 `contract.md` is the only cross-stage channel — **Medium**

`implement` and `write_tests` run concurrently and never see each other
(`orchestrator/stages.ts:71-104`); exit gates only check non-emptiness
(`orchestrator/runner.ts:64-75`). Every exported symbol name, every JSON field
name (FR-11/FR-17 leave them "final in contract.md"), every status code, and
every test seam (FR-24) must be in `contract.md` exactly. Anything missing or
ambiguous shows up only at `verify` as a red suite the implementer then has to
reconcile without editing tests.

### 7.9 Error-response hygiene / Express defaults (FR-21, NFR-5) — **Medium**

Default Express error handling emits HTML and stack traces; malformed-JSON errors
from `express.json()` must be caught and reshaped to `{ error, message }`
(spec §6 row 1). A single middleware must own this and must not leak stack
traces, IPs, or filesystem paths.

### 7.10 In-memory unbounded growth (NFR-13, OQ-15) — **Low (accepted)**

`Click[]` per code and the link maps grow for the process lifetime; no purge of
expired links (OQ-15). Accepted for this stage; note it so it is a conscious
deferral, not a bug.

### 7.11 Uncommitted `orchestrator/runner.ts` — **Low (out of scope, but confirm)**

`git status` shows `M orchestrator/runner.ts`. The diff could not be inspected
here (no shell). The analyst/implementer scope excludes the orchestrator, so the
shortener change must not touch it. Indirect risk only: `runner.ts` owns stage
sequencing, the entry/exit gates (`runner.ts:53-75`), and the greenfield-skip
logic (`runner.ts:192-206`) that governs whether `impact_analysis` runs and
whether `implement`/`verify` are judged complete. Recommendation: operator
reviews and commits or reverts this file before running the pipeline so stage
behaviour is deterministic.

### 7.12 `GET /`, favicon, trailing slash undefined (OQ-28) — **Low**

Unhandled, these hit the `/:code` handler or Express defaults and produce
confusing/HTML `404`s. Design's call; low blast radius.

---

## 8. Blast-radius summary table

| Item | Type | Dependents (in this build) | Worst-case breakage | Risk |
| --- | --- | --- | --- | --- |
| `src/storage.ts` | new module | `src/api.ts`, `src/main.ts`, `tests/shortener.test.ts` | Interface drift breaks all handlers + all tests | Medium |
| `src/api.ts` | new module | `src/main.ts`, `tests/shortener.test.ts`, all 3 endpoints | Most logic; wrong idempotency / SSRF / deferred-write | High |
| `src/main.ts` | new module | `verify`, `document` stages | Won't start ⇒ AC-1 fails ⇒ pipeline halts | Medium |
| `tests/shortener.test.ts` | new module | `verify` stage | Un-runnable suite ⇒ AC-16 fails | Medium |
| `package.json` / lockfile | modify | every later stage, orchestrator's own `tsx` scripts | Dep/type conflict ⇒ AC-1/AC-16 fail | Medium |
| `.mocharc.*` / test tsconfig | new | `verify` | Wrong loader ⇒ suite won't run | High |
| `POST /api/links` | new endpoint | codes consumed by the other two endpoints | Duplicate/incorrect links; `500` on collision path | High |
| `GET /:code` | new endpoint | end users; feeds all stats | Process crash on analytics failure; misrouted `/api/*` | High |
| `GET /api/links/:code` | new endpoint | operators | Wrong/non-deterministic aggregation | Medium |
| Link-creation data flow | new | idempotency index, all reads | Index/primary-map divergence | High |
| Redirect + click data flow | new | stats flow, process stability | Unhandled rejection; IP leak | High |
| Stats aggregation data flow | new | operator inspection | Non-deterministic ordering / date bucketing | Medium |
| Config/startup data flow | new | every request (`BASE_URL`, salt) | Wrong `short_url`; salt logged | Medium |
| IP-hash sub-flow | new | create + click flows | Raw IP leak (AC-17) | Medium |
| Env contract (`PORT`/`BASE_URL`/`IP_HASH_SALT`) | new | `src/main.ts` | Non-functional `short_url`; non-comparable hashes | Low–Medium |
| `orchestrator/runner.ts` (uncommitted) | pre-existing, out of scope | whole pipeline sequencing | Non-deterministic stage gating | Low |
