# URL Shortener — Architecture

Status: design stage output
Inputs consulted: `artifacts/requirements/spec.md`, `artifacts/requirements/open_questions.md`,
`artifacts/impact/impact_analysis.md`, `inbox/request.md`, `orchestrator/stages.ts`,
`package.json`, `tsconfig.json`.
Companion document: `artifacts/design/contract.md` (the exact interface; this document
explains *why* that interface is shaped the way it is).

This document records every significant design choice with its rationale and its
consequences. Where the spec left a decision open (`OQ-n`), the choice is made here
and cross-referenced. Nothing outside the spec's scope is added.

---

## 1. Overview

A single Node process exposes three HTTP endpoints (create link, redirect, link
stats) over Express 4. All state lives in memory behind an async `LinkStore`
interface. There is no build step: TypeScript source is executed directly.

### 1.1 Component map

```
                         ┌─────────────────────────────┐
   HTTP client  ───────▶ │  src/api.ts                 │
                         │  createApp(store, options)  │
                         │  - express.json() parser    │
                         │  - POST /api/links          │
                         │  - GET  /api/links/:code    │
                         │  - GET  /:code  (+ click)   │
                         │  - 404 fallback             │
                         │  - error middleware         │
                         │  - short-code generator     │
                         │  - URL / alias / expiry     │
                         │    validation + SSRF guard  │
                         │  - IP hashing               │
                         │  - stats aggregation        │
                         └────────────┬────────────────┘
                                      │ depends on the LinkStore *interface* only
                                      ▼
                         ┌─────────────────────────────┐
                         │  src/storage.ts             │
                         │  Link, Click, LinkStore     │
                         │  InMemoryLinkStore          │
                         │  - Map<code, Link>          │
                         │  - Map<targetUrl, code>     │
                         │  - Map<code, Click[]>       │
                         │  NO express / req / res     │
                         └─────────────────────────────┘
                                      ▲
                                      │ constructs the concrete store,
                                      │ reads env, calls createApp, listens
                         ┌────────────┴────────────────┐
                         │  src/main.ts                │
                         │  composition root           │
                         └─────────────────────────────┘

  tests/shortener.test.ts imports from src/api.ts and src/storage.ts only,
  builds its own store + app per test, never opens a socket.
```

### 1.2 Source files (fixed by `orchestrator/stages.ts`; no others may be added)

| Path | Responsibility |
| --- | --- |
| `src/storage.ts` | Data types (`Link`, `Click`), the `LinkStore` interface, and `InMemoryLinkStore`. Zero HTTP concerns. |
| `src/api.ts` | Everything request-facing: `createApp` factory, routing, validation, SSRF guard, code generation, idempotency, redirect + deferred click, stats aggregation, IP hashing, single error middleware. Depends only on the `LinkStore` *interface*. |
| `src/main.ts` | Composition root: read env, build `InMemoryLinkStore`, build the app via `createApp`, `app.listen(PORT)`. Exports nothing; runs on import. |
| `tests/shortener.test.ts` | Mocha + Chai unit suite. Written by a separate stage from the contract alone. |

Supporting non-source files the implement/verify stages will add (called out so the
consequence is explicit, not a surprise): `package.json` dependency + script edits,
`package-lock.json`, `.mocharc.cjs`, and a test/runtime `tsconfig` (see §7).

---

## 2. Component breakdown

### 2.1 `src/storage.ts`

**Responsibility.** Own the data shapes and the in-memory persistence. Provide O(1)
lookups on the redirect and idempotency paths. Never reference Express, `req`,
`res`, HTTP status codes, or headers (spec FR-2, AC-14).

**Dependencies.** `node:*` only if needed (none currently required). No third-party
imports.

**Public surface.** `Link`, `Click`, `LinkStore` (all verbatim from spec §5), and
`class InMemoryLinkStore implements LinkStore`.

**Internal state (in `InMemoryLinkStore`).**

| Field | Type | Purpose |
| --- | --- | --- |
| `links` | `Map<string, Link>` | Primary store, keyed by `code`. `findByCode` = one `Map.get`. |
| `targetIndex` | `Map<string, code>` | Secondary index `targetUrl → code`. `findByTarget` reads this then one `links.get`. Never scans. |
| `clicks` | `Map<string, Click[]>` | Per-code click log. `getClicks` returns one bucket. |

**Key decisions.**

- **D-S1 — Two `Map.get`s in `findByTarget`, still O(1).** The index stores the
  `code`, not the `Link`, so a lookup is `targetIndex.get(url)` then
  `links.get(code)`. *Rationale:* keeps a single source of truth for `Link`
  objects (the primary map); the index never holds a stale copy of link fields.
  *Consequence:* two hash probes instead of one — constant, negligible, and NFR-7
  ("no scan") is satisfied.
