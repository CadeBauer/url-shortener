# URL Shortener — Implementation Contract

Status: design stage output — **normative**.
Companion: `artifacts/design/architecture.md` (rationale for every choice here).

This document is the **only** shared channel between the `implement` branch
(writes `src/`) and the `write_tests` branch (writes `tests/`). They build against
it without seeing each other's work. Anything ambiguous here becomes a merge
failure at `verify`, so it is written to be exhaustive.

Ground rules for both branches:

- Use the **exact** file paths, exported symbol names, type signatures, route
  paths, status codes, and JSON field names below. Do not rename, add, or omit.
- No source file other than the three under `src/` may be created. Helpers live as
  non-exported functions inside those files unless listed in §4.
- Relative imports are written **without a file extension**: `import { LinkStore }
  from "./storage"`, `import { createApp } from "./api"`.
- `tests/shortener.test.ts` imports **only** symbols declared in §4. It must not
  import `src/main.ts`, must not open a network socket unless via an in-process
  supertest call, and must not modify `src/`.
- All timestamps in JSON responses are ISO 8601 UTC strings produced by
  `Date.prototype.toISOString()`.

---

## 1. Source file layout

| Path | Contents (one line) |
| --- | --- |
| `src/storage.ts` | `Link`, `Click`, `LinkStore` types and the `InMemoryLinkStore` class. No `express`, no `req`/`res`. |
| `src/api.ts` | `createApp` factory plus all exported types, the code generator, the IP hasher, `HttpError`, and shared constants. |
| `src/main.ts` | Composition root. Reads env, constructs `InMemoryLinkStore`, calls `createApp`, calls `app.listen`. Exports nothing. |
| `tests/shortener.test.ts` | Mocha + Chai unit suite. Imports from `./src/api` and `./src/storage` (relative path per the test's own location). |

Supporting files the `implement` / `verify` branches add (not part of the
interface, listed so both branches expect them): `.mocharc.cjs`, a scoped
`tsconfig` for `src/` + `tests/` (e.g. `tsconfig.src.json`), `package.json`
dependency + script edits, `package-lock.json`. See `architecture.md` §7.

---

## 2. Shared types

Defined and exported from `src/api.ts` (§4.2). Repeated here because every route
and every error uses them.

```ts
/** Body of every non-2xx response, without exception. */
export interface ErrorResponse {
  /** Stable machine-readable code. One of ErrorCode. */
  error: ErrorCode;
  /** Human-readable detail. Never contains a stack trace, a raw IP, or a filesystem path. */
  message: string;
}

export type ErrorCode =
  | "malformed_json"
  | "invalid_request"
  | "invalid_url"
  | "url_too_long"
  | "blocked_target"
  | "invalid_alias"
  | "alias_reserved"
  | "alias_taken"
  | "invalid_expires_at"
  | "expires_at_in_past"
  | "code_generation_failed"
  | "not_found"
  | "gone"
  | "internal_error";
```

---

## 3. Module: `src/storage.ts`

### 3.1 Exported symbols

```ts
export interface Link {
  code: string;              // primary key: 7-char base62 code or custom alias
  targetUrl: string;         // stored exactly as submitted
  createdAt: Date;           // UTC
  expiresAt: Date | null;    // null => never expires
  isCustom: boolean;         // true iff created from a custom_alias
  createdByIpHash: string;   // HMAC-SHA-256 hex; never a raw IP
}

export interface Click {
  id: string;                // crypto.randomUUID()
  code: string;              // references Link.code
  clickedAt: Date;           // UTC
  referrer: string | null;   // Referer header, or null if absent
  userAgent: string | null;  // User-Agent header truncated to 256 chars, or null if absent/empty
  ipHash: string;            // HMAC-SHA-256 hex; never a raw IP
}

export interface LinkStore {
  createLink(link: Link): Promise<Link>;
  findByCode(code: string): Promise<Link | null>;
  findByTarget(targetUrl: string): Promise<Link | null>;
  recordClick(click: Click): Promise<void>;
  getClicks(code: string): Promise<Click[]>;
}

export class InMemoryLinkStore implements LinkStore {
  constructor();
  createLink(link: Link): Promise<Link>;
  findByCode(code: string): Promise<Link | null>;
  findByTarget(targetUrl: string): Promise<Link | null>;
  recordClick(click: Click): Promise<void>;
  getClicks(code: string): Promise<Click[]>;
}
```

### 3.2 `InMemoryLinkStore` behavioural contract

Internal state (names are implementation detail, semantics are not):

- primary `Map<string, Link>` keyed by `code`;
- secondary `Map<string, string>` mapping `targetUrl → code`;
- `Map<string, Click[]>` keyed by `code`.

| Method | Required behaviour |
| --- | --- |
| `createLink(link)` | Synchronously: set primary `map[link.code] = link`; set `targetIndex[link.targetUrl] = link.code` **unconditionally** (last write wins — see edge cases §7); if no click bucket exists for `link.code`, create an empty one. Resolve with the stored `Link` (same reference is acceptable). Does **not** validate; callers pre-validate. |
| `findByCode(code)` | Exactly one primary-map `get`. Resolve with the `Link` or `null`. No iteration over the collection. |
| `findByTarget(targetUrl)` | Read `targetIndex.get(targetUrl)`; if absent resolve `null`; else resolve `primary.get(code) ?? null`. No iteration over links. |
| `recordClick(click)` | Append `click` to the bucket for `click.code` (creating the bucket if needed). Resolve `void`. |
| `getClicks(code)` | Resolve with a **shallow copy** (`slice()`) of that code's bucket, or `[]` if none. Cost scales only with that code's click count. |

All methods resolve their `Promise` immediately — no `setTimeout`, no artificial
delay.

---

## 4. Module: `src/api.ts`

### 4.1 `createApp`

```ts
import type { Express } from "express";
import type { LinkStore } from "./storage";

export function createApp(store: LinkStore, options?: CreateAppOptions): Express;
```

- Returns a configured Express application. **Does not** call `listen`.
- Mounts `express.json()` and registers routes in the order given in §5.
- Every option in `CreateAppOptions` that is omitted takes the default in §4.3.

### 4.2 Exported symbols (full signatures)

```ts
// ---- factory options -------------------------------------------------------

export interface CreateAppOptions {
  /** Public origin used to build `short_url`. A single trailing "/" is stripped.
   *  Default: "http://localhost:3000". */
  baseUrl?: string;

  /** Key for HMAC-SHA-256 IP hashing.
   *  Default: crypto.randomBytes(32).toString("hex") generated once per createApp call. */
  ipHashSalt?: string;

  /** Short-code generator. Called with no arguments, returns one candidate code.
   *  Default: the exported `generateShortCode`. */
  generateCode?: () => string;

  /** Clock. Default: () => new Date(). Used for createdAt, clickedAt, expiry checks. */
  now?: () => Date;

  /** Hostname resolver for the SSRF guard. Given a DNS hostname (never an IP
   *  literal, never "localhost"), resolves to the list of IP address strings it
   *  maps to. Default: dns.promises.lookup(hostname, { all: true }) mapped to
   *  address strings. A thrown error or empty array is treated as "blocked". */
  resolveHostname?: (hostname: string) => Promise<string[]>;

  /** Sink for the two alert lines. Default: console-backed (see §4.4). */
  logger?: Logger;
}

export interface Logger {
  error(message: string): void;
  warn?(message: string): void;
  info?(message: string): void;
}

// ---- error type ----------------------------------------------------------

export class HttpError extends Error {
  constructor(status: number, code: ErrorCode, message: string);
  readonly status: number;
  readonly code: ErrorCode;
  readonly message: string;
}

// ---- request / response body types -------------------------------------

export interface CreateLinkRequestBody {
  url: string;
  custom_alias?: string;
  expires_at?: string | null;
  force_new?: boolean;
}

export interface CreateLinkResponse {
  short_code: string;
  short_url: string;             // `${baseUrl}/${short_code}`
  created_at: string;            // ISO 8601 UTC
  expires_at: string | null;     // ISO 8601 UTC, or null
}

export interface LinkStatsResponse {
  short_code: string;
  target_url: string;
  created_at: string;            // ISO 8601 UTC
  expires_at: string | null;     // ISO 8601 UTC, or null
  is_custom: boolean;
  total_clicks: number;
  clicks_by_day: ClicksByDayEntry[];
  top_referrers: ReferrerCount[];
  user_agents: UserAgentCount[];
}

export interface ClicksByDayEntry {
  date: string;                  // "YYYY-MM-DD", UTC calendar date
  count: number;
}

export interface ReferrerCount {
  referrer: string | null;
  count: number;
}

export interface UserAgentCount {
  user_agent: string | null;
  count: number;
}

// ---- pure helpers (exported for direct unit testing) -----------------

/** Returns a 7-character string over BASE62_ALPHABET, sampled without modulo
 *  bias from crypto.randomBytes. Never uses Math.random. */
export function generateShortCode(): string;

/** HMAC-SHA-256 of `ip` under `salt`, lowercase hex. `ip` may be "" (still
 *  returns a 64-char hex string). Never logs or returns the raw ip. */
export function hashIp(ip: string, salt: string): string;

// ---- constants -------------------------------------------------------

export const SHORT_CODE_LENGTH: 7;
export const COLLISION_RETRY_LIMIT: 5;
export const USER_AGENT_MAX_LENGTH: 256;
export const URL_MAX_LENGTH: 2048;
export const BASE62_ALPHABET: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const RESERVED_ALIASES: readonly ["api", "admin", "static", "docs"];
export const ALIAS_PATTERN: RegExp; // equivalent to /^[A-Za-z0-9_-]{3,32}$/
```

> Note on constant types: the `: 7` / string-literal annotations above indicate the
> intended `as const` values. An implementation typing them as `number` / `string`
> is acceptable as long as the runtime values match exactly.

### 4.3 Option defaults

| Option | Default |
| --- | --- |
| `baseUrl` | `"http://localhost:3000"` (one trailing `/` stripped if present) |
| `ipHashSalt` | `crypto.randomBytes(32).toString("hex")`, computed once per `createApp` call |
| `generateCode` | `generateShortCode` |
| `now` | `() => new Date()` |
| `resolveHostname` | `async (h) => (await dns.promises.lookup(h, { all: true })).map(r => r.address)` |
| `logger` | see §4.4 |

### 4.4 Default logger and the two alert lines

The default `logger.error` writes to `console.error`. Exactly two alert strings
are emitted by the app, both via `logger.error`, both prefix-stable, both free of
raw IPs and of the salt:

| Event | Exact message |
| --- | --- |
| Code generation collided `COLLISION_RETRY_LIMIT` times | `ALERT code_generation_collision_exhausted attempts=5` |
| Deferred `recordClick` threw or rejected | `ALERT analytics_write_failed code=<code>` |

`src/main.ts` may additionally print one startup line; it must not contain the
salt.

---

## 5. Route table

Registration order (fixed):

1. `express.json()`
2. `POST /api/links`
3. `GET /api/links/:code`
4. `GET /:code`
5. fallback `app.use` → 404 `not_found`
6. error middleware

All response bodies are JSON. All error bodies are `ErrorResponse` (§2).
`Content-Type` on success bodies is `application/json`; on the redirect it is
whatever `res.redirect` sets (a short text/html body is allowed — clients read the
`Location` header and status).

### 5.1 `POST /api/links`

**Request**

| Part | Value |
| --- | --- |
| Method / path | `POST /api/links` |
| Headers | `Content-Type: application/json` (required for the body to be parsed) |
| Params | none |
| Query | none |
| Body | `CreateLinkRequestBody` |

Body field rules:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `url` | `string` | yes | Non-empty; length ≤ 2048; parses as an absolute WHATWG `URL`; protocol is `http:` or `https:`; host is not `localhost`/private/loopback/link-local and does not resolve to such (§5.1 SSRF). |
| `custom_alias` | `string` | no | Matches `ALIAS_PATTERN`; not (case-insensitive) in `RESERVED_ALIASES`. |
| `expires_at` | `string \| null` | no | If a string: `!Number.isNaN(Date.parse(value))` and the resulting instant is strictly `> now()`. `null` / absent ⇒ no expiry. |
| `force_new` | `boolean` | no | If present, must be a boolean. Default `false`. |

**Validation / decision order** (first failure wins):

1. Body parse error ⇒ `400 malformed_json`.
2. Body not a non-null object, or `force_new` present and not boolean ⇒ `400 invalid_request`.
3. `url` missing / not a string / empty ⇒ `400 invalid_url`.
4. `url.length > 2048` ⇒ `400 url_too_long`.
5. `url` not an absolute `URL`, or protocol not `http:`/`https:` ⇒ `400 invalid_url`.
6. SSRF: host is `localhost` (ci), or an IP literal in a blocked range, or resolves (via `resolveHostname`) to any blocked address, or does not resolve ⇒ `400 blocked_target`. Blocked ranges: IPv4 `0.0.0.0/8`, `10.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`; IPv6 `::1`, `::`, `fe80::/10`, `fc00::/7`; IPv4-mapped IPv6 unwrapped and re-checked.
7. `custom_alias` present and fails `ALIAS_PATTERN` ⇒ `400 invalid_alias`.
8. `custom_alias` present and (ci) in `RESERVED_ALIASES` ⇒ `400 alias_reserved`.
9. `expires_at` present, non-null, not a parseable date-time string ⇒ `400 invalid_expires_at`.
10. `expires_at` parses but instant `<= now()` ⇒ `400 expires_at_in_past`.
11. Idempotency / alias-conflict decision tree:
    - **`custom_alias` provided:**
      - `clash = await store.findByCode(custom_alias)`
      - if `clash` and `!force_new` and `clash.targetUrl === url` ⇒ **`200`** `CreateLinkResponse` built from `clash`.
      - else if `clash` ⇒ **`409 alias_taken`**.
      - else (alias free) ⇒ proceed to create with `code = custom_alias`, `isCustom = true`.
    - **no `custom_alias`:**
      - if `!force_new`: `existing = await store.findByTarget(url)`; if `existing` ⇒ **`200`** `CreateLinkResponse` built from `existing`.
      - else ⇒ generate a code (step 12), `isCustom = false`.
12. Code generation (only when no `custom_alias`): loop up to `COLLISION_RETRY_LIMIT` times: `candidate = options.generateCode()`; if `await store.findByCode(candidate)` is `null`, use it. If all attempts collide ⇒ log `ALERT code_generation_collision_exhausted attempts=5`, respond **`500 code_generation_failed`**, create nothing.
13. `await store.createLink({ code, targetUrl: url, createdAt: now(), expiresAt: (expires_at ? new Date(expires_at) : null), isCustom, createdByIpHash: hashIp(req.socket.remoteAddress ?? "", ipHashSalt) })` ⇒ respond **`201`** `CreateLinkResponse`.

**Success responses**

| Status | When | Body |
| --- | --- | --- |
| `201 Created` | A new link was created (generated code or free custom alias). | `CreateLinkResponse` |
| `200 OK` | Idempotent hit: existing link returned, no new link or code created. | `CreateLinkResponse` (fields reflect the existing link, including its original `created_at`) |

`CreateLinkResponse` shape:

```ts
{
  short_code: string,            // the link code
  short_url: string,             // `${baseUrl}/${short_code}`, baseUrl has no trailing slash
  created_at: string,            // link.createdAt.toISOString()
  expires_at: string | null      // link.expiresAt ? link.expiresAt.toISOString() : null
}
```

**Error responses** — all bodies are `ErrorResponse`.

| Status | `error` | Condition |
| --- | --- | --- |
| 400 | `malformed_json` | Request body is not valid JSON. |
| 400 | `invalid_request` | Body is not a JSON object, or `force_new` is not a boolean. |
| 400 | `invalid_url` | `url` missing / not a string / empty / not an absolute URL / scheme not `http`/`https`. |
| 400 | `url_too_long` | `url` length > 2048. |
| 400 | `blocked_target` | Host is `localhost`, a private/loopback/link-local IP (literal or resolved), or the host does not resolve. |
| 400 | `invalid_alias` | `custom_alias` does not match `^[A-Za-z0-9_-]{3,32}$`. |
| 400 | `alias_reserved` | `custom_alias` is (ci) `api` / `admin` / `static` / `docs`. |
| 409 | `alias_taken` | `custom_alias` is already used by a link with a different `targetUrl`, or is used by any link while `force_new` is `true`. |
| 400 | `invalid_expires_at` | `expires_at` is present, non-null, and not a parseable date-time string. |
| 400 | `expires_at_in_past` | `expires_at` parses but is `<= now()`. |
| 500 | `code_generation_failed` | 5 consecutive generated codes collided. Alert logged. No link created. |
| 500 | `internal_error` | Any other unhandled error. |

### 5.2 `GET /:code`

**Request**

| Part | Value |
| --- | --- |
| Method / path | `GET /:code` (single path segment; registered after all `/api/*` routes) |
| Params | `code: string` |
| Query | ignored |
| Headers read | `Referer` → `Click.referrer` (or `null`); `User-Agent` → `Click.userAgent` truncated to 256 chars (or `null` if absent/empty). Client IP from `req.socket.remoteAddress` → `Click.ipHash` only. |
| Body | none |

**Behaviour**

1. `link = await store.findByCode(code)`.
2. `link == null` ⇒ `404 not_found`. No click recorded.
3. `link.expiresAt !== null && link.expiresAt.getTime() <= now().getTime()` ⇒ `410 gone`. No click recorded.
4. Otherwise: set header `Cache-Control: no-store`, respond `302` with header
   `Location: <link.targetUrl>` (exact stored string). Then, via `setImmediate`,
   an `async` guarded task builds a `Click`:
   ```ts
   {
     id: crypto.randomUUID(),
     code: link.code,
     clickedAt: now(),
     referrer: req.get("referer") ?? null,
     userAgent: (req.get("user-agent") ?? "").slice(0, USER_AGENT_MAX_LENGTH) || null,
     ipHash: hashIp(req.socket.remoteAddress ?? "", ipHashSalt),
   }
   ```
   and calls `await store.recordClick(click)` inside `try/catch`. On any
   throw/rejection it logs `ALERT analytics_write_failed code=<code>` and swallows
   the error. It must not produce an unhandled promise rejection and must not
   crash the process.

**Success responses**

| Status | When | Headers | Body |
| --- | --- | --- | --- |
| `302 Found` | `code` matches a live (non-expired) link. | `Location: <targetUrl>`, `Cache-Control: no-store` | redirect body from `res.redirect` (not asserted on) |

**Error responses** — `ErrorResponse` body.

| Status | `error` | Condition |
| --- | --- | --- |
| 404 | `not_found` | No link with that `code`. |
| 410 | `gone` | Link exists but `expiresAt <= now()`. |
| 500 | `internal_error` | Unhandled error in the synchronous part of the handler (the deferred click write never produces a response). |

### 5.3 `GET /api/links/:code`

**Request**

| Part | Value |
| --- | --- |
| Method / path | `GET /api/links/:code` |
| Params | `code: string` |
| Query | none |
| Body | none |

**Behaviour**

1. `link = await store.findByCode(code)`; `null` ⇒ `404 not_found`.
2. `clicks = await store.getClicks(code)`.
3. Respond `200` with `LinkStatsResponse`. Returned **even if the link is
   expired** (`expires_at` in the body signals the state).

Aggregation rules (deterministic):

- `total_clicks` = `clicks.length`.
- `clicks_by_day`: for each click, key = `click.clickedAt.toISOString().slice(0, 10)`
  (UTC `YYYY-MM-DD`). Count per key. Emit only keys with count ≥ 1, sorted
  ascending by the date string. Type `ClicksByDayEntry[]`.
- `top_referrers`: group by `click.referrer` (the value `null` is its own bucket).
  Sort by `count` descending; break ties by the referrer string ascending, with
  the `null` bucket sorted last. Take the first 10. Type `ReferrerCount[]`.
- `user_agents`: group by `click.userAgent` (already truncated; `null` is its own
  bucket). Same sort and same 10-item cap. No user-agent parsing. Type
  `UserAgentCount[]`.
- A link with zero clicks ⇒ `total_clicks: 0` and all three arrays `[]`.

**Success response**

| Status | Body |
| --- | --- |
| `200 OK` | `LinkStatsResponse` |

```ts
{
  short_code: string,            // link.code
  target_url: string,            // link.targetUrl (exact stored string)
  created_at: string,            // link.createdAt.toISOString()
  expires_at: string | null,     // link.expiresAt ? .toISOString() : null
  is_custom: boolean,            // link.isCustom
  total_clicks: number,
  clicks_by_day: { date: string; count: number }[],
  top_referrers: { referrer: string | null; count: number }[],
  user_agents: { user_agent: string | null; count: number }[]
}
```

**Error responses** — `ErrorResponse` body.

| Status | `error` | Condition |
| --- | --- | --- |
| 404 | `not_found` | No link with that `code`. |
| 500 | `internal_error` | Any unhandled error. |

### 5.4 Fallback (any unmatched route or method)

| Status | `error` | Condition |
| --- | --- | --- |
| 404 | `not_found` | Request matched no route above — includes `GET /`, `GET /favicon.ico`, unknown paths, and unsupported methods on known paths. Body is `ErrorResponse`. |

### 5.5 Error middleware (applies to every route)

- Signature `(err, req, res, next)`.
- If `err` is an `HttpError`: respond `err.status` with `{ error: err.code,
  message: err.message }`.
- Else if `err` is a body-parser `SyntaxError` (has a `body`/`type` property from
  `express.json()`): respond `400` with `{ error: "malformed_json", message:
  "Request body is not valid JSON." }`.
- Else: respond `500` with `{ error: "internal_error", message: "An unexpected
  error occurred." }`.
- Never place `err.stack`, `err.message` (for the generic case), a raw IP, request
  headers, or a filesystem path in the response body.

---

## 6. `src/main.ts` behaviour (no exports)

On execution:

1. `const port = Number(process.env.PORT) || 3000;`
2. `const baseUrl = process.env.BASE_URL ?? \`http://localhost:${port}\`;`
3. `const ipHashSalt = process.env.IP_HASH_SALT ?? crypto.randomBytes(32).toString("hex");`
4. `const store = new InMemoryLinkStore();`
5. `const app = createApp(store, { baseUrl, ipHashSalt });`
6. `app.listen(port, () => { /* one startup line, no salt */ });`

Must pass `tsc --noEmit` under the repo root `tsconfig.json` (strict) and start
without throwing (AC-1).

---

## 7. Cross-branch behavioural invariants (test targets)

Both branches must make all of the following true.

| # | Invariant |
| --- | --- |
| I-1 | `generateShortCode()` returns a string of length exactly 7, every character in `BASE62_ALPHABET`; output over many calls is not sequential/monotonic; randomness comes from `crypto.randomBytes` (verifiable by spying on `node:crypto`). |
| I-2 | With `generateCode` injected to return values that all collide with pre-seeded links: `< 5` colliding candidates ⇒ a fresh code is eventually used and `201` returned; exactly 5 collisions ⇒ `500 code_generation_failed`, the alert line is logged, and `store` contains no new link. |
| I-3 | `expiresAt` in the past ⇒ `GET /:code` yields `410`; in the future ⇒ `302`; `null` ⇒ never `410`. `now` is injectable to drive this deterministically. |
| I-4 | Same `url` twice with no `force_new` ⇒ one link; the second `POST` returns `200` with the same `short_code`; `store.findByTarget` (not a scan) served the lookup. Same `url` with `force_new: true` ⇒ a second, distinct `short_code`. Same `url` + same `custom_alias` twice ⇒ `200` idempotent hit (not `409`). Different `url` + used `custom_alias` ⇒ `409`. |
| I-5 | `POST /api/links` with `url` one of `http://127.0.0.1:8080/x`, `http://localhost/x`, `http://[::1]/`, `http://169.254.169.254/`, `http://10.0.0.5/` ⇒ `400 blocked_target`, nothing created. (Tests should pass IP literals or inject `resolveHostname`; never rely on real DNS.) |
| I-6 | With a `LinkStore` stub whose `recordClick` rejects: `GET /:code` still returns `302`; no unhandled rejection; the process stays up; later redirects are unaffected. |
| I-7 | `custom_alias` `"admin"`/`"API"`/`"Docs"` ⇒ `400 alias_reserved`; `"ab"` / 33-char ⇒ `400 invalid_alias`; 3-char and 32-char valid strings ⇒ `201`; `"my-link_1"` (free) ⇒ `201` with `short_code === "my-link_1"` and `is_custom === true` from `GET /api/links/my-link_1`. |
| I-8 | `expires_at` in the past or equal to now ⇒ `400 expires_at_in_past`; unparseable ⇒ `400 invalid_expires_at`; omitted ⇒ `expires_at: null` in every response and the link never expires. |
| I-9 | After one successful redirect, `GET /api/links/:code` shows `total_clicks` incremented by 1, and the click reflected in `clicks_by_day` (UTC date bucket), `top_referrers` (by `Referer` value or the `null` bucket), and `user_agents`. Clicks on either side of a UTC midnight fall into two `clicks_by_day` entries. |
| I-10 | `src/storage.ts` contains no `import ... "express"` and no reference to `req`/`res`. `findByCode` is a single `Map.get`. `findByTarget` uses the secondary index. `getClicks` returns a per-code array. |
| I-11 | No raw client IP appears in any stored `Link`/`Click`, any response body, or any logged line. `createdByIpHash` and `ipHash` are non-empty (64-char hex) strings. |
| I-12 | Every non-2xx response body conforms to `ErrorResponse` with `error` in the `ErrorCode` union. |

---

## 8. Configuration and environment

| Name | Kind | Type | Default | Used by |
| --- | --- | --- | --- | --- |
| `PORT` | env var | integer (parsed with `Number`, `|| 3000`) | `3000` | `src/main.ts` — `app.listen` |
| `BASE_URL` | env var | string, no trailing slash | `http://localhost:${PORT}` | `src/main.ts` → `createApp` `baseUrl` → `short_url` |
| `IP_HASH_SALT` | env var | string | random 32-byte hex, generated once at startup | `src/main.ts` → `createApp` `ipHashSalt` → `hashIp` |
| `SHORT_CODE_LENGTH` | exported const | `7` | fixed | `generateShortCode` |
| `COLLISION_RETRY_LIMIT` | exported const | `5` | fixed | `POST /api/links` retry loop |
| `USER_AGENT_MAX_LENGTH` | exported const | `256` | fixed | click capture |
| `URL_MAX_LENGTH` | exported const | `2048` | fixed | `url` validation |
| `BASE62_ALPHABET` | exported const | 62-char string `0-9A-Za-z` | fixed | `generateShortCode` |
| `RESERVED_ALIASES` | exported const | `readonly ["api","admin","static","docs"]` | fixed | alias validation (case-insensitive compare) |
| `ALIAS_PATTERN` | exported const | `RegExp` = `/^[A-Za-z0-9_-]{3,32}$/` | fixed | alias validation |

`src/api.ts` must not read `process.env`; all environment values arrive through
`CreateAppOptions`.

---

## 9. Dependency notes (for `implement` / `verify`)

- `express@^4` (must be 4.x, not 5), `@types/express@^4`.
- `mocha@^10`, `chai@^4` (pin v4 — chai v5 is ESM-only), `@types/mocha`,
  `@types/chai@^4`, `ts-node`.
- Optional: `supertest`, `@types/supertest` for in-process HTTP assertions.
- `.mocharc.cjs`: `require: ["ts-node/register"]`, `spec: ["tests/**/*.test.ts"]`,
  `extension: ["ts"]`; points `ts-node` at the scoped CJS `tsconfig`.
- If `ts-node` cannot run under the repo's `"type": "module"` + TypeScript 7 setup,
  the approved fallback is to use `tsx` as the loader and record the deviation in
  `artifacts/test/results.md`. The interface in this document does not change.
