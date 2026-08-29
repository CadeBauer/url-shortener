# URL Shortener — Engineering Specification

Status: draft for design stage
Source of truth: `inbox/request.md` plus constraints already established by the repository
(`tsconfig.json`, `package.json`, `orchestrator/stages.ts`, `.claude/agents/*`).
Anything not fixed by those sources is called out in `artifacts/requirements/open_questions.md`
and, where the spec must still be concrete, a default is stated inline and marked
"(default — see OQ-n)".

---

## 1. Overview

Build an HTTP URL shortener service. It accepts a long URL, returns a short code,
serves redirects for that code, records a click event per redirect, and exposes
per-link metadata and click analytics.

The service is a single Node process with an in-memory data store. The store is
hidden behind an interface so it can later be replaced without touching request
handlers.

### 1.1 Scope

In scope:

- The three HTTP endpoints in section 4.
- Random 7-character base62 short codes and validated custom aliases.
- Idempotent creation keyed on the submitted URL (+ alias).
- Link expiry with a distinct `410 Gone` response.
- Click capture with privacy-preserving IP handling.
- Per-link analytics: total clicks, daily time series, top referrers,
  user-agent breakdown.
- An async `LinkStore` interface with an in-memory `Map` implementation.
- Rejection of target URLs that resolve to private/loopback addresses
  (established by `orchestrator/stages.ts`).
- Unit tests for code generation, collision retry, expiry, idempotency.

Out of scope (not in the request; recent history shows scope was deliberately
trimmed — do not add):

- Authentication, authorization, API keys, accounts.
- Rate limiting / abuse throttling beyond the collision retry bound.
- Link update or delete endpoints.
- A persistent database, cache, or message broker.
- A web UI / front end.
- Link listing / search / pagination endpoints.
- HTTPS termination, deployment, containerization.
- Retry/resume of failed analytics writes beyond a single deferred attempt.

---

## 2. Technology constraints

| Concern | Decision | Source |
| --- | --- | --- |
| Language | TypeScript, `strict: true` | request; `tsconfig.json` |
| Runtime execution | Run directly from TypeScript source, no build/emit step (`noEmit: true`) | request; `tsconfig.json` |
| TS→JS loader for the app | `ts-node` per the request; repo currently runs tooling via `tsx` and sets `"type": "module"` | request vs `package.json` — see OQ-1 |
| HTTP framework | Express 4 (not Express 5) | request |
| Data store | In-memory, built on `Map`, behind `LinkStore` interface | request |
| Test framework | Mocha + Chai, loaded with `ts-node/register`, specs run against `.ts` source directly | request |
| Test type | Unit tests only | request |
| Randomness | `crypto.randomBytes` — `Math.random` is prohibited | request |

### 2.1 New dependencies the implementation stage must add

Not currently in `package.json`; the implement/verify stages install them:
`express` (4.x), `@types/express`, `mocha`, `chai`, `ts-node`, `@types/mocha`,
`@types/chai`. Exact versions are the implementer's call; Express must be 4.x.

---

## 3. Source layout and module contracts

File paths are fixed by `orchestrator/stages.ts` and must be used verbatim.

| Path | Responsibility |
| --- | --- |
| `src/storage.ts` | `Link`/`Click` types, the `LinkStore` interface, and the in-memory `Map`-based implementation. No HTTP concerns (`req`, `res`, status codes, Express) may appear in this file. |
| `src/api.ts` | Express router/app factory: request parsing, validation, code generation, idempotency, redirect, analytics, stats. Depends on a `LinkStore` passed in (constructor/factory argument), not on a concrete store. |
| `src/main.ts` | Composition root: construct the in-memory store, build the Express app from `src/api.ts`, start the HTTP listener. Application must compile (`tsc --noEmit`) and start cleanly. |
| `tests/shortener.test.ts` | Mocha + Chai unit suite. |

**FR-1** `src/api.ts` MUST expose a factory (e.g. `createApp(store: LinkStore, config): Express.Application` or `createRouter`) that accepts a `LinkStore`. The exact exported symbol names and signatures are set by `artifacts/design/contract.md`; this spec only requires that the store is injectable so unit tests can supply a stub or a fresh in-memory instance.