- **D-S2 — Last-write-wins index (OQ-11).** Every `createLink` unconditionally does
  `targetIndex.set(link.targetUrl, link.code)`. If two links share a `targetUrl`
  (via `force_new`, or same URL with a different alias), the index points at the
  most recently created one. *Rationale:* the spec mandates a single-valued
  `Map<targetUrl, code>` (FR-20.2); it physically cannot remember more than one
  code per URL. Last-write-wins is the simplest consistent rule and matches OQ-11's
  proposed default. *Consequence:* older links for the same URL stay reachable by
  `code` (redirect, stats) but are no longer returned by `findByTarget`, so a
  later idempotent `POST` of that URL matches only the newest link. This is the
  documented behaviour for spec edge cases §12.2–§12.4.
- **D-S3 — `getClicks` returns a shallow copy (`array.slice()`).** *Rationale:* the
  stats handler sorts and groups the result; handing it the live array would let a
  handler bug reorder stored data. Copying one link's clicks costs O(clicks-for-
  that-code), which is exactly the budget NFR-8 allows. *Consequence:* a tiny
  allocation per stats read; store integrity is protected without a deep clone.
- **D-S4 — `createLink` / `findByCode` return the stored reference (no defensive
  copy) (OQ-22).** *Rationale:* `Link` is treated as immutable by convention in
  `src/api.ts`; deep-copying on every read is wasted work for this stage.
  *Consequence:* a handler that mutates a returned `Link` would corrupt the store.
  The contract states the convention so both implementation branches uphold it;
  revisit if a real store lands.
- **D-S5 — `recordClick` appends; buckets are created lazily.** `createLink` also
  seeds an empty `clicks` bucket for the new code so `getClicks` on a zero-click
  link returns `[]` without special-casing (spec §12.18).
- **D-S6 — All methods `async`, resolve synchronously.** No `setTimeout`, no
  artificial delay (FR-20.4). The `Promise` exists only so a future real store is a
  drop-in.

### 2.2 `src/api.ts`

**Responsibility.** Translate HTTP into `LinkStore` calls and back, enforcing every
functional and security requirement in spec §4, §6, §7.

**Dependencies.** `express` (4.x), `node:crypto`, `node:dns` (`dns/promises`),
`node:net`, and the `LinkStore` *interface* from `src/storage.ts`. It must **not**
import `InMemoryLinkStore` (NFR-15, FR-1).

**Public surface.** `createApp`, `CreateAppOptions`, `Logger`, `HttpError`,
`generateShortCode`, `hashIp`, the request/response body types, the shared
`ErrorResponse` / `ErrorCode` types, and a handful of constants. Full signatures
are in `contract.md` §4.

**Key decisions.**

- **D-A1 — A factory, not a module-level app (FR-1).** `createApp(store, options?)`
  builds and returns an Express app; it never calls `listen`. *Rationale:* the
  store must be injectable so unit tests supply a fresh `InMemoryLinkStore` or a
  stub; keeping `listen` out means tests never bind a port. *Consequence:*
  `src/main.ts` owns the listener; tests own their app instance.
- **D-A2 — Options bag carries every test seam and every environment-derived
  value (OQ-27, FR-24).** `CreateAppOptions` exposes `generateCode`, `now`,
  `resolveHostname`, `baseUrl`, `ipHashSalt`, and `logger`, each optional with a
  production default. *Rationale:* the two required deterministic tests (code
  generation, collision retry) need `generateCode`; expiry tests need `now`;
  hermetic SSRF tests need `resolveHostname`; deterministic `short_url` assertions
  need `baseUrl`; privacy assertions need a known `ipHashSalt`; alert assertions
  need an observable `logger`. *Consequence:* a slightly wide options type, but
  every FR-23 test is writable against the contract without seeing `src/`.
- **D-A3 — Route registration order is fixed and load-bearing (spec §12.23).**
  `express.json()` → `POST /api/links` → `GET /api/links/:code` →
  `GET /:code` → 404 fallback → error middleware. *Rationale:* `GET /:code` is a
  catch-all; if it precedes `/api/links`, an API call is misrouted to the redirect
  handler. *Consequence:* the contract pins this order; both branches must not
  reorder.
- **D-A4 — One error-translation point (FR-21).** Handlers throw `HttpError`
  (carrying `status` + machine `code`) or call `next(err)`. A single terminal
  middleware maps any error to the `ErrorResponse` JSON shape. It special-cases the
  body-parser `SyntaxError` (malformed JSON → 400 `malformed_json`) and treats
  everything unrecognised as 500 `internal_error` with a fixed generic message.
  *Rationale:* Express's default handler emits HTML and stack traces; a single
  choke point guarantees the no-leak rule (no stack traces, raw IPs, or filesystem
  paths — NFR-5). *Consequence:* every async handler must route rejections to
  `next` (wrap with `Promise.resolve(handler(...)).catch(next)` or an async
  wrapper). The contract requires this behaviour, not a specific helper name.
