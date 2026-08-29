# url-shortener

A small HTTP URL shortener built with Claude agentic workflows.

It exposes a JSON API to create short links (with optional custom aliases and
expiry) and a redirect endpoint that sends visitors to the original URL while
recording click analytics (per-day counts, referrers, user agents). Link
creation is protected by an SSRF guard that rejects targets resolving to
loopback, private, link-local, or otherwise reserved addresses. Storage is
in-memory only, so all data is lost when the process stops.

## Setup

### Prerequisites

- Node.js 24.x (developed and tested against `v24.11.1`).
- npm.

### Install dependencies

The committed `package-lock.json` is currently out of sync with `package.json`
(the test dev-dependencies were added but the lockfile was not regenerated), so
use `npm install` rather than `npm ci`:

```
npm install
```

### Build

There is no build/compile step. The server and tests run TypeScript directly
through `tsx` (an esbuild-based ESM loader); nothing is emitted to disk. `tsx`
does not type-check — run the type-checkers separately if you want that:

```
npm run typecheck       # whole repo (tsconfig.json)
npm run typecheck:src   # src/ + tests/ only (tsconfig.src.json)
```

### Configuration

All configuration is via environment variables, read once at startup in
`src/main.ts`:

| Variable       | Default                        | Purpose |
| -------------- | ------------------------------ | ------- |
| `PORT`         | `3000`                         | TCP port the server listens on. |
| `BASE_URL`     | `http://localhost:<PORT>`      | Public origin used to build `short_url` in responses. One trailing `/` is stripped. |
| `IP_HASH_SALT` | random 32-byte hex per process | Key for HMAC-SHA-256 hashing of creator/visitor IP addresses. If unset, a random salt is generated per process (hashes will not be stable across restarts) and a notice is logged. |

## Running

Start the server:

```
npx tsx src/main.ts
```

With auto-reload during development:

```
npx tsx watch src/main.ts
```

On startup it logs `url-shortener listening on port <PORT> (baseUrl <BASE_URL>)`.

### Tests

```
npm test
```

This runs Mocha (`.mocharc.cjs`), which loads `tests/**/*.test.ts` via `tsx`.
Run `npm install` first so `mocha`, `chai`, and `supertest` are present.

## Endpoints

Every non-2xx response has the JSON body `{ "error": <code>, "message": <string> }`.
Routes are matched in the order below, so `/api/links/:code` is checked before
the catch-all `/:code`.

### `POST /api/links`

Create a short link, or return an existing one (idempotent reuse).

Request body — a JSON object:

| Field          | Type             | Required | Notes |
| -------------- | ---------------- | -------- | ----- |
| `url`          | string           | yes      | Non-empty, at most 2048 characters, must parse as an absolute URL with an `http:` or `https:` scheme. |
| `custom_alias` | string           | no       | Must match `^[A-Za-z0-9_-]{3,32}$`. Must not be a reserved word (`api`, `admin`, `static`, `docs`, case-insensitive). |
| `expires_at`   | string or `null` | no       | ISO 8601 / `Date`-parseable date-time. Must be strictly in the future. `null` or omitted means no expiry. |
| `force_new`    | boolean          | no       | When `true`, skip idempotent reuse of an existing link for the same `url`. |

Responses:

- `201 Created` — a new link was created. Body:
  ```json
  {
    "short_code": "Abc123Z",
    "short_url": "http://localhost:3000/Abc123Z",
    "created_at": "2026-08-29T12:00:00.000Z",
    "expires_at": null
  }
  ```
  `expires_at` is an ISO 8601 UTC string or `null`.
- `200 OK` — same body shape as `201`, returned instead of creating when
  `force_new` is not set and either an existing link has the same `url`, or the
  given `custom_alias` already points at the same `url`.
- `400 malformed_json` — request body is not valid JSON.
- `400 invalid_request` — body is not a JSON object (e.g. an array), or
  `force_new` is present but not a boolean.
- `400 invalid_url` — `url` is missing, empty, not a string, not an absolute
  URL, or not `http`/`https`.
- `400 url_too_long` — `url` exceeds 2048 characters.
- `400 blocked_target` — the target host is `localhost`, is an IP literal in a
  blocked range, or resolves to a blocked address (loopback `127.0.0.0/8` /
  `::1`, private `10/8` `172.16/12` `192.168/16` / `fc00::/7`, link-local
  `169.254/16` / `fe80::/10`, `0.0.0.0/8`, `::`, IPv4-mapped IPv6 of any of
  these); also when hostname resolution throws or returns no addresses.
- `400 invalid_alias` — `custom_alias` fails the pattern.
- `400 alias_reserved` — `custom_alias` is a reserved word.
- `400 invalid_expires_at` — `expires_at` is not a parseable date-time string.
- `400 expires_at_in_past` — `expires_at` is now or in the past.
- `409 alias_taken` — `custom_alias` is already in use for a different URL (also
  returned when the alias is in use and `force_new` is `true`).
- `500 code_generation_failed` — 5 consecutive generated codes all collided.

The creator's IP (`req.socket.remoteAddress`) is stored only as an HMAC hash;
`X-Forwarded-For` is not consulted and no IP appears in any response.

### `GET /api/links/:code`

Return metadata and click statistics for a link. Works even if the link has
expired.

Path parameter: `code` — the short code or custom alias.

Responses:

- `200 OK`:
  ```json
  {
    "short_code": "Abc123Z",
    "target_url": "https://example.com/page",
    "created_at": "2026-08-29T12:00:00.000Z",
    "expires_at": null,
    "is_custom": false,
    "total_clicks": 1,
    "clicks_by_day": [{ "date": "2026-08-29", "count": 1 }],
    "top_referrers": [{ "referrer": "https://news.example", "count": 1 }],
    "user_agents": [{ "user_agent": "Mozilla/5.0 ...", "count": 1 }]
  }
  ```
  `clicks_by_day` is sorted ascending by UTC date. `top_referrers` and
  `user_agents` are sorted by descending count (ties broken alphabetically, a
  `null` bucket last) and capped at 10 entries each; `referrer` / `user_agent`
  may be `null`.
- `404 not_found` — no link exists for `code`.

### `GET /:code`

Redirect to the link's target URL and record a click.

Path parameter: `code` — the short code or custom alias.

Responses:

- `302 Found` — `Location` header is the target URL; `Cache-Control: no-store`
  is set. A click (id, code, timestamp, `Referer`, `User-Agent` truncated to
  256 chars, hashed IP) is recorded asynchronously after the response is sent;
  a failure to record is logged and never affects the redirect.
- `404 not_found` — no link exists for `code`.
- `410 gone` — the link exists but its `expires_at` is now or in the past. No
  click is recorded.

### Any other route or method

Unmatched paths/methods (e.g. `GET /`, `PUT /api/links`,
`DELETE /api/links/abc`) return `404 not_found`. Unexpected server errors return
`500 internal_error`.