**FR-2** `src/storage.ts` MUST NOT import `express` or otherwise reference HTTP request/response objects.

---

## 4. Functional requirements

### 4.1 Create a short link — `POST /api/links`

**FR-3 Request body.** Content-Type `application/json`. Fields:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `url` | string | yes | The target URL, stored exactly as submitted (`Link.targetUrl`). |
| `custom_alias` | string | no | Requested short code instead of a generated one. |
| `expires_at` | string | no | ISO 8601 timestamp. Absent/`null` ⇒ link never expires. |
| `force_new` | boolean | no | When `true`, bypass idempotency and always create a new link. Default `false`. |

**FR-4 URL validation.** `url` MUST:

1. be a non-empty string that parses as an absolute URL (WHATWG `URL`);
2. have scheme `http` or `https` (default — see OQ-2); any other scheme ⇒ `400`;
3. resolve to a publicly routable address. If the host resolves (DNS) to a
   loopback, link-local, or RFC 1918 / RFC 4193 private address, or is a literal
   private/loopback IP, the request MUST be rejected with `400` and no link
   created. (Established by `orchestrator/stages.ts`; blocked ranges enumerated in
   the design — see OQ-3.)
4. length ceiling: `2048` characters (default — see OQ-4); longer ⇒ `400`.

On validation failure the response is `400` with a JSON error body (section 6) and
no state change.

**FR-5 Custom alias validation.** When `custom_alias` is present it MUST:

1. match the charset/length allowlist `^[A-Za-z0-9_-]{3,32}$`; otherwise `400`.
2. not be a reserved word. Reserved list (case-insensitive — default, see OQ-5):
   `api`, `admin`, `static`, `docs`. A reserved alias ⇒ `400`.
3. not already be in use by a different link. If the alias already exists:
   - and it maps to a link whose `targetUrl` equals the submitted `url` and
     `force_new` is not `true` ⇒ idempotent hit (FR-8), return the existing link.
   - otherwise ⇒ `409 Conflict`, no state change (default — see OQ-6).

A link created with a `custom_alias` has `isCustom = true`. A link with a
generated code has `isCustom = false`.

**FR-6 `expires_at` validation.** When present it MUST parse as a valid ISO 8601
date-time. Invalid format ⇒ `400`. A timestamp that is not in the future
(`<= now`) ⇒ `400` (default — see OQ-7). Stored as `Link.expiresAt` (UTC `Date`).

**FR-7 Short code generation.** When no `custom_alias` is given:

1. Generate a 7-character string over the base62 alphabet
   `[0-9A-Za-z]` (62 symbols).
2. Source randomness from `crypto.randomBytes`. `Math.random` MUST NOT be used
   anywhere in code generation. Sampling MUST be free of modulo bias (e.g.
   rejection sampling) (default — see OQ-8).
3. Codes are random, not sequential or monotonic, so the link namespace cannot be
   enumerated by walking codes.

**FR-8 Collision-bounded retry.** After generating a candidate code, check it
against the store. On collision, regenerate. Allow at most **5** attempts total.
If all 5 collide:

1. Respond `500` with a JSON error body.
2. Emit a logged alert (log level `error`, message identifying collision-retry
   exhaustion). (default log channel — see OQ-9.)
3. No link is created.

**FR-9 Idempotent creation.** Creation is idempotent per `(url, custom_alias)`:

- If `force_new` is not `true` and a link already exists whose stored
  `targetUrl` equals the submitted `url` — and, when `custom_alias` is supplied,
  whose `code` equals that alias — return that existing link with status `200`
  (default — see OQ-10) and the same response body shape as a create.
- No new `Link` and no new code are generated on an idempotent hit.
- The idempotency lookup MUST be served by the `Map<targetUrl, code>` secondary
  index (FR-19), i.e. `LinkStore.findByTarget`, not by scanning the link
  collection. Interaction between the index (keyed on `targetUrl` alone) and the
  `(url, custom_alias)` idempotency key is resolved in OQ-11.