- **D-A5 — Validation has a fixed, documented order.** For `POST /api/links`:
  malformed JSON → body-is-object → `url` presence/type → `url` length → `url`
  parse + scheme → SSRF resolution → `custom_alias` charset → `custom_alias`
  reserved → `expires_at` parse → `expires_at` future → idempotency / alias
  conflict → code generation → create. *Rationale:* when an input fails several
  checks at once, the response code must be deterministic so the concurrently
  written tests agree. *Consequence:* the order is part of the contract (§6).
- **D-A6 — Short code generation is a pure exported function with unbiased
  sampling (FR-7, OQ-8).** `generateShortCode()` draws bytes from
  `crypto.randomBytes` and uses rejection sampling: a byte `b` is accepted only if
  `b < 248` (248 = 62 × 4, the largest multiple of 62 ≤ 256), contributing
  `b % 62`; bytes ≥ 248 are discarded and more bytes drawn. Seven accepted indices
  map through the alphabet `0-9A-Za-z`. *Rationale:* plain `b % 62` over-weights
  the first `256 mod 62 = 8` symbols; rejection sampling removes that bias,
  strengthening enumeration resistance (NFR-2). `Math.random` appears nowhere.
  *Consequence:* generation occasionally loops to draw an extra byte; expected
  overhead ≈ 3%. Exporting the function lets tests assert length, alphabet, and
  non-sequential output directly.
- **D-A7 — Collision retry loop with no partial write (FR-8, AC-13).** Generate a
  candidate, `await store.findByCode(candidate)`; on hit regenerate; at most 5
  attempts. On exhaustion: `logger.error("ALERT code_generation_collision_exhausted attempts=5")`,
  respond 500 `code_generation_failed`, return **before** any `createLink` call.
  *Rationale:* the spec requires an observable alert and a clean store.
  *Consequence:* with a real ~3.5 × 10¹² keyspace this path is practically
  unreachable in production; it exists for correctness and is reached in tests only
  by injecting a colliding `generateCode`.
- **D-A8 — Idempotency + alias-conflict resolution is a single decision tree
  (FR-5.3, FR-9, FR-10, OQ-11).** See §4.1 for the exact algorithm. Summary: an
  alias that already maps to *the same* `url` with `force_new` falsy is an
  idempotent hit (200); an alias mapping to a *different* `url`, or any alias hit
  with `force_new` true, is 409; with no alias, `findByTarget(url)` drives the
  idempotent hit. *Rationale:* reconciles the `(url, custom_alias)` key with the
  single-valued index. *Consequence:* fully specified so both branches and the
  edge-case tests (§12.1–§12.5) agree.
- **D-A9 — Redirect responds before the click is built (FR-16, NFR-9).** The
  handler sends `302` (+ `Cache-Control: no-store`), then `setImmediate` schedules
  an `async` click writer wrapped in `try/catch`; a rejected `recordClick` is
  caught, logged at `error` level (no IP in the message), and swallowed.
  *Rationale:* analytics must never add latency to or fail a redirect, and must
  never produce an unhandled rejection that can kill the process (NFR-10, NFR-11).
  *Consequence:* a lost click on failure is accepted (analytics is best-effort;
  retry beyond one deferred attempt is out of scope).
- **D-A10 — 302, with `Cache-Control: no-store` (OQ-13).** *Rationale:* the request
  mandates 302; `no-store` stops intermediaries caching the redirect and
  undercounting clicks. *Consequence:* every hit reaches the service.
- **D-A11 — IP hashing via HMAC-SHA-256 (OQ-24, NFR-1).**
  `hashIp(ip, salt) = createHmac("sha256", salt).update(ip).digest("hex")`. The
  raw IP (`req.socket.remoteAddress ?? ""`) is hashed at the earliest point and
  never stored, logged, or returned. *Rationale:* IPs have a tiny input space; an
  unsalted fast hash is brute-forceable, a KDF is overkill for volatile in-memory
  data. *Consequence:* hashes are comparable only within a process run (salt may
  be per-process — OQ-25); acceptable because the store is wiped on restart too.
- **D-A12 — `trust proxy` stays off; hash `req.socket.remoteAddress` (OQ-25).**
  *Rationale:* trusting `X-Forwarded-For` without a configured proxy is a spoofing
  vector. *Consequence:* behind a real proxy every client would hash to the proxy
  IP; documented as a known limitation, revisited if a deployment needs it.
