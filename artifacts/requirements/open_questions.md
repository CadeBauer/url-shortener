# URL Shortener — Open Questions

Genuine ambiguities or missing decisions from `inbox/request.md` and the repo
that could block or misdirect implementation. Each has a proposed default so the
design/implementation can proceed; a human or the design stage should confirm or
override. IDs are referenced from `spec.md`.

---

## OQ-1 — `ts-node` (request) vs `tsx` + ESM (repo)

**Question.** The request says run with `ts-node` and load tests via
`ts-node/register`. The repo's `package.json` sets `"type": "module"` and drives
its own tooling with `tsx`; `tsconfig.json` uses `module: ESNext`,
`moduleResolution: bundler`, `allowImportingTsExtensions: true`. `ts-node` +
Mocha under native ESM is awkward (loader flags, `.ts` extension imports). Which
toolchain governs the application and the test run?

**Why it matters.** Determines `package.json` scripts, the Mocha config
(`.mocharc`), how modules import each other (`./x.ts` vs `./x.js` vs `./x`), and
whether `ts-node` needs `--esm`/loader wiring. Getting this wrong makes the suite
unrunnable in `verify`.

**Proposed default.** Follow the request literally: add `ts-node` and run Mocha
with `--require ts-node/register` (or `--loader ts-node/esm` if ESM is kept).
Keep `"type": "module"` and author imports with explicit `.ts` specifiers
(consistent with `allowImportingTsExtensions`). If ESM + `ts-node/register`
proves incompatible in `verify`, the implementer may set a CommonJS
`tsconfig` for `src`/`tests` only, or substitute `tsx` as the Mocha loader, and
record the deviation. Do not change `orchestrator/` tooling.

---

## OQ-2 — Allowed URL schemes

**Question.** The request says `targetUrl` is "stored as submitted" but never
defines what a valid `url` is. Only `http`/`https`? Also `ftp:`, `mailto:`,
custom app schemes?

**Why it matters.** Redirecting to non-`http(s)` schemes is a security and
correctness concern; validation strictness changes which requests get `400`.

**Proposed default.** Accept only absolute `http://` and `https://` URLs. Reject
everything else with `400`.

---

## OQ-3 — Exact private/loopback ranges for SSRF rejection

**Question.** `orchestrator/stages.ts` requires rejecting targets that "resolve
to a private or loopback address" but does not enumerate ranges, nor say whether
to resolve DNS names or only block IP literals, nor how to handle multi-record
DNS or later re-resolution (TOCTOU).

**Why it matters.** Determines the blocklist implementation and how much of a
real SSRF guard this is. DNS resolution adds async work and failure modes on the
create path.

**Proposed default.** Block, for IP literals and for every address a DNS lookup
returns: `127.0.0.0/8`, `::1`, `0.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`,
`192.168.0.0/16`, `169.254.0.0/16`, `fe80::/10`, `fc00::/7`, and `::ffff:` IPv4
mappings of the above. Also block the literal host `localhost`. Resolve the
hostname once at creation; if resolution fails, `400`. Accept TOCTOU risk as
out of scope (no fetch is performed by the service).

---

## OQ-4 — Maximum `url` length

**Question.** No length bound is specified for `url`.

**Why it matters.** Unbounded input is a minor DoS/memory concern and affects
test cases.

**Proposed default.** 2048 characters; longer ⇒ `400`.

---

## OQ-5 — Reserved-word matching: case sensitivity and scope

**Question.** Reserved list is `api, admin, static, docs`. Is matching
case-insensitive (`API`, `Admin`)? Does it apply only to exact matches or also to
prefixes/paths like `api-keys`?

**Why it matters.** Changes which aliases are rejected; also interacts with route
ordering (`/api/*` vs `/:code`).

**Proposed default.** Case-insensitive exact match against the four words only.
`api-keys` is allowed as an alias (it cannot shadow `/api/links` because the
`/api/*` routes are registered before the `/:code` catch-all).

---

## OQ-6 — Status code when a custom alias is already taken