**FR-10 `force_new`.** When `force_new === true`, skip the idempotency check and
always create a new link. If `custom_alias` is also supplied and already exists,
FR-5.3 still applies (`409`), because two links cannot share a code.

**FR-11 Success response.** On create (`201`) or idempotent hit (`200`), body:

```json
{
  "short_code": "aB3xK9p",
  "short_url": "http://localhost:3000/aB3xK9p",
  "created_at": "2026-08-29T12:00:00.000Z",
  "expires_at": "2026-09-29T12:00:00.000Z"
}
```

- `short_code` — the link `code` (generated code or custom alias).
- `short_url` — `${BASE_URL}/${short_code}` where `BASE_URL` comes from config
  (env `BASE_URL`), defaulting to `http://localhost:${PORT}` (default — see OQ-12).
- `created_at` — `Link.createdAt` as an ISO 8601 UTC string.
- `expires_at` — ISO 8601 UTC string, or `null` when the link never expires.

### 4.2 Redirect — `GET /:code`

**FR-12 Happy path.** `GET /:code` where `:code` matches a live link:

1. Respond `302` with `Location: <Link.targetUrl>` (target URL returned exactly
   as stored). (302 is mandated by the request — see OQ-13 re caching.)
2. Record a click (FR-15) as a side effect that MUST NOT block or fail the
   redirect (FR-16).

**FR-13 Unknown code.** No link with that code ⇒ `404` (JSON error body). A
click is NOT recorded.

**FR-14 Expired link.** A link exists but `expiresAt != null && expiresAt <= now`
⇒ `410 Gone` (JSON error body). This is deliberately distinct from `404`. Whether
an expired link still records a click is OQ-14 (default: no click recorded).
Expired links are retained in the store (no automatic deletion) unless OQ-15
decides otherwise.

**FR-15 Click capture.** On a successful redirect the service builds a `Click`:

- `id` — unique identifier (`crypto.randomUUID()`, default — see OQ-16).
- `code` — the matched link code.
- `clickedAt` — `new Date()` (UTC).
- `referrer` — the `Referer` request header, or `null` if absent.
- `userAgent` — the `User-Agent` header truncated to **256** characters
  (default — see OQ-17), or `null` if absent.
- `ipHash` — salted hash of the client IP (FR-20). The raw IP is never stored or
  logged.

**FR-16 Analytics decoupled from redirection.** The click write MUST be performed
after the response is sent, via a deferred call (`setImmediate` or an in-process
queue) wrapped in its own error boundary:

1. If `LinkStore.recordClick` rejects or throws, the redirect response is
   unaffected (already sent).
2. The failure is logged at `error` level.
3. The rejection MUST NOT surface as an unhandled promise rejection or otherwise
   crash the process.

### 4.3 Link metadata + stats — `GET /api/links/:code`

**FR-17 Response.** For a known code, respond `200` with link metadata plus
computed analytics:

```json
{
  "short_code": "aB3xK9p",
  "target_url": "https://example.com/very/long/path",
  "created_at": "2026-08-29T12:00:00.000Z",
  "expires_at": null,
  "is_custom": false,
  "total_clicks": 42,
  "clicks_by_day": [
    { "date": "2026-08-29", "count": 40 },
    { "date": "2026-08-30", "count": 2 }
  ],
  "top_referrers": [
    { "referrer": "https://news.example", "count": 30 },
    { "referrer": null, "count": 10 }
  ],
  "user_agents": [
    { "user_agent": "Mozilla/5.0 ...", "count": 25 },
    { "user_agent": "curl/8.4.0", "count": 17 }
  ]
}
```

Exact JSON key names are finalized in `artifacts/design/contract.md`; the fields
themselves are required.

**FR-18 Stats computation.** Derived from `LinkStore.getClicks(code)`:

- `total_clicks` — count of recorded clicks for the code.
- `clicks_by_day` — clicks grouped by the UTC calendar date of `clickedAt`
  (`YYYY-MM-DD`), ascending by date. Only dates with ≥ 1 click are included
  (default — see OQ-18).
- `top_referrers` — clicks grouped by `referrer` value (`null` preserved as a
  distinct bucket), sorted by count descending, limited to the top **10**
  (default — see OQ-19). Ties broken deterministically (e.g. by referrer string).