- **D-A13 — Stats aggregation is deterministic (FR-18, OQ-18, OQ-19, OQ-20).**
  `clicks_by_day`: bucket by `clickedAt.toISOString().slice(0, 10)` (UTC date),
  sparse (only non-zero days), ascending by date string. `top_referrers` /
  `user_agents`: group by the raw value (`null` is its own bucket), sort by count
  descending, then by key ascending with `null` last, take the top 10. No UA
  parsing library. *Rationale:* every ordering must be reproducible for the tests;
  the `Click` model only stores a raw truncated UA string, which implies no
  parsing. *Consequence:* fixed, testable output; `top_*` are capped at 10 (cheap
  to lift later).
- **D-A14 — Expired link on the stats endpoint returns 200 (OQ-21).** *Rationale:*
  this endpoint is an inspection surface; 410 would hide the data an operator
  needs, and `expires_at` in the body already signals the state. *Consequence:*
  only `GET /:code` distinguishes expiry with 410.
- **D-A15 — `baseUrl` default in `api.ts` is `http://localhost:3000`, port-blind.**
  `api.ts` has no knowledge of `PORT`; `src/main.ts` computes and passes
  `http://localhost:${PORT}` (or the `BASE_URL` env value). A single trailing `/`
  on the supplied `baseUrl` is stripped. *Rationale:* keeps `short_url`
  deterministic and independent of the request `Host` header (OQ-12).
  *Consequence:* a misconfigured `BASE_URL` yields wrong `short_url` strings but
  links still resolve (resolution is by `code`).
- **D-A16 — Any unmatched route or method → 404 `not_found` JSON (OQ-28).** A final
  `app.use` handler covers `GET /`, `favicon.ico`, unknown methods on known paths,
  and unknown paths. *Rationale:* uniform JSON error surface, no stray Express
  HTML. *Consequence:* no health endpoint is added (not in scope); `GET /` is a
  404.

### 2.3 `src/main.ts`

**Responsibility.** The only place concrete wiring and process concerns live.

**Behaviour.**
1. `const port = Number(process.env.PORT) || 3000;`
2. `const baseUrl = process.env.BASE_URL ?? \`http://localhost:${port}\`;`
3. `const ipHashSalt = process.env.IP_HASH_SALT ?? crypto.randomBytes(32).toString("hex");`
   — if generated, log one line at startup stating a random salt is in use (never
   log the salt value — NFR-4).
4. `const store = new InMemoryLinkStore();`
5. `const app = createApp(store, { baseUrl, ipHashSalt });`
6. `app.listen(port, () => { /* startup log line, no secrets */ });`

**Key decisions.**

- **D-M1 — Env parsed here, values injected downward.** `api.ts` receives plain
  values, never reads `process.env`. *Rationale:* testability and a single config
  surface. *Consequence:* constants that are not environment-driven (code length,
  retry limit, UA cap, URL cap) live as `const`s in `api.ts`.
- **D-M2 — Exports nothing.** *Rationale:* it is a script; the spec requires it to
  compile and start, nothing more. *Consequence:* tests do not import `main.ts`;
  they compose their own app.

### 2.4 `tests/shortener.test.ts`

Written by the `test-engineer` stage from `contract.md` alone, concurrently with
`src/`. Uses Mocha + Chai; may drive the app in-process (supertest-style) or call
exported functions directly (OQ-26). Required coverage: code generation, collision
retry, expiry, idempotency (FR-23), plus at least one private-IP-target rejection
(stage prompt). Constraints it inherits from the contract: import only declared
symbols; never touch `src/`.

---

## 3. Data model and storage design

`Link` and `Click` are used verbatim from spec §5.1 / §5.2 — no added `id` on
`Link`, no renamed fields. `Click.id` is `crypto.randomUUID()` (OQ-16).

### 3.1 Index maintenance invariant

On every `createLink(link)` the implementation performs, in one synchronous block:

```
links.set(link.code, link);
targetIndex.set(link.targetUrl, link.code);   // last-write-wins (D-S2)
if (!clicks.has(link.code)) clicks.set(link.code, []);
```

The primary map and the index are only ever written together, so they cannot
disagree. `findByTarget` never falls back to scanning.

### 3.2 Idempotency key vs single-valued index (OQ-11, resolved)

| Scenario (spec §12) | Behaviour |
| --- | --- |
| Same `url` twice, no `force_new` (§12.1) | 2nd call: `findByTarget` hit, no alias → return existing link, 200. |
| Same `url` twice, `force_new: true` (§12.2) | 2nd call: new link + new code; index repointed to it. Subsequent `findByTarget(url)` returns the newest. |
| Same `url` + same `custom_alias` twice (§12.3) | 2nd call: `findByCode(alias)` hit, same `targetUrl`, `force_new` falsy → idempotent hit, 200 (not 409). |
| Same `url` + different (free) `custom_alias` (§12.4) | New link at the requested alias; index repointed to it. |
| Different `url` + already-used `custom_alias` (§12.5) | `findByCode(alias)` hit, different `targetUrl` → 409 `alias_taken`. |