**Question.** The request does not give a status for "custom alias already in use
by a different URL".

**Why it matters.** Client behaviour and tests depend on it; `409` vs `400` vs
`422`.

**Proposed default.** `409 Conflict`.

---

## OQ-7 — `expires_at` in the past

**Question.** Is a past/`now` `expires_at` a `400`, or accepted (creating an
already-expired link that immediately returns `410`)?

**Why it matters.** Two coherent designs; affects validation and tests.

**Proposed default.** Reject with `400` (`expires_at` must be strictly in the
future). Rationale: creating a dead link is almost always a client mistake.

---

## OQ-8 — Base62 alphabet and bias-free sampling

**Question.** The request says "7-character base62" but not the alphabet ordering
(`0-9A-Za-z` vs `A-Za-z0-9`) or that sampling must avoid modulo bias.

**Why it matters.** Alphabet choice is cosmetic but must be fixed for tests;
modulo bias slightly weakens uniformity / enumeration resistance.

**Proposed default.** Alphabet `0-9A-Za-z` (indices 0–61). Use rejection sampling
over `crypto.randomBytes` so each character is uniform. ~62^7 ≈ 3.5x10^12
keyspace.

---

## OQ-9 — "Logged alert" channel and format

**Question.** FR-8 requires "a logged alert" on collision-retry exhaustion; the
request does not say via what (stdout `console.error`, a logger library, a
metrics hook) or in what format.

**Why it matters.** Tests need something observable; ops would want structure.

**Proposed default.** `console.error` with a stable, greppable prefix, e.g.
`ALERT code_generation_collision_exhausted attempts=5`. No logger dependency
added. Same channel used for analytics-write failures (FR-16).

---

## OQ-10 — Status code for an idempotent hit

**Question.** The request says "201 on create" and that a duplicate "returns the
existing code" but not the status for that duplicate response.

**Why it matters.** `200` vs `201` is a visible contract detail and a test
assertion.

**Proposed default.** `200 OK` for an idempotent hit, `201 Created` for a new
link. Same body shape either way.

---

## OQ-11 — Idempotency key `(url, custom_alias)` vs single-key index `Map<targetUrl, code>`

**Question.** The idempotency rule is keyed on `(url, custom_alias)`, but the
mandated secondary index is `Map<targetUrl, code>` — keyed on URL alone, one code
per URL. Unresolved combinations:

1. Same `url`, no alias, then same `url` with a (free) `custom_alias` — new link
   or idempotent hit?
2. Same `url` with alias A, then same `url` with alias B — two links? The index
   can only remember one.
3. After `force_new` creates a second link for a URL, which `code` does
   `findByTarget` (and thus the next idempotency check) return?

**Why it matters.** Directly drives `createLink`/`findByTarget` semantics, the
index-maintenance rule, and several tests. It is the sharpest under-specification
in the request.