- `user_agents` — clicks grouped by the stored (already truncated) `userAgent`
  string, `null` preserved as a distinct bucket, sorted by count descending,
  limited to the top **10** (default — see OQ-19). No user-agent parsing
  library; grouping is on the raw string (default — see OQ-20).

**FR-19 Unknown / expired code on this endpoint.** Unknown code ⇒ `404`. An
expired link still returns its metadata and stats with `200` (the stats view is
an operator/inspection surface, not a public redirect) (default — see OQ-21);
`expires_at` in the body makes the expired state visible.

---

## 5. Data model

### 5.1 `Link` (from the request, verbatim)

```ts
interface Link {
  code: string;            // PK: 7-char base62 or custom alias
  targetUrl: string;       // stored as submitted
  createdAt: Date;         // UTC
  expiresAt: Date | null;
  isCustom: boolean;
  createdByIpHash: string; // hashed, never raw
}
```

### 5.2 `Click` (from the request, verbatim)

```ts
interface Click {
  id: string;
  code: string;            // references Link.code
  clickedAt: Date;         // UTC
  referrer: string | null;
  userAgent: string | null; // truncated
  ipHash: string;          // salted hash, never raw IP
}
```

### 5.3 `LinkStore` interface (from the request, verbatim)

```ts
interface LinkStore {
  createLink(link: Link): Promise<Link>;
  findByCode(code: string): Promise<Link | null>;
  findByTarget(targetUrl: string): Promise<Link | null>;
  recordClick(click: Click): Promise<void>;
  getClicks(code: string): Promise<Click[]>;
}
```

**FR-20 Store implementation invariants.** The in-memory implementation MUST:

1. Store links in a primary `Map<string, Link>` keyed by `code`. `findByCode` is a
   single `Map.get` — O(1), no iteration over the collection.
2. Maintain a secondary index `Map<string, string>` (`targetUrl → code`) written
   in the same operation as every `createLink`, kept consistent with the primary
   map. `findByTarget` uses this index; it MUST NOT scan links.
3. Store clicks in `Map<string, Click[]>` keyed by `code`. `getClicks` returns
   that code's array only; it MUST NOT filter one flat global list. Cost of a
   stats read scales with that one link's click count, not with global click
   volume.
4. Resolve every method's `Promise` immediately (the methods are `async` only for
   interface compatibility with a future real store); no artificial delay.
5. Never mutate a `Link` returned to a caller in a way that corrupts the store
   (return copies or treat as immutable — default, see OQ-22).

Behaviour of `findByTarget` after `force_new` created a second link with the same
`targetUrl` (index can hold only one code per URL) is OQ-11.

---

## 6. Error handling

All error responses use HTTP status + a JSON body. Shape (default — see OQ-23):

```json
{ "error": "short machine code", "message": "human-readable detail" }
```

| Condition | Status | Notes |
| --- | --- | --- |
| Malformed JSON body | `400` | Express body-parser error. |
| `url` missing / not a string | `400` | |
| `url` not an absolute http(s) URL | `400` | FR-4.1–4.2 |
| `url` exceeds length ceiling | `400` | FR-4.4 |
| `url` host resolves to private/loopback | `400` | FR-4.3 |
| `custom_alias` fails charset/length allowlist | `400` | FR-5.1 |
| `custom_alias` is a reserved word | `400` | FR-5.2 |
| `custom_alias` already used by a different link | `409` | FR-5.3 |
| `expires_at` unparseable | `400` | FR-6 |
| `expires_at` not in the future | `400` | FR-6 |
| Code generation collided 5× | `500` | FR-8; logged alert. |
| `GET /:code` — no such code | `404` | FR-13 |
| `GET /:code` — link expired | `410` | FR-14 |
| `GET /api/links/:code` — no such code | `404` | FR-19 |
| Analytics write failure | none (redirect already `302`) | FR-16; logged only. |
| Unhandled server error | `500` | Generic handler; no stack traces or IPs in the body. |