### 3.3 Growth and lifecycle (OQ-15, NFR-13)

Everything is in memory; a restart discards all data. Expired links are retained
(no purge job) so the stats endpoint keeps working for them. `Click[]` per code
grows unbounded for the process lifetime — accepted for this stage, recorded as a
conscious deferral, not a bug.

---

## 4. Request flows

### 4.1 `POST /api/links` — create

1. **Body parse.** `express.json()`. A parse error surfaces as a `SyntaxError`
   caught by the error middleware → 400 `malformed_json`.
2. **Body shape.** Body must be a non-null object → else 400 `invalid_request`.
   `force_new`, if present, must be boolean → else 400 `invalid_request`.
3. **`url` presence/type.** Missing / not a string / empty → 400 `invalid_url`.
4. **`url` length.** `> 2048` chars → 400 `url_too_long` (OQ-4).
5. **`url` parse + scheme.** Must parse as an absolute WHATWG `URL` with protocol
   `http:` or `https:` → else 400 `invalid_url` (OQ-2).
6. **SSRF guard (async).** Extract `hostname`. If it is `localhost`
   (case-insensitive) → 400 `blocked_target`. If it is an IP literal
   (`net.isIP` ≠ 0) test it directly; otherwise `resolveHostname(hostname)` and
   test every returned address. Any address in a blocked range, or a resolution
   error / empty result → 400 `blocked_target` (OQ-3; ranges in §6.2). No request
   is ever made to the target.
7. **`custom_alias`** (if present): must be a string matching
   `^[A-Za-z0-9_-]{3,32}$` → else 400 `invalid_alias` (FR-5.1); must not be, case-
   insensitively, one of `api`, `admin`, `static`, `docs` → else 400
   `alias_reserved` (FR-5.2, OQ-5).
8. **`expires_at`** (if present and not `null`): must be a string with
   `!Number.isNaN(Date.parse(value))` → else 400 `invalid_expires_at` (FR-6);
   resulting `Date` must be strictly `> now()` → else 400 `expires_at_in_past`
   (OQ-7). Absent or `null` → `expiresAt = null`.
9. **Idempotency / alias-conflict decision tree:**

   ```
   if (custom_alias !== undefined) {
     const clash = await store.findByCode(custom_alias);
     if (clash) {
       if (!force_new && clash.targetUrl === url) return 200 body(clash);   // FR-5.3 bullet 1
       return 409 alias_taken;                                              // FR-5.3 bullet 2 / FR-10
     }
     code = custom_alias; isCustom = true;                                  // alias is free
   } else {
     if (!force_new) {
       const existing = await store.findByTarget(url);
       if (existing) return 200 body(existing);                             // FR-9
     }
     code = <generate with collision retry, D-A6/D-A7>; isCustom = false;
   }
   ```
10. **IP hash.** `createdByIpHash = hashIp(req.socket.remoteAddress ?? "", ipHashSalt)`.
11. **Create.** `await store.createLink({ code, targetUrl: url, createdAt: now(),
    expiresAt, isCustom, createdByIpHash })` → respond **201** with the create body.

Idempotent hits respond **200** with the identical body shape and the original
link's `createdAt` (OQ-10).

Create/idempotent body:

```ts
{
  short_code: string,                 // the code (generated or alias)
  short_url: string,                  // `${baseUrl}/${short_code}`
  created_at: string,                 // link.createdAt.toISOString()
  expires_at: string | null           // link.expiresAt?.toISOString() ?? null
}
```

### 4.2 `GET /:code` — redirect + deferred click

1. `link = await store.findByCode(code)` (single `Map.get`).
2. `link == null` → 404 `not_found`. **No click.**
3. `link.expiresAt !== null && link.expiresAt.getTime() <= now().getTime()` → 410
   `gone`. **No click** (OQ-14).
4. Otherwise: `res.set("Cache-Control", "no-store"); res.redirect(302, link.targetUrl)`.
5. `setImmediate(() => { void recordClickSafe(); })` where `recordClickSafe` is
   `async` and does:
   ```
   try {
     await store.recordClick({
       id: crypto.randomUUID(),
       code: link.code,
       clickedAt: now(),
       referrer: req.get("referer") ?? null,
       userAgent: (req.get("user-agent") ?? "").slice(0, 256) || null,
       ipHash: hashIp(req.socket.remoteAddress ?? "", ipHashSalt),
     });
   } catch (err) {
     logger.error("ALERT analytics_write_failed code=" + link.code);
   }
   ```
   No rethrow, no floating promise, no `unhandledRejection` (NFR-10, NFR-11).

### 4.3 `GET /api/links/:code` — metadata + stats

1. `link = await store.findByCode(code)`; `null` → 404 `not_found`.
2. `clicks = await store.getClicks(code)` (per-code array only; NFR-8).
3. Aggregate (D-A13) and respond **200** regardless of expiry (D-A14):