**Proposed default.**
- The idempotency check calls `findByTarget(url)`. If it returns a link AND
  (`custom_alias` is absent OR equals that link's `code`) AND `force_new` is
  falsy ⇒ idempotent hit. Otherwise create a new link.
- The index stores the **most recently created** link for a given `targetUrl`
  (last write wins). Older links for the same URL remain resolvable by their
  `code` via the primary map but are no longer returned by `findByTarget`.
- Consequence: `force_new` and "same URL, different alias" both create a new link
  and repoint the index at it. This keeps the index O(1) and single-valued as the
  request requires, at the cost of only the newest link being idempotency-matched.

---

## OQ-12 — Listen port and public base URL for `short_url`

**Question.** The request shows `short_url` in the response but never says how the
host/base is determined, nor what port the server listens on.

**Why it matters.** `short_url` is in the contract and asserted by tests; a wrong
base makes returned links non-functional.

**Proposed default.** `PORT` env, default `3000`. `BASE_URL` env, default
`http://localhost:${PORT}` (no trailing slash). `short_url = ${BASE_URL}/${code}`.
Do not derive the base from the request `Host` header (non-deterministic in
tests).

---

## OQ-13 — Redirect status and caching headers

**Question.** The request mandates `302`. Should the redirect also set
`Cache-Control: no-store` (so every hit reaches the service and is counted), or
is a bare `302` fine?

**Why it matters.** Without `no-store`, intermediaries may cache the `302` and
undercount clicks — affecting analytics accuracy expectations.

**Proposed default.** Send `302` with `Cache-Control: no-store` to keep click
counts accurate. Keep `302` (not `301`/`307`/`308`) as the request states.

---

## OQ-14 — Does an expired link record a click?

**Question.** FR-14 returns `410` for an expired link; unclear whether that
event is still recorded as a click.

**Why it matters.** Affects stats semantics and a test assertion.

**Proposed default.** No. A click is recorded only on a successful `302`
redirect. `410` and `404` record nothing.

---

## OQ-15 — Lifecycle of expired links (retain vs purge)

**Question.** Are expired links kept in the store indefinitely (still visible via
`GET /api/links/:code`), or garbage-collected?

**Why it matters.** Memory growth over time; whether the stats endpoint keeps
working for expired links.

**Proposed default.** Retain indefinitely (no purge job). Consistent with
in-memory, single-stage scope and with OQ-21.

---

## OQ-16 — `Click.id` / entropy source for identifiers

**Question.** `Click.id` is `string` with no format given. `Link` has no
non-code id. Also: does the "no `Math.random`" rule extend to id generation?

**Why it matters.** Minor, but must be fixed for deterministic-ish tests and to
stay consistent with the randomness rule.

**Proposed default.** `crypto.randomUUID()` for `Click.id`. The "no `Math.random`"
rule is treated as applying to all identifier/entropy generation in the service.

---

## OQ-17 — User-agent truncation length

**Question.** `Click.userAgent` is "truncated" — to how many characters?

**Why it matters.** Testable constant; affects grouping in `user_agents`.

**Proposed default.** 256 characters (truncate, no ellipsis).

---

## OQ-18 — `clicks_by_day`: sparse vs zero-filled, and range

**Question.** Should the daily time series include days with zero clicks
(zero-filled from `createdAt` to today), or only days that have clicks? What
timezone defines a "day"? Any range cap?

**Why it matters.** Response size and shape; a concrete test assertion.

**Proposed default.** Sparse (only days with ≥ 1 click), ascending, keyed by UTC
calendar date `YYYY-MM-DD`. No range cap (bounded in practice by distinct click
days for one link).

---

## OQ-19 — "Top" referrers / user-agents: limit and tie-breaking

**Question.** "Top referrers" and "user-agent breakdown" — how many entries? Full
breakdown or top-N? How are ties ordered?

**Why it matters.** Response shape and deterministic tests.

**Proposed default.** Top 10 each, sorted by count descending, ties broken by the
key string ascending (`null` sorts last). If a full breakdown is wanted instead,
drop the limit — cheap to change.

---

## OQ-20 — User-agent breakdown: raw string vs parsed

**Question.** "User-agent breakdown" — group by the raw UA string, or parse into
browser/OS/device families?

**Why it matters.** Parsing needs a dependency (`ua-parser-js`) and a data
schema; the `Click` model only stores the raw truncated string, which suggests
no parsing.

**Proposed default.** Group by the raw (truncated) UA string. No parsing library.

---

## OQ-21 — `GET /api/links/:code` for an expired link

**Question.** Does the metadata/stats endpoint also return `410` for expired
links (consistency with the redirect path), or `200` with metadata (treating it
as an inspection surface)?

**Why it matters.** Contract + test; also whether operators can inspect a link
after it expires.

**Proposed default.** `200` with full metadata and stats; `expires_at` in the
body signals the expired state. Rationale: this endpoint is for inspection, and
`410` would hide the data an operator needs.

---

## OQ-22 — Mutation safety of store return values

**Question.** Should `LinkStore` return defensive copies of `Link`/`Click`, or
are callers trusted not to mutate them?

**Why it matters.** A handler mutating a returned `Link` would silently corrupt
the in-memory store and mask bugs a real DB wouldn't have.

**Proposed default.** Return the stored objects directly but treat `Link`/`Click`
as immutable by convention in handlers (never mutate a value from the store).
Revisit if a real store is added.

---

## OQ-23 — Error response body shape

**Question.** No error body schema is given anywhere.

**Why it matters.** Every negative test asserts on it; downstream `contract.md`
must pin it.

**Proposed default.** `{ "error": "<machine_code>", "message": "<human text>" }`
with `error` a stable snake_case code (e.g. `invalid_url`, `alias_reserved`,
`alias_taken`, `expires_in_past`, `not_found`, `gone`, `code_generation_failed`).

---

## OQ-24 — IP hash algorithm

**Question.** "Salted hash" — which algorithm? Plain SHA-256, HMAC-SHA-256, or a
slow KDF?

**Why it matters.** IPs have a tiny input space; a fast unsalted hash is
reversible by brute force. A per-process salt plus SHA-256 is adequate here; a
KDF is overkill for volatile in-memory data.

**Proposed default.** `HMAC-SHA-256(key = IP_HASH_SALT, message = ip)`, hex
digest. No KDF.

---

## OQ-25 — Salt source and stability

**Question.** Where does `IP_HASH_SALT` come from, and does it need to be stable
across restarts?

**Why it matters.** A per-process random salt means hashes are not comparable
across restarts — fine given the store is also wiped on restart, but it must be a
deliberate choice. Also: how is the client IP obtained (`req.ip`, `req.socket
.remoteAddress`, `X-Forwarded-For`)? Trusting `X-Forwarded-For` without a
configured proxy is a spoofing vector.

**Why it matters (2).** Affects `app.set('trust proxy', ...)` and which value
gets hashed.

**Proposed default.** Read `IP_HASH_SALT` from env; if absent, generate 32 random
bytes at startup (accepting non-stable hashes across restarts). Do NOT enable
`trust proxy`; hash `req.socket.remoteAddress`. If a future deployment sits
behind a proxy, revisit.

---

## OQ-26 — Test style: pure unit vs in-process HTTP

**Question.** The request says "unit tests only". May the suite still exercise the
Express app in-process (e.g. `supertest`) to test routing/status codes, or must
tests call handler/store functions directly with no HTTP layer?

**Why it matters.** Determines whether `supertest` is a dependency and how much of
the routing/error contract is actually covered.

**Proposed default.** Allow in-process assertions against the app object built by
`createApp(store)` (no network socket) — still "unit" in the sense of no external
services. The four required areas (FR-23) must be covered regardless.

---

## OQ-27 — Seam for injecting randomness / the code generator

**Question.** FR-23 requires testing code generation and collision retry
deterministically, which needs an injection point. The request doesn't specify
one. Options: (a) `createApp` takes an optional `generateCode` function;
(b) a module-level exported function that tests stub; (c) inject a byte source.

**Why it matters.** `contract.md` must declare the exact exported symbol/param so
the concurrently-written tests can rely on it.

**Proposed default.** `createApp(store: LinkStore, opts?: { generateCode?: () =>
string; now?: () => Date })`. Tests pass a `generateCode` that yields colliding
values, and a `now` for expiry tests. The real default uses `crypto.randomBytes`.
Final signature is the design stage's to set.

---

## OQ-28 — Trailing-slash / favicon / root path behaviour

**Question.** What does `GET /` return? `GET /favicon.ico`? A trailing slash on a
code (`GET /abc123x/`)?

**Why it matters.** Minor, but `GET /` hitting the `/:code` handler would produce
a confusing `404` JSON body, and browsers auto-request `/favicon.ico` which would
create noise `404`s.

**Proposed default.** `GET /` ⇒ `404` JSON (or a tiny `200` health text — design's
call). No favicon route. Trailing slash on a code ⇒ `404` (Express default
non-strict routing treats `/abc/` and `/abc` the same; acceptable either way).