**FR-21** A single Express error-handling middleware MUST convert thrown/rejected
errors into the JSON shape above and MUST NOT leak stack traces, raw client IPs,
or internal paths in the response body.

---

## 7. Security & privacy requirements

**NFR-1 IP hashing.** Client IPs are stored only as a salted hash in
`Link.createdByIpHash` and `Click.ipHash`. A cryptographic hash (e.g. SHA-256)
over `salt + ip` (default algorithm — see OQ-24). The salt is read from env
`IP_HASH_SALT`; if unset, a random per-process salt is generated at startup
(default — see OQ-25). Raw IPs MUST NOT be written to the store, response bodies,
or logs.

**NFR-2 Enumeration resistance.** Generated codes are random (FR-7), not
sequential, so the link set cannot be walked by incrementing a code.

**NFR-3 SSRF mitigation.** Target URLs resolving to private, loopback, or
link-local addresses are rejected at creation (FR-4.3). (No fetch of the target
is performed by the service; the check is DNS/IP-literal based.)

**NFR-4 No secrets in logs.** Logs may contain codes, referrers, truncated
user-agents, and hashes; never raw IPs or the salt.

**NFR-5 Response hygiene.** Error bodies carry no stack traces or internal
filesystem paths (see FR-21).

---

## 8. Performance requirements

**NFR-6** Redirect-path code lookup is O(1): exactly one `Map.get(code)` in
`findByCode`, no iteration over links.

**NFR-7** Idempotency check is O(1) via the `targetUrl → code` index; no scan.

**NFR-8** A stats read for a link touches only that link's `Click[]`; its cost is
independent of the total number of clicks stored for other links.

**NFR-9** The redirect response is sent before the click write runs; click
persistence adds no latency to the redirect (FR-16).

---

## 9. Reliability requirements

**NFR-10** A failing analytics write (`recordClick` rejects/throws) never fails a
redirect and never produces an unhandled rejection or process crash (FR-16).

**NFR-11** The process installs no behaviour that lets a deferred analytics error
propagate to `process.on('unhandledRejection')` as a fatal condition; the
deferred task has its own try/catch or `.catch`.

**NFR-12** `crypto.randomBytes` is used synchronously or with proper error
handling; a randomness failure surfaces as a `500`, not a crash.

---

## 10. Persistence & lifecycle requirements

**NFR-13** All state (links, indexes, clicks) lives in process memory. Restarting
the process discards all data. This is acceptable and intended for this stage.

**NFR-14** No file, database, or network persistence is added.

**NFR-15** The `LinkStore` interface is the only coupling between handlers and
storage; swapping the implementation requires no change to `src/api.ts`.

---

## 11. Configuration

| Setting | Env var | Default | Used for |
| --- | --- | --- | --- |
| HTTP port | `PORT` | `3000` (default — see OQ-12) | `src/main.ts` listener |
| Public base URL | `BASE_URL` | `http://localhost:${PORT}` (default — see OQ-12) | `short_url` construction |
| IP hash salt | `IP_HASH_SALT` | random per process (default — see OQ-25) | NFR-1 |
| User-agent truncation length | (constant) | `256` (default — see OQ-17) | FR-15 |
| Collision retry limit | (constant) | `5` | FR-8 (fixed by request) |
| Short code length | (constant) | `7` | FR-7 (fixed by request) |

---

## 12. Edge cases (must be handled explicitly)

1. `POST /api/links` with the same `url` twice, no `force_new` ⇒ second call
   returns the first link, `200`, no new code (FR-9).
2. Same `url` twice with `force_new: true` ⇒ two distinct links/codes; behaviour
   of subsequent `findByTarget` per OQ-11.
3. Same `url` + same `custom_alias` twice ⇒ idempotent hit (FR-9), not `409`.
4. Same `url` + different `custom_alias` (alias free) ⇒ OQ-11 (default: new link
   at the requested alias).
5. Different `url` + an already-used `custom_alias` ⇒ `409` (FR-5.3).
6. `custom_alias` exactly 3 and exactly 32 chars ⇒ valid; 2 and 33 ⇒ `400`.
7. `custom_alias` = `api` / `API` / `Docs` ⇒ `400` reserved (case-insensitive
   default, OQ-5).