```ts
{
  short_code: string,
  target_url: string,
  created_at: string,
  expires_at: string | null,
  is_custom: boolean,
  total_clicks: number,
  clicks_by_day: { date: string; count: number }[],       // UTC YYYY-MM-DD, ascending, sparse
  top_referrers: { referrer: string | null; count: number }[],   // desc by count, then key asc, null last, top 10
  user_agents: { user_agent: string | null; count: number }[]    // same ordering, top 10
}
```

### 4.4 Startup

`node --require ts-node/register src/main.ts` (or the fallback loader, §7). Reads
`PORT`, `BASE_URL`, `IP_HASH_SALT`; builds store + app; listens. Must `tsc
--noEmit` clean under the repo's strict config and start without error (AC-1).

---

## 5. Cross-cutting concerns

### 5.1 Validation

Centralised in `src/api.ts` in the fixed order of §4.1. Each failure throws
`new HttpError(status, code, message)`; the middleware serialises it. No validation
lives in `src/storage.ts`.

### 5.2 Error handling

- Shared response shape (OQ-23): `{ error: string; message: string }` where
  `error` is a stable snake_case machine code from the `ErrorCode` union.
- One terminal Express error middleware (`(err, req, res, next) => …`).
- Malformed JSON from `express.json()` (a `SyntaxError` with a `body` property /
  `type === "entity.parse.failed"`) → 400 `malformed_json`.
- Anything not an `HttpError` → 500 `internal_error`, message
  `"An unexpected error occurred."` — never `err.message`, never `err.stack`.
- The middleware never interpolates `req.ip`, `req.socket.remoteAddress`, headers,
  or file paths (NFR-5, AC-17).

### 5.3 Configuration

| Setting | Source | Type | Default | Consumed by |
| --- | --- | --- | --- | --- |
| `PORT` | env | number | `3000` (OQ-12) | `src/main.ts` listener |
| `BASE_URL` | env | string | `http://localhost:${PORT}` (OQ-12) | `short_url` build |
| `IP_HASH_SALT` | env | string | random 32 bytes hex, per process (OQ-25) | `hashIp` |
| `SHORT_CODE_LENGTH` | const | `7` | fixed by request | code generation |
| `COLLISION_RETRY_LIMIT` | const | `5` | fixed by request | retry loop |
| `USER_AGENT_MAX_LENGTH` | const | `256` (OQ-17) | click capture |
| `URL_MAX_LENGTH` | const | `2048` (OQ-4) | url validation |
| `RESERVED_ALIASES` | const | `["api","admin","static","docs"]` | alias validation |
| `BASE62_ALPHABET` | const | `"0-9A-Za-z"` (62) (OQ-8) | code generation |

Environment-driven values reach `api.ts` only through `CreateAppOptions`.

### 5.4 Logging (OQ-9)

`console`-backed by default, wrapped in a `Logger` interface so tests can inject a
spy without stubbing globals. Two alert lines, both at `error` level, both with
stable greppable prefixes and **no raw IP / no salt**:

- `ALERT code_generation_collision_exhausted attempts=5`
- `ALERT analytics_write_failed code=<code>`

`src/main.ts` may emit one plain startup line. No logging library is added.

### 5.5 Security and privacy

- **IP hashing (NFR-1, NFR-4, AC-17).** HMAC-SHA-256 (D-A11); raw IP hashed at
  first touch, never persisted/logged/returned. `createdByIpHash` and `ipHash` are
  always 64-hex-char non-empty strings, even when `remoteAddress` is undefined
  (the empty string is hashed).
- **SSRF (NFR-3, FR-4.3).** DNS/IP-literal based rejection at creation; the service
  never fetches the target. Blocked ranges enumerated in §6.2.
- **Enumeration resistance (NFR-2).** 7-char codes from unbiased
  `crypto.randomBytes` sampling; not sequential.
- **No auth / rate limiting / update / delete / listing / UI.** Explicitly out of
  scope (spec §1.1); recent repo history trimmed scope deliberately — do not add.

### 5.6 Randomness (NFR-12)

`crypto.randomBytes` for code generation (rejection sampling), `crypto.randomUUID`
for `Click.id`, `crypto.randomBytes` for the default salt. `Math.random` is used
nowhere. A `crypto` failure propagates as a thrown error → 500 `internal_error`
via the middleware, not a crash.

### 5.7 Reliability (NFR-10, NFR-11)

The deferred click writer (D-A9) has its own `try/catch`; the scheduling call is
`void`-ed so no promise floats. A forced `recordClick` rejection leaves the `302`
untouched, logs one alert, and does not reach `process.on("unhandledRejection")`.

### 5.8 Layering (FR-2, NFR-15, AC-14)