8. `custom_alias` containing `.`, space, `/`, or unicode ⇒ `400`.
9. `expires_at` in the past or exactly `now` ⇒ `400` (OQ-7).
10. `expires_at` omitted ⇒ `Link.expiresAt = null`, `expires_at: null` in
    responses, never expires.
11. `GET /:code` for a code that expired between creation and the request ⇒
    `410`, not `404`.
12. `GET /:code` for a never-created code ⇒ `404`, no click recorded.
13. Redirect with no `Referer` header ⇒ `Click.referrer = null`; appears as a
    `null` bucket in `top_referrers`.
14. Redirect with no `User-Agent` header ⇒ `Click.userAgent = null`.
15. Redirect with a 5 KB `User-Agent` ⇒ stored truncated to 256 chars.
16. `recordClick` throws for one redirect ⇒ that redirect still `302`; error
    logged; process stays up; later redirects unaffected.
17. Code generation hits 5 consecutive collisions ⇒ `500` + logged alert, no
    partial link written.
18. `GET /api/links/:code` for a link with zero clicks ⇒ `total_clicks: 0`,
    empty `clicks_by_day`/`top_referrers`/`user_agents` arrays.
19. `GET /api/links/:code` for an expired link ⇒ `200` metadata + stats (OQ-21).
20. Target URL `http://127.0.0.1:8080/x`, `http://localhost/x`, `http://[::1]/`,
    `http://169.254.169.254/`, `http://10.0.0.5/` ⇒ all `400` (NFR-3).
21. Clicks spanning a UTC midnight ⇒ split across two `clicks_by_day` entries by
    UTC date.
22. Reserved words are 3–6 chars; a random 7-char code can never equal one, so no
    special-casing of generated codes against the reserved list is required.
23. Path collision: `GET /api/links` (no code) must route to the metadata handler
    family, not be treated as `GET /:code` with `code = "api"` — route ordering
    must place `/api/*` before the `/:code` catch-all.

---

## 13. Testing requirements

**FR-22** A Mocha + Chai unit suite in `tests/shortener.test.ts`, run via
`ts-node/register`, executing against the TypeScript source directly. Unit tests
only — no full HTTP integration harness is required by the request (an in-process
Express assertion via `supertest`-style calls is allowed but not mandated;
see OQ-26).

**FR-23** Required coverage (explicitly named in the request):

1. **Code generation** — produced codes are 7 chars, all within the base62
   alphabet; randomness comes from `crypto.randomBytes` (e.g. by injecting a fake
   byte source / spying); output is not sequential.
2. **Collision retry** — with a store/generator arranged so the first N
   candidates collide: N < 5 ⇒ eventually returns a fresh code; N = 5 ⇒ surfaces
   the `500` path and logs the alert; the store is left with no partial link.
3. **Expiry logic** — a link with `expiresAt` in the past ⇒ redirect path yields
   `410`; `expiresAt` in the future ⇒ `302`; `expiresAt = null` ⇒ never `410`.
4. **Idempotency** — same `(url)` / same `(url, custom_alias)` twice without
   `force_new` ⇒ one link, second call returns the first; `force_new: true` ⇒ a
   second distinct link; the `targetUrl → code` index is used (no scan).

**FR-24** For (1) and (2) to be testable, `src/api.ts` / `src/storage.ts` MUST
expose seams: an injectable `LinkStore` (already required, FR-1) and an
injectable or overridable randomness/code-generation function (design decides the
exact seam — see OQ-27).

**FR-25** Tests must not modify anything under `src/`. A red test is a finding,
not a licence to change the code under test (per `.claude/agents/test-engineer.md`).

---

## 14. Acceptance criteria

The stage is complete when all of the following hold:

- **AC-1** `tsc --noEmit` passes with `strict: true`; `src/main.ts` starts an
  Express 4 server and listens without error.
- **AC-2** `POST /api/links` with `{ "url": "https://example.com/x" }` returns
  `201` and a body with `short_code` (7 base62 chars), `short_url`
  (`<base>/<short_code>`), ISO `created_at`, and `expires_at: null`.
- **AC-3** Repeating the AC-2 request returns `200` with the identical
  `short_code`; no second link exists.
- **AC-4** The same request with `force_new: true` returns a different
  `short_code`.
- **AC-5** `POST /api/links` with `custom_alias: "admin"` returns `400`;
  with `custom_alias: "ab"` returns `400`; with `custom_alias: "my-link_1"`
  (free) returns `201` and `short_code = "my-link_1"`, `is_custom` true in the
  metadata endpoint.
- **AC-6** `custom_alias` already used for a different URL returns `409`.
- **AC-7** `POST /api/links` with `expires_at` in the past returns `400`;
  with a malformed `expires_at` returns `400`.
- **AC-8** `POST /api/links` with `url` = `http://10.0.0.5/` (and other private/
  loopback targets from edge case 20) returns `400` and creates nothing.
- **AC-9** `GET /:code` for a live link returns `302` with `Location` equal to
  the exact submitted URL.
- **AC-10** After a successful redirect, `GET /api/links/:code` shows
  `total_clicks` incremented by 1 and the click reflected in `clicks_by_day`,
  `top_referrers` (by `Referer` or `null`), and `user_agents`.
- **AC-11** `GET /:code` for an unknown code returns `404`; for an expired link
  returns `410`.
- **AC-12** With `recordClick` forced to reject, `GET /:code` still returns
  `302` and the process does not crash (no unhandled rejection).
- **AC-13** With the code generator forced to collide 5×, `POST /api/links`
  returns `500`, an `error`-level alert is logged, and no link is stored.
- **AC-14** `src/storage.ts` contains no `express` import and no HTTP request/
  response references.
- **AC-15** `findByCode` performs exactly one `Map.get`; `findByTarget` uses the
  secondary index; `getClicks` returns a per-code array — verifiable by
  inspection and/or unit test.
- **AC-16** The Mocha suite (FR-23) passes under `ts-node/register`.
- **AC-17** Raw client IPs appear nowhere in stored records, responses, or logs;
  `createdByIpHash` / `ipHash` are non-empty hash strings.

---

## 15. Traceability — request line → requirement

| Request statement | Requirement(s) |
| --- | --- |
| TS strict, Express 4, ts-node, no build step | §2, FR-1 |
| In-memory Map store behind `LinkStore` | FR-1, FR-2, FR-20, NFR-13–15 |
| Mocha + Chai + ts-node/register, unit only | §2, FR-22–25 |
| `POST /api/links` body/response/201 | FR-3, FR-11 |
| `GET /{code}` 302 + records click | FR-12, FR-15 |
| `GET /api/links/{code}` metadata + stats | FR-17, FR-18 |
| 7-char base62, `crypto.randomBytes`, not `Math.random` | FR-7, NFR-12 |
| Bounded collision retry, max 5, then 500 + alert | FR-8, AC-13 |
| Random not sequential (no enumeration) | FR-7, NFR-2 |
| Custom alias reserved words + charset allowlist | FR-5 |
| Idempotent per `(url, custom_alias)`, `force_new` override | FR-9, FR-10 |
| Expired ⇒ 410 not 404 | FR-14 |
| `Link` / `Click` interfaces | §5.1, §5.2 |
| Redirect lookup is single `Map.get`, O(1) | FR-20.1, NFR-6 |
| IPs salted-hashed, never raw | NFR-1, NFR-4, AC-17 |
| Clicks indexed by code `Map<string, Click[]>` | FR-20.3, NFR-8 |
| Idempotency via `Map<targetUrl, code>` index | FR-20.2, NFR-7 |
| Analytics decoupled; deferred; own error boundary; no crash | FR-16, NFR-10–11 |
| `LinkStore` all-async interface | §5.3, FR-20.4 |
| Tests: code gen, collision retry, expiry, idempotency | FR-23 |
| Reject private/loopback target URLs (`stages.ts`) | FR-4.3, NFR-3, AC-8 |
| File layout `src/storage.ts`,`src/api.ts`,`src/main.ts`, `tests/shortener.test.ts` (`stages.ts`) | §3 |