`src/storage.ts` imports no `express` and references no `req`/`res`. `src/api.ts`
imports the `LinkStore` *type* only, never `InMemoryLinkStore`. Swapping the store
implementation touches only `src/main.ts`.

---

## 6. Reference tables

### 6.1 Error catalogue

| `error` code | HTTP | Trigger |
| --- | --- | --- |
| `malformed_json` | 400 | `express.json()` could not parse the body. |
| `invalid_request` | 400 | Body not an object; `force_new` not a boolean. |
| `invalid_url` | 400 | `url` missing / not a string / empty / not an absolute `http(s)` URL. |
| `url_too_long` | 400 | `url` length > 2048. |
| `blocked_target` | 400 | Host is `localhost`, an IP literal in a blocked range, resolves to a blocked address, or does not resolve. |
| `invalid_alias` | 400 | `custom_alias` fails `^[A-Za-z0-9_-]{3,32}$`. |
| `alias_reserved` | 400 | `custom_alias` is (ci) `api` / `admin` / `static` / `docs`. |
| `alias_taken` | 409 | `custom_alias` maps to a different `url`, or maps to any link while `force_new` is true. |
| `invalid_expires_at` | 400 | `expires_at` present, not a parseable date-time string. |
| `expires_at_in_past` | 400 | `expires_at` parses but is `<= now()`. |
| `code_generation_failed` | 500 | 5 consecutive code collisions; alert logged; no link created. |
| `not_found` | 404 | `GET /:code` or `GET /api/links/:code` — no such code; also any unmatched route/method. |
| `gone` | 410 | `GET /:code` — link exists but is expired. |
| `internal_error` | 500 | Any unhandled error; generic message, no detail leaked. |

### 6.2 SSRF blocked ranges (OQ-3, resolved)

Blocked as IP literals and for every address returned by `resolveHostname`:

IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16`,
`172.16.0.0/12`, `192.168.0.0/16`.
IPv6: `::1/128`, `::/128`, `fe80::/10` (link-local), `fc00::/7` (unique-local).
IPv4-mapped IPv6 (`::ffff:a.b.c.d`): unwrap and apply the IPv4 rules.
Hostname literal `localhost` (case-insensitive): blocked outright.
DNS resolution failure or empty result: treated as blocked (400 `blocked_target`).
TOCTOU / re-resolution: out of scope (no fetch is performed).

---

## 7. Toolchain decision (OQ-1) — recorded with its risk

**Choice.** Follow the request: run app and tests through `ts-node`.

- `.mocharc.cjs` at repo root: sets `process.env.TS_NODE_PROJECT` to a dedicated
  config, then exports `{ require: ["ts-node/register"], spec: ["tests/**/*.test.ts"],
  extension: ["ts"] }`.
- A dedicated TypeScript config for `src/` + `tests/` (e.g. `tsconfig.src.json`)
  that extends the root and overrides `module: "commonjs"`,
  `moduleResolution: "node"`, `allowImportingTsExtensions: false`,
  `esModuleInterop: true`. The root `tsconfig.json` is left untouched so
  `npm run typecheck` / AC-1 keep exercising the repo's `ESNext` + `bundler`
  config.
- Relative imports are written **without file extensions** (`./storage`,
  `./api`). Extensionless specifiers resolve under the root `bundler` config
  (for `tsc --noEmit`), under CommonJS `node` resolution (for `ts-node`), and
  under `tsx`. This is the one import style that satisfies all three; the contract
  pins it.
- `package.json` scripts: `"start": "node --require ts-node/register src/main.ts"`,
  `"test": "mocha"`.
- Dependency pins: `express@^4`, `@types/express@^4`, `mocha@^10`, `chai@^4`,
  `@types/chai@^4`, `@types/mocha`, `ts-node`. **`chai` is pinned to v4** because
  v5 is ESM-only and fights the CommonJS test setup. `supertest` + `@types/supertest`
  are optional (in-process HTTP assertions, OQ-26).

**Rationale.** The request is explicit about `ts-node` and `ts-node/register`; a
scoped CommonJS config is the least invasive way to make that work despite the
repo's `"type": "module"` + `moduleResolution: bundler` + TypeScript 7 setup, and
it leaves the orchestrator's own tooling (`tsx`) untouched.

**Consequences / residual risk (carried to `verify`).**
- `ts-node` under a `"type": "module"` package with TypeScript `^7` and
  `@types/node ^26` is not a well-trodden combination; `@types/express@4`
  type-checking under `tsc` 7 is unverified. If it proves unworkable, the
  **approved fallback** (OQ-1) is to use `tsx` as the loader
  (`node --import tsx src/main.ts`, `.mocharc` `require: "tsx"`) and record the
  deviation in `artifacts/test/results.md`. Either way the contract's exported
  symbols, routes, and status codes are unchanged.
- New non-source files appear (`.mocharc.cjs`, `tsconfig.src.json`, lockfile);
  none contain application logic.

---

## 8. Decisions log (index)

| ID | Choice | Spec / OQ | Consequence in one line |
| --- | --- | --- | --- |
| D-S1 | `findByTarget` = index lookup + one `links.get` | FR-20.2, NFR-7 | O(1), single source of truth for `Link`. |
| D-S2 | Last-write-wins `targetUrl → code` index | OQ-11 | Only the newest link for a URL is idempotency-matched. |
| D-S3 | `getClicks` returns `array.slice()` | FR-20.3, NFR-8 | Store safe from handler-side sorting; O(clicks-for-code). |
| D-S4 | Return stored `Link`/`Click` by reference | OQ-22 | Handlers must treat them as immutable. |
| D-S5 | Lazy click buckets, seeded on create | §12.18 | Zero-click link returns `[]` with no special case. |
| D-S6 | All store methods `async`, resolve now | FR-20.4 | Real store is a drop-in. |
| D-A1 | `createApp` factory, no `listen` | FR-1 | Tests inject store, never bind a port. |
| D-A2 | Options bag holds all seams + env values | OQ-27, FR-24 | Every FR-23 test writable from the contract. |
| D-A3 | Fixed route order, `/api/*` before `/:code` | §12.23 | Prevents misrouting API calls to the redirect handler. |
| D-A4 | Single error middleware, typed `HttpError` | FR-21, NFR-5 | Uniform JSON errors, no stack/IP/path leak. |
| D-A5 | Fixed validation order | §6 | Deterministic error code when multiple checks fail. |
| D-A6 | Rejection-sampled base62 code generator, exported | FR-7, OQ-8 | Bias-free; directly unit-testable. |
| D-A7 | 5-attempt retry, alert + 500, no partial write | FR-8, AC-13 | Clean store on exhaustion; observable alert. |
| D-A8 | Single idempotency/alias decision tree | FR-5.3, FR-9, FR-10, OQ-11 | Edge cases §12.1–§12.5 fully specified. |
| D-A9 | Respond, then `setImmediate` guarded click write | FR-16, NFR-9/10/11 | Redirect never blocked/failed; no unhandled rejection. |
| D-A10 | 302 + `Cache-Control: no-store` | OQ-13 | Every hit reaches the service and is counted. |
| D-A11 | HMAC-SHA-256 IP hash | OQ-24, NFR-1 | Salted, adequate; no KDF cost. |
| D-A12 | `trust proxy` off; hash `remoteAddress` | OQ-25 | Proxy deployments hash proxy IP — documented limitation. |
| D-A13 | Deterministic stats ordering, top-10, no UA parsing | FR-18, OQ-18/19/20 | Reproducible response for tests. |
| D-A14 | Stats endpoint returns 200 for expired links | OQ-21 | Inspection surface stays usable post-expiry. |
| D-A15 | `baseUrl` injected, trailing slash trimmed | OQ-12 | Deterministic `short_url`, `Host`-independent. |
| D-A16 | Unmatched route/method → 404 `not_found` JSON | OQ-28 | No stray Express HTML; no health endpoint added. |
| D-M1 | Env parsed only in `main.ts` | §11 | Single config surface; `api.ts` is pure. |
| D-M2 | `main.ts` exports nothing | §3 | Tests compose their own app. |
| OQ-1 | `ts-node/register` + scoped CJS tsconfig, extensionless imports, `tsx` fallback | OQ-1 | Extra config files; residual toolchain risk owned by `verify`. |

---

## 9. Open questions / risks carried forward

1. **OQ-1 toolchain** — decision in §7 is the best available, but `ts-node` +
   `"type": "module"` + TS 7 + `@types/express@4` is unproven in this repo. The
   `verify` stage may need the `tsx` fallback; the contract is loader-agnostic.
2. **`@types/express@4` under `tsc@7`** — may raise type errors independent of app
   logic, threatening AC-1. Mitigation: `skipLibCheck` is already on in the root
   config.
3. **SSRF and hostnames in tests** — the enumerated ranges (§6.2) are fixed, and
   `resolveHostname` is injectable, so tests should use IP literals or a stub
   resolver and never hit real DNS. If a test uses a real hostname it becomes
   non-hermetic; the contract flags this.
4. **`IP_HASH_SALT` stability** — per-process salt means cross-restart hash
   comparison is impossible; accepted because the store is volatile too. A test
   that asserts two hashes of the same IP are equal must run in one process with a
   fixed `ipHashSalt` option.
5. **Unbounded `Click[]` growth** — accepted for this stage (OQ-15); noted so it is
   a deliberate deferral.
6. **`orchestrator/runner.ts` uncommitted change** — out of scope for this work;
   operator should commit or revert it before running the pipeline so stage
   gating is deterministic (from the impact analysis).
