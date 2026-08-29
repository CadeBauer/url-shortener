/**
 * tests/shortener.test.ts
 *
 * Test suite for the URL shortener, derived solely from
 * artifacts/design/contract.md. Every assertion is traceable to a contract
 * section / line and cited inline.
 *
 * Runner: Mocha + Chai.
 *   - contract §1 table: "tests/shortener.test.ts | Mocha + Chai unit suite.
 *     Imports from ./src/api and ./src/storage".
 *   - contract §9: mocha@^10, chai@^4, @types/mocha, @types/chai@^4;
 *     "Optional: supertest, @types/supertest for in-process HTTP assertions".
 *   - contract §1 line 21: the suite "must not open a network socket unless via
 *     an in-process supertest call" -> HTTP behaviour is exercised with supertest
 *     against the app returned by createApp (which never calls listen, §4.1).
 *
 * Import rules honoured here:
 *   - Only symbols declared in contract §3 (src/storage) and §4 (src/api) are
 *     imported (contract §1 line 20).
 *   - Relative specifiers are written WITHOUT a file extension (contract line 17).
 *   - Path is relative to this file's own location under tests/ (contract §1
 *     line 34: "relative path per the test's own location") -> ../src/*.
 */

import { expect } from "chai";
import request from "supertest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
  createApp,
  generateShortCode,
  hashIp,
  HttpError,
  SHORT_CODE_LENGTH,
  COLLISION_RETRY_LIMIT,
  USER_AGENT_MAX_LENGTH,
  URL_MAX_LENGTH,
  BASE62_ALPHABET,
  RESERVED_ALIASES,
  ALIAS_PATTERN,
} from "../src/api";
import type {
  CreateAppOptions,
  Logger,
  CreateLinkResponse,
  LinkStatsResponse,
  ErrorResponse,
} from "../src/api";
import { InMemoryLinkStore } from "../src/storage";
import type { Link, Click, LinkStore } from "../src/storage";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Fixed clock for deterministic createdAt / expiry / click-day assertions
 *  (contract §4.2 `now`; §4.3 defaults). 12:00 UTC keeps the calendar date
 *  unambiguous. */
const NOW = new Date("2026-08-29T12:00:00.000Z");

/** contract §4.3: a single trailing "/" is stripped from baseUrl. */
const BASE_URL = "https://sho.rt";

/** contract §4.2 `ipHashSalt`: an explicit key so hashIp output is deterministic
 *  within the run (contract §9 risk note 4). */
const FIXED_SALT = "a".repeat(64);

/** A syntactically valid, non-blocked absolute http(s) URL. Its host is not an
 *  IP literal, so the SSRF guard consults `resolveHostname` (contract §5.1
 *  step 6), which the fixtures stub to a public address. */
const PUBLIC_URL = "https://example.com/page";

/** Every ErrorCode from contract §2 (lines 57-71). Used to prove I-12: every
 *  non-2xx body's `error` is a member of this union. */
const ERROR_CODES = [
  "malformed_json",
  "invalid_request",
  "invalid_url",
  "url_too_long",
  "blocked_target",
  "invalid_alias",
  "alias_reserved",
  "alias_taken",
  "invalid_expires_at",
  "expires_at_in_past",
  "code_generation_failed",
  "not_found",
  "gone",
  "internal_error",
] as const;
type KnownErrorCode = (typeof ERROR_CODES)[number];

function makeLogger(): { logger: Logger; errors: string[]; warns: string[]; infos: string[] } {
  const errors: string[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const logger: Logger = {
    error: (m: string) => errors.push(m),
    warn: (m: string) => warns.push(m),
    info: (m: string) => infos.push(m),
  };
  return { logger, errors, warns, infos };
}

/** Build an app around a caller-supplied store. Defaults cover every seam the
 *  contract exposes (contract §4.2 / §4.3): fixed baseUrl, fixed ipHashSalt,
 *  fixed clock, and a `resolveHostname` that always returns one public address
 *  so non-SSRF tests are hermetic (contract §9 risk note 3 - never hit real
 *  DNS). */
function makeAppWith(store: LinkStore, opts: Partial<CreateAppOptions> = {}) {
  const { logger, errors, warns, infos } = makeLogger();
  const app = createApp(store, {
    baseUrl: BASE_URL,
    ipHashSalt: FIXED_SALT,
    now: () => NOW,
    resolveHostname: async () => ["93.184.216.34"], // TEST-NET-ish public literal, not in any blocked range
    logger,
    ...opts,
  });
  return { app, store, logger, errors, warns, infos };
}

function makeApp(opts: Partial<CreateAppOptions> = {}) {
  const store = new InMemoryLinkStore();
  return { ...makeAppWith(store, opts), store };
}

/** contract §3.1: the exact Link shape. */
function makeLink(over: Partial<Link> = {}): Link {
  return {
    code: "seed001",
    targetUrl: "https://seed.example/x",
    createdAt: NOW,
    expiresAt: null,
    isCustom: false,
    createdByIpHash: "0".repeat(64),
    ...over,
  };
}

/** Deterministic generateCode stub (contract §4.2 `generateCode`). Returns the
 *  supplied codes in order, then repeats the last one. */
function seq(values: string[]): () => string {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

/** Let queued setImmediate / microtask work run. contract §5.2 step 4 defers the
 *  click write via setImmediate; InMemoryLinkStore resolves synchronously
 *  (contract §3.2 "All methods resolve their Promise immediately"). */
function flush(): Promise<void> {
  return new Promise((resolve) =>
    setImmediate(() => setImmediate(() => setTimeout(resolve, 5))),
  );
}

/** Assert an ErrorResponse body (contract §2; §5 "All error bodies are
 *  ErrorResponse"). Proves I-12 for the response under test. */
function expectErrorBody(res: { body: unknown }, code: KnownErrorCode): void {
  const body = res.body as ErrorResponse;
  expect(body, "error body must be an object (contract §2)").to.be.an("object");
  expect(body.error, "error body .error (contract §2)").to.equal(code);
  expect(
    (ERROR_CODES as readonly string[]).includes(body.error as string),
    `error code "${body.error}" must be in the ErrorCode union (contract §2, I-12)`,
  ).to.equal(true);
  expect(body.message, "error body .message (contract §2)").to.be.a("string");
  expect(body.message.length, "message must be non-empty (contract §2)").to.be.greaterThan(0);
  // contract §2 line 52 / §5.5: never a stack trace, raw IP, or filesystem path.
  expect(body.message).to.not.match(/\n\s+at\s+/); // stack frame
  expect(body).to.not.have.property("stack");
}

/** A hand-rolled LinkStore stub (contract §3.1 interface) used where a test must
 *  observe whether createLink / recordClick were called, or force a rejection. */
class StubStore implements LinkStore {
  createCalls: Link[] = [];
  clickCalls: Click[] = [];
  links = new Map<string, Link>();
  targets = new Map<string, string>();
  recordClickImpl: (click: Click) => Promise<void> = async () => {};

  async createLink(link: Link): Promise<Link> {
    this.createCalls.push(link);
    this.links.set(link.code, link);
    this.targets.set(link.targetUrl, link.code);
    return link;
  }
  async findByCode(code: string): Promise<Link | null> {
    return this.links.get(code) ?? null;
  }
  async findByTarget(targetUrl: string): Promise<Link | null> {
    const code = this.targets.get(targetUrl);
    return code ? this.links.get(code) ?? null : null;
  }
  async recordClick(click: Click): Promise<void> {
    this.clickCalls.push(click);
    return this.recordClickImpl(click);
  }
  async getClicks(code: string): Promise<Click[]> {
    return this.clickCalls.filter((c) => c.code === code);
  }
}

// ===========================================================================
// 1. CREATE  (contract §5.1; §4.2 CreateLinkResponse; lines 353-371; I-4)
// ===========================================================================

describe("POST /api/links - create (contract §5.1)", () => {
  it("creates a short link for a valid URL and returns a 201 CreateLinkResponse (contract §5.1 step 13, lines 353-371)", async () => {
    const { app } = makeApp();

    const res = await request(app).post("/api/links").send({ url: PUBLIC_URL });

    expect(res.status, "new link => 201 (contract §5.1 success table)").to.equal(201);
    expect(res.headers["content-type"], "success body is application/json (contract §5 line 307)").to.match(
      /application\/json/,
    );

    const body = res.body as CreateLinkResponse;
    // short_code: generated (no custom_alias) => SHORT_CODE_LENGTH chars over BASE62_ALPHABET
    // (contract line 244; §7 I-1; SHORT_CODE_LENGTH const line 254).
    expect(body.short_code).to.be.a("string");
    expect(body.short_code.length).to.equal(SHORT_CODE_LENGTH);
    for (const ch of body.short_code) {
      expect(BASE62_ALPHABET, `char ${ch} must be in BASE62_ALPHABET`).to.include(ch);
    }
    // short_url = `${baseUrl}/${short_code}` (contract line 367; baseUrl has no trailing slash).
    expect(body.short_url).to.equal(`${BASE_URL}/${body.short_code}`);
    // created_at = link.createdAt.toISOString(); clock is fixed to NOW (contract line 368; §4.2 now).
    expect(body.created_at).to.equal(NOW.toISOString());
    // expires_at: null when expires_at omitted (contract line 369; I-8).
    expect(body.expires_at).to.equal(null);
  });

  it("strips a single trailing slash from baseUrl when building short_url (contract §4.3; line 367; D-A15)", async () => {
    const store = new InMemoryLinkStore();
    const app = createApp(store, {
      baseUrl: "https://sho.rt/", // trailing slash
      ipHashSalt: FIXED_SALT,
      now: () => NOW,
      resolveHostname: async () => ["93.184.216.34"],
      generateCode: seq(["Abc123Z"]),
    });

    const res = await request(app).post("/api/links").send({ url: PUBLIC_URL });

    expect(res.status).to.equal(201);
    expect((res.body as CreateLinkResponse).short_url).to.equal("https://sho.rt/Abc123Z");
  });

  it("echoes a future expires_at as an ISO 8601 UTC string (contract line 369; step 13; I-8)", async () => {
    const { app } = makeApp();
    const future = new Date(NOW.getTime() + 3_600_000).toISOString();

    const res = await request(app).post("/api/links").send({ url: PUBLIC_URL, expires_at: future });

    expect(res.status).to.equal(201);
    expect((res.body as CreateLinkResponse).expires_at).to.equal(new Date(future).toISOString());
  });

  it("treats expires_at: null as no expiry (contract line 328; line 369; I-8)", async () => {
    const { app } = makeApp();

    const res = await request(app).post("/api/links").send({ url: PUBLIC_URL, expires_at: null });

    expect(res.status).to.equal(201);
    expect((res.body as CreateLinkResponse).expires_at).to.equal(null);
  });

  it("accepts a url of exactly URL_MAX_LENGTH characters (contract line 336: only > 2048 is rejected)", async () => {
    const { app } = makeApp();
    const url = "https://example.com/" + "a".repeat(URL_MAX_LENGTH - "https://example.com/".length);
    expect(url.length).to.equal(URL_MAX_LENGTH);

    const res = await request(app).post("/api/links").send({ url });

    expect(res.status, "length == 2048 is allowed (contract line 336)").to.equal(201);
  });

  it("stores the creator IP only as a 64-char hex hash, never raw (contract line 87; §5.1 step 13; I-11)", async () => {
    const store = new StubStore();
    const { app } = makeAppWith(store, { generateCode: seq(["PRIV001"]) });

    const res = await request(app)
      .post("/api/links")
      .set("X-Forwarded-For", "203.0.113.9") // must be ignored (contract D-A12)
      .send({ url: PUBLIC_URL });

    expect(res.status).to.equal(201);
    expect(store.createCalls).to.have.length(1);
    expect(store.createCalls[0].createdByIpHash).to.match(/^[0-9a-f]{64}$/);
    // Response body carries no raw IP field (contract §4.2 CreateLinkResponse has 4 keys only).
    expect(Object.keys(res.body).sort()).to.deep.equal(
      ["created_at", "expires_at", "short_code", "short_url"].sort(),
    );
  });
});

// ===========================================================================
// 2. REDIRECT  (contract §5.2; lines 404-408; I-3)
// ===========================================================================

describe("GET /:code - redirect (contract §5.2)", () => {
  it("resolves an existing live short code to its exact target with 302 + Cache-Control: no-store (contract §5.2 step 4, lines 407-408, 429)", async () => {
    const { app, store } = makeApp();
    await store.createLink(
      makeLink({ code: "redir01", targetUrl: "https://dest.example/landing?a=1", expiresAt: null }),
    );

    const res = await request(app).get("/redir01").redirects(0);

    expect(res.status).to.equal(302);
    expect(res.headers.location, "Location is the exact stored targetUrl (contract line 407)").to.equal(
      "https://dest.example/landing?a=1",
    );
    expect(res.headers["cache-control"]).to.equal("no-store");
  });

  it("returns 404 not_found for an unknown code and records no click (contract §5.2 step 2, line 405, 435)", async () => {
    const store = new StubStore();
    const { app } = makeAppWith(store);

    const res = await request(app).get("/does-not-exist").redirects(0);

    expect(res.status).to.equal(404);
    expectErrorBody(res, "not_found");
    await flush();
    expect(store.clickCalls, "no click for a missing link (contract §5.2 step 2)").to.have.length(0);
  });
});

// ===========================================================================
// 3. EXPIRY  (contract §5.2 step 3, line 406; §5.3 line 454; I-3, I-8)
// ===========================================================================

describe("Expiry (contract §5.2 step 3, line 406; I-3)", () => {
  it("does not resolve an expired short link: GET /:code => 410 gone, no click recorded (contract §5.2 step 3, line 406, 436)", async () => {
    const store = new StubStore();
    store.links.set(
      "exp001",
      makeLink({ code: "exp001", targetUrl: "https://dest.example/x", expiresAt: new Date(NOW.getTime() - 1) }),
    );
    let clicked = false;
    store.recordClickImpl = async () => {
      clicked = true;
    };
    const { app } = makeAppWith(store);

    const res = await request(app).get("/exp001").redirects(0);

    expect(res.status).to.equal(410);
    expectErrorBody(res, "gone");
    await flush();
    expect(clicked, "no click recorded for an expired link (contract §5.2 step 3)").to.equal(false);
  });

  it("future expiry => 302, expiry == now() => 410, null expiry => 302 (contract §5.2 steps 3-4; I-3)", async () => {
    const { app, store } = makeApp();
    await store.createLink(
      makeLink({ code: "fut001", targetUrl: "https://t.example/a", expiresAt: new Date(NOW.getTime() + 60_000) }),
    );
    await store.createLink(
      makeLink({ code: "eq0001", targetUrl: "https://t.example/b", expiresAt: new Date(NOW.getTime()) }),
    );
    await store.createLink(
      makeLink({ code: "null01", targetUrl: "https://t.example/c", expiresAt: null }),
    );

    const fut = await request(app).get("/fut001").redirects(0);
    expect(fut.status, "expiresAt strictly in the future resolves (contract §5.2 step 3)").to.equal(302);
    expect(fut.headers.location).to.equal("https://t.example/a");

    const eq = await request(app).get("/eq0001").redirects(0);
    expect(eq.status, "expiresAt <= now() is gone (contract §5.2 step 3, line 406)").to.equal(410);
    expectErrorBody(eq, "gone");

    const nul = await request(app).get("/null01").redirects(0);
    expect(nul.status, "null expiry never yields 410 (contract §5.2 step 3; I-3)").to.equal(302);
  });

  it("GET /api/links/:code returns 200 with stats even for an expired link (contract §5.3 line 454; D-A14)", async () => {
    const { app, store } = makeApp();
    const past = new Date(NOW.getTime() - 10_000);
    await store.createLink(
      makeLink({ code: "expsta", targetUrl: "https://t.example/z", expiresAt: past, isCustom: true }),
    );

    const res = await request(app).get("/api/links/expsta");

    expect(res.status).to.equal(200);
    const body = res.body as LinkStatsResponse;
    expect(body.short_code).to.equal("expsta");
    expect(body.expires_at, "expires_at signals the expired state (contract §5.3)").to.equal(past.toISOString());
    expect(body.total_clicks).to.equal(0);
  });
});

// ===========================================================================
// 4. SSRF / private-IP target rejection  (contract §5.1 step 6, line 338,
//    381; §6.2; I-5)
// ===========================================================================

describe("SSRF guard - private/internal target rejection (contract §5.1 step 6; I-5)", () => {
  // IP literals in blocked ranges (contract line 338; §6.2). resolveHostname is
  // NOT consulted for literals (contract line 176: "never an IP literal").
  const BLOCKED_LITERAL_URLS: Array<[string, string]> = [
    ["http://127.0.0.1:8080/x", "127.0.0.0/8 loopback"],
    ["http://10.0.0.5/", "10.0.0.0/8 private"],
    ["http://169.254.169.254/", "169.254.0.0/16 link-local (cloud metadata)"],
    ["http://192.168.0.1/", "192.168.0.0/16 private"],
    ["http://172.16.0.1/", "172.16.0.0/12 private"],
    ["http://0.0.0.0/", "0.0.0.0/8"],
    ["http://[::1]/", "IPv6 ::1 loopback"],
    ["http://localhost/x", "localhost literal (contract line 338 'host is localhost (ci)')"],
  ];

  for (const [url, why] of BLOCKED_LITERAL_URLS) {
    it(`rejects ${url} (${why}) with 400 blocked_target (contract §5.1 step 6, line 381; I-5)`, async () => {
      const { app } = makeApp();

      const res = await request(app).post("/api/links").send({ url });

      expect(res.status).to.equal(400);
      expectErrorBody(res, "blocked_target");
    });
  }

  it("rejects an IPv4-mapped IPv6 literal wrapping a private address (contract line 338: 'IPv4-mapped IPv6 unwrapped and re-checked')", async () => {
    const { app } = makeApp();

    const res = await request(app).post("/api/links").send({ url: "http://[::ffff:10.0.0.5]/" });

    expect(res.status).to.equal(400);
    expectErrorBody(res, "blocked_target");
  });

  it("creates nothing when the target is a blocked IP (contract line 381 'nothing created'; I-5)", async () => {
    const store = new StubStore();
    const { app } = makeAppWith(store);

    await request(app).post("/api/links").send({ url: "http://10.0.0.5/" });

    expect(store.createCalls, "no link created for a blocked target (I-5)").to.have.length(0);
  });

  it("rejects a hostname that RESOLVES to a private address (contract line 338 'resolves ... to any blocked address'; I-5)", async () => {
    const { app } = makeApp({ resolveHostname: async () => ["10.0.0.5"] });

    const res = await request(app).post("/api/links").send({ url: "https://intranet.corp.example/x" });

    expect(res.status).to.equal(400);
    expectErrorBody(res, "blocked_target");
  });

  it("rejects a hostname whose resolver throws (contract §4.2 resolveHostname: 'A thrown error ... treated as blocked'; step 6)", async () => {
    const { app } = makeApp({
      resolveHostname: async () => {
        throw new Error("ENOTFOUND");
      },
    });

    const res = await request(app).post("/api/links").send({ url: "https://nx.example/x" });

    expect(res.status).to.equal(400);
    expectErrorBody(res, "blocked_target");
  });

  it("rejects a hostname that resolves to an empty address list (contract §4.2 resolveHostname: 'empty array is treated as blocked')", async () => {
    const { app } = makeApp({ resolveHostname: async () => [] });

    const res = await request(app).post("/api/links").send({ url: "https://empty.example/x" });

    expect(res.status).to.equal(400);
    expectErrorBody(res, "blocked_target");
  });

  it("allows a public host that resolves to a public address (contract §5.1 step 6: only blocked ranges are rejected)", async () => {
    const { app } = makeApp({ resolveHostname: async () => ["93.184.216.34"] });

    const res = await request(app).post("/api/links").send({ url: PUBLIC_URL });

    expect(res.status).to.equal(201);
  });
});

// ===========================================================================
// EXTRA: malformed / invalid input on POST /api/links
// (contract §5.1 validation order, lines 331-342; error table lines 375-388)
// ===========================================================================

describe("POST /api/links - input validation (contract §5.1 decision order)", () => {
  it("400 malformed_json when the body is not valid JSON (contract step 1, line 333; §5.5)", async () => {
    const { app } = makeApp();

    const res = await request(app)
      .post("/api/links")
      .set("Content-Type", "application/json")
      .send('{"url": ');

    expect(res.status).to.equal(400);
    expectErrorBody(res, "malformed_json");
  });

  it("400 invalid_request when force_new is present but not a boolean (contract step 2, line 334, 378)", async () => {
    const { app } = makeApp();

    const res = await request(app).post("/api/links").send({ url: PUBLIC_URL, force_new: "yes" });

    expect(res.status).to.equal(400);
    expectErrorBody(res, "invalid_request");
  });

  it("400 for an array body - most literal reading of contract line 334 ('not a non-null object') vs. arrays being objects", async () => {
    const { app } = makeApp();

    const res = await request(app)
      .post("/api/links")
      .set("Content-Type", "application/json")
      .send("[]");

    // contract line 334 says "Body not a non-null object => invalid_request"; an
    // array is a non-null object, so a strict reading falls through to the
    // missing-url check (step 3 => invalid_url). Accept either; both are 400.
    expect(res.status).to.equal(400);
    expect((res.body as ErrorResponse).error).to.be.oneOf(["invalid_request", "invalid_url"]);
  });

  it("400 invalid_url when url is missing / empty / not a string / not absolute / wrong scheme (contract steps 3 & 5, line 379)", async () => {
    const { app } = makeApp();

    const cases: unknown[] = [
      undefined, // missing
      "", // empty
      12345, // not a string
      "not a url", // not absolute
      "/relative/path", // not absolute
      "example.com/no-scheme", // not absolute
      "ftp://example.com/x", // scheme not http/https (step 5, before SSRF)
      "file:///etc/passwd", // scheme not http/https
    ];

    for (const url of cases) {
      const res = await request(app)
        .post("/api/links")
        .send(url === undefined ? {} : { url });
      expect(res.status, `url=${JSON.stringify(url)} => 400`).to.equal(400);
      expectErrorBody(res, "invalid_url");
    }
  });

  it("400 url_too_long when url length > URL_MAX_LENGTH (contract step 4, line 336, 380)", async () => {
    const { app } = makeApp();
    const url = "https://example.com/" + "a".repeat(URL_MAX_LENGTH + 1);
    expect(url.length).to.be.greaterThan(URL_MAX_LENGTH);

    const res = await request(app).post("/api/links").send({ url });

    expect(res.status).to.equal(400);
    expectErrorBody(res, "url_too_long");
  });

  it("400 invalid_alias when custom_alias fails ALIAS_PATTERN (contract step 7, line 339, 382; I-7)", async () => {
    const { app } = makeApp();

    for (const custom_alias of ["ab", "a".repeat(33), "has space", "bad$char", "no/slash"]) {
      const res = await request(app).post("/api/links").send({ url: PUBLIC_URL, custom_alias });
      expect(res.status, `alias=${custom_alias} => 400`).to.equal(400);
      expectErrorBody(res, "invalid_alias");
    }
  });

  it("400 alias_reserved when custom_alias is a reserved word (case-insensitive) (contract step 8, line 340, 383; I-7)", async () => {
    const { app } = makeApp();

    for (const custom_alias of ["admin", "API", "Docs", "static", "ADMIN"]) {
      const res = await request(app).post("/api/links").send({ url: PUBLIC_URL, custom_alias });
      expect(res.status, `alias=${custom_alias} => 400`).to.equal(400);
      expectErrorBody(res, "alias_reserved");
    }
  });

  it("201 for 3-char and 32-char valid aliases; free alias => short_code echoes it and is_custom is true (contract step 11 last bullet, line 348, 483; I-7)", async () => {
    const { app } = makeApp();

    const short = await request(app).post("/api/links").send({ url: PUBLIC_URL, custom_alias: "abc" });
    expect(short.status).to.equal(201);
    expect((short.body as CreateLinkResponse).short_code).to.equal("abc");

    const long = await request(app)
      .post("/api/links")
      .send({ url: "https://example.com/other", custom_alias: "a".repeat(32) });
    expect(long.status).to.equal(201);

    const named = await request(app)
      .post("/api/links")
      .send({ url: "https://example.com/named", custom_alias: "my-link_1" });
    expect(named.status).to.equal(201);
    expect((named.body as CreateLinkResponse).short_code).to.equal("my-link_1");

    const stats = await request(app).get("/api/links/my-link_1");
    expect(stats.status).to.equal(200);
    expect((stats.body as LinkStatsResponse).is_custom, "custom alias => is_custom true (contract line 483)").to.equal(
      true,
    );
  });

  it("400 invalid_expires_at for an unparseable date-time string (contract step 9, line 341, 385; I-8)", async () => {
    const { app } = makeApp();

    const res = await request(app).post("/api/links").send({ url: PUBLIC_URL, expires_at: "not-a-date" });

    expect(res.status).to.equal(400);
    expectErrorBody(res, "invalid_expires_at");
  });

  it("400 expires_at_in_past when expires_at <= now() (contract step 10, line 342, 386; I-8)", async () => {
    const { app } = makeApp();

    const past = await request(app)
      .post("/api/links")
      .send({ url: PUBLIC_URL, expires_at: new Date(NOW.getTime() - 1000).toISOString() });
    expect(past.status).to.equal(400);
    expectErrorBody(past, "expires_at_in_past");

    const exactlyNow = await request(app)
      .post("/api/links")
      .send({ url: PUBLIC_URL, expires_at: NOW.toISOString() });
    expect(exactlyNow.status, "instant == now() is rejected (contract line 342 '<= now()', line 328 'strictly >')").to.equal(
      400,
    );
    expectErrorBody(exactlyNow, "expires_at_in_past");
  });
});

// ===========================================================================
// EXTRA: idempotency & alias-conflict decision tree
// (contract §5.1 step 11, lines 343-351; §3.2 §7 I-4)
// ===========================================================================

describe("POST /api/links - idempotency & alias conflicts (contract §5.1 step 11; I-4)", () => {
  it("same url twice without force_new => one link; second POST returns 200 with the same short_code (contract line 350; I-4)", async () => {
    const { app } = makeApp({ generateCode: seq(["CODE0001", "CODE0002", "CODE0003"]) });

    const first = await request(app).post("/api/links").send({ url: PUBLIC_URL });
    expect(first.status).to.equal(201);
    expect((first.body as CreateLinkResponse).short_code).to.equal("CODE0001");

    const second = await request(app).post("/api/links").send({ url: PUBLIC_URL });
    expect(second.status, "idempotent hit => 200 (contract §5.1 success table)").to.equal(200);
    expect((second.body as CreateLinkResponse).short_code).to.equal("CODE0001");
    expect(
      (second.body as CreateLinkResponse).created_at,
      "idempotent hit keeps the original created_at (contract line 360)",
    ).to.equal((first.body as CreateLinkResponse).created_at);
  });

  it("same url with force_new: true => a second, distinct short_code (contract line 384/322; I-4)", async () => {
    const { app } = makeApp({ generateCode: seq(["CODE0001", "CODE0002", "CODE0003"]) });

    const a = await request(app).post("/api/links").send({ url: PUBLIC_URL });
    expect(a.status).to.equal(201);

    const b = await request(app).post("/api/links").send({ url: PUBLIC_URL, force_new: true });
    expect(b.status).to.equal(201);
    expect((b.body as CreateLinkResponse).short_code).to.equal("CODE0002");
    expect((b.body as CreateLinkResponse).short_code).to.not.equal(
      (a.body as CreateLinkResponse).short_code,
    );
  });

  it("same url + same custom_alias twice => 200 idempotent hit, not 409 (contract line 346; I-4)", async () => {
    const { app } = makeApp();

    const a = await request(app).post("/api/links").send({ url: PUBLIC_URL, custom_alias: "reuse01" });
    expect(a.status).to.equal(201);

    const b = await request(app).post("/api/links").send({ url: PUBLIC_URL, custom_alias: "reuse01" });
    expect(b.status).to.equal(200);
    expect((b.body as CreateLinkResponse).short_code).to.equal("reuse01");
  });

  it("different url + already-used custom_alias => 409 alias_taken (contract line 347, 384; I-4)", async () => {
    const { app } = makeApp();

    const a = await request(app).post("/api/links").send({ url: PUBLIC_URL, custom_alias: "reuse02" });
    expect(a.status).to.equal(201);

    const conflict = await request(app)
      .post("/api/links")
      .send({ url: "https://example.com/different", custom_alias: "reuse02" });
    expect(conflict.status).to.equal(409);
    expectErrorBody(conflict, "alias_taken");

    const forced = await request(app)
      .post("/api/links")
      .send({ url: PUBLIC_URL, custom_alias: "reuse02", force_new: true });
    expect(forced.status, "any alias hit with force_new true => 409 (contract line 384)").to.equal(409);
    expectErrorBody(forced, "alias_taken");
  });
});

// ===========================================================================
// EXTRA: code-generation collision retry
// (contract §5.1 step 12, line 352, 387; §7 I-2)
// ===========================================================================

describe("Code generation collision retry (contract §5.1 step 12; I-2)", () => {
  it("fewer than COLLISION_RETRY_LIMIT collisions => a fresh code is used and 201 returned (I-2)", async () => {
    const store = new StubStore();
    store.links.set("DUP", makeLink({ code: "DUP" })); // pre-seeded collision
    const { app } = makeAppWith(store, { generateCode: seq(["DUP", "DUP", "DUP", "FREE01"]) });

    const res = await request(app).post("/api/links").send({ url: PUBLIC_URL });

    expect(res.status).to.equal(201);
    expect((res.body as CreateLinkResponse).short_code).to.equal("FREE01");
    expect(store.createCalls).to.have.length(1);
    expect(store.createCalls[0].code).to.equal("FREE01");
  });

  it("COLLISION_RETRY_LIMIT consecutive collisions => 500 code_generation_failed, alert logged, nothing created (contract line 286, 352, 387; I-2)", async () => {
    const store = new StubStore();
    store.links.set("DUP", makeLink({ code: "DUP" }));
    const { app, errors } = makeAppWith(store, { generateCode: seq(["DUP"]) });

    const res = await request(app).post("/api/links").send({ url: PUBLIC_URL });

    expect(res.status).to.equal(500);
    expectErrorBody(res, "code_generation_failed");
    expect(errors, "exact alert line (contract line 286)").to.include(
      "ALERT code_generation_collision_exhausted attempts=5",
    );
    expect(store.createCalls, "no link created on exhaustion (contract line 352; I-2)").to.have.length(0);
    // alert line must not leak the salt (contract line 283-284).
    for (const line of errors) expect(line).to.not.include(FIXED_SALT);
  });
});

// ===========================================================================
// EXTRA: GET /api/links/:code - stats aggregation
// (contract §5.3, lines 439-489; §7 I-9)
// ===========================================================================

describe("GET /api/links/:code - stats (contract §5.3)", () => {
  it("404 not_found for an unknown code (contract §5.3 step 1, line 452, 495)", async () => {
    const { app } = makeApp();

    const res = await request(app).get("/api/links/nope");

    expect(res.status).to.equal(404);
    expectErrorBody(res, "not_found");
  });

  it("a link with zero clicks => total_clicks 0 and all three arrays empty (contract line 469, 483-489)", async () => {
    const { app, store } = makeApp();
    await store.createLink(
      makeLink({ code: "stat00", targetUrl: "https://s.example/a", isCustom: true, createdAt: NOW, expiresAt: null }),
    );

    const res = await request(app).get("/api/links/stat00");

    expect(res.status).to.equal(200);
    const body = res.body as LinkStatsResponse;
    expect(body.short_code).to.equal("stat00");
    expect(body.target_url).to.equal("https://s.example/a"); // contract line 483 (exact stored string)
    expect(body.created_at).to.equal(NOW.toISOString());
    expect(body.expires_at).to.equal(null);
    expect(body.is_custom).to.equal(true);
    expect(body.total_clicks).to.equal(0);
    expect(body.clicks_by_day).to.deep.equal([]);
    expect(body.top_referrers).to.deep.equal([]);
    expect(body.user_agents).to.deep.equal([]);
  });

  it("after one successful redirect, stats reflect the click in total_clicks / clicks_by_day / top_referrers / user_agents (contract lines 457-468; I-9)", async () => {
    const { app, store } = makeApp();
    await store.createLink(
      makeLink({ code: "agg001", targetUrl: "https://agg.example/x", createdAt: NOW, expiresAt: null }),
    );

    const redir = await request(app)
      .get("/agg001")
      .redirects(0)
      .set("Referer", "https://ref.example/pg")
      .set("User-Agent", "MyAgent/1.0");
    expect(redir.status).to.equal(302);

    await flush();

    const res = await request(app).get("/api/links/agg001");
    expect(res.status).to.equal(200);
    const body = res.body as LinkStatsResponse;
    expect(body.total_clicks, "click counted (contract line 458; I-9)").to.equal(1);
    // key = clickedAt.toISOString().slice(0,10); clock fixed to NOW (2026-08-29) (contract line 459).
    expect(body.clicks_by_day).to.deep.equal([{ date: "2026-08-29", count: 1 }]);
    // grouped by Referer value (contract line 462-465).
    expect(body.top_referrers).to.deep.equal([{ referrer: "https://ref.example/pg", count: 1 }]);
    // grouped by (truncated) User-Agent value (contract line 466-468).
    expect(body.user_agents).to.deep.equal([{ user_agent: "MyAgent/1.0", count: 1 }]);
  });
});

// ===========================================================================
// EXTRA: deferred click write - Click shape, truncation, privacy, resilience
// (contract §5.2 step 4, lines 409-423; §7 I-6, I-11)
// ===========================================================================

describe("GET /:code - deferred click write (contract §5.2 step 4)", () => {
  it("builds a Click with a UUID id, the link code, a 64-char hex ipHash, and header-derived fields (contract lines 410-418; I-11)", async () => {
    const store = new StubStore();
    store.links.set("clk001", makeLink({ code: "clk001", targetUrl: "https://d.example/x", expiresAt: null }));
    let captured: Click | undefined;
    store.recordClickImpl = async (c) => {
      captured = c;
    };
    const { app } = makeAppWith(store);

    const res = await request(app)
      .get("/clk001")
      .redirects(0)
      .set("Referer", "https://r.example/a")
      .set("User-Agent", "UA/9");
    expect(res.status).to.equal(302);

    await flush();

    expect(captured, "recordClick was called").to.not.equal(undefined);
    const c = captured as Click;
    expect(c.id, "id = crypto.randomUUID() (contract line 411)").to.match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(c.code).to.equal("clk001");
    expect(c.clickedAt).to.be.instanceOf(Date);
    expect(c.referrer).to.equal("https://r.example/a"); // contract line 415
    expect(c.userAgent).to.equal("UA/9"); // contract line 416
    expect(c.ipHash, "ipHash is 64-char hex, never a raw IP (contract line 96; I-11)").to.match(/^[0-9a-f]{64}$/);
  });

  it("truncates User-Agent to USER_AGENT_MAX_LENGTH; absent Referer/User-Agent => null (contract lines 415-416)", async () => {
    const store = new StubStore();
    store.links.set("clk002", makeLink({ code: "clk002", targetUrl: "https://d.example/y", expiresAt: null }));
    let captured: Click | undefined;
    store.recordClickImpl = async (c) => {
      captured = c;
    };
    const { app } = makeAppWith(store);

    const longUa = "u".repeat(300);
    await request(app).get("/clk002").redirects(0).set("User-Agent", longUa);
    await flush();

    const c = captured as Click;
    expect(c.userAgent, "UA sliced to 256 (contract line 416)").to.have.length(USER_AGENT_MAX_LENGTH);
    expect(c.referrer, "no Referer header => null (contract line 415)").to.equal(null);
  });

  it("still returns 302 when store.recordClick rejects; logs the analytics alert; no unhandled rejection; later redirects unaffected (contract lines 421-423; I-6)", async () => {
    const store = new StubStore();
    store.links.set("res001", makeLink({ code: "res001", targetUrl: "https://d.example/z", expiresAt: null }));
    store.recordClickImpl = async () => {
      throw new Error("analytics DB down");
    };
    const { app, errors } = makeAppWith(store);

    const rejections: unknown[] = [];
    const onRej = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRej);
    try {
      const first = await request(app).get("/res001").redirects(0);
      expect(first.status, "redirect unaffected by analytics failure (contract line 421; I-6)").to.equal(302);
      expect(first.headers.location).to.equal("https://d.example/z");

      await flush();

      expect(errors, "exact analytics alert line (contract line 288)").to.include(
        "ALERT analytics_write_failed code=res001",
      );

      const second = await request(app).get("/res001").redirects(0);
      expect(second.status, "later redirects still work (I-6)").to.equal(302);

      await flush();
      expect(rejections, "no unhandled promise rejection (contract line 421-422; I-6)").to.have.length(0);
    } finally {
      process.removeListener("unhandledRejection", onRej);
    }
  });
});

// ===========================================================================
// EXTRA: fallback 404 for unmatched routes / methods (contract §5.4, line 502)
// ===========================================================================

describe("Fallback routing (contract §5.4)", () => {
  it("GET / => 404 not_found with an ErrorResponse body (contract line 502)", async () => {
    const { app } = makeApp();

    const res = await request(app).get("/");

    expect(res.status).to.equal(404);
    expectErrorBody(res, "not_found");
  });

  it("unsupported method on a known path => 404 not_found (contract line 502)", async () => {
    const { app } = makeApp();

    const put = await request(app).put("/api/links").send({});
    expect(put.status).to.equal(404);
    expectErrorBody(put, "not_found");

    const del = await request(app).delete("/api/links/abc");
    expect(del.status).to.equal(404);
    expectErrorBody(del, "not_found");
  });
});

// ===========================================================================
// EXTRA: exported pure helpers  (contract §4.2 lines 242-261; §7 I-1, I-11)
// ===========================================================================

describe("generateShortCode (contract §4.2 line 244-246; I-1)", () => {
  it("returns a SHORT_CODE_LENGTH string over BASE62_ALPHABET, non-constant / non-monotonic across many calls", () => {
    const samples = Array.from({ length: 256 }, () => generateShortCode());

    for (const s of samples) {
      expect(s).to.be.a("string");
      expect(s.length, "length == SHORT_CODE_LENGTH (contract line 244, 254)").to.equal(SHORT_CODE_LENGTH);
      for (const ch of s) {
        expect(BASE62_ALPHABET, `char ${ch} in BASE62_ALPHABET`).to.include(ch);
      }
    }

    expect(new Set(samples).size, "output must not be constant (I-1)").to.be.greaterThan(1);
    expect(samples, "output must not be already sorted / sequential (I-1)").to.not.deep.equal(
      [...samples].sort(),
    );
  });
});

describe("hashIp (contract §4.2 line 249-250; I-11)", () => {
  it("returns lowercase 64-char hex, is deterministic, differs by input, and never echoes the raw ip", () => {
    const a = hashIp("203.0.113.7", FIXED_SALT);
    const b = hashIp("203.0.113.7", FIXED_SALT);
    const c = hashIp("198.51.100.2", FIXED_SALT);
    const empty = hashIp("", FIXED_SALT); // contract line 249: ip may be ""

    expect(a).to.match(/^[0-9a-f]{64}$/);
    expect(empty, "empty ip still hashes to 64-char hex (contract line 249)").to.match(/^[0-9a-f]{64}$/);
    expect(a).to.equal(b); // deterministic
    expect(a).to.not.equal(c); // input-sensitive
    expect(a).to.not.include("203.0.113.7"); // never contains the raw ip (contract line 250; I-11)
  });
});

describe("HttpError (contract §4.2 lines 192-197)", () => {
  it("is an Error subclass carrying status, code, and message", () => {
    const err = new HttpError(410, "gone", "This link has expired.");

    expect(err).to.be.instanceOf(Error);
    expect(err).to.be.instanceOf(HttpError);
    expect(err.status).to.equal(410);
    expect(err.code).to.equal("gone");
    expect(err.message).to.equal("This link has expired.");
  });
});

describe("Exported constants (contract §4.2 lines 254-260; §8)", () => {
  it("have exactly the values the contract fixes", () => {
    expect(SHORT_CODE_LENGTH).to.equal(7);
    expect(COLLISION_RETRY_LIMIT).to.equal(5);
    expect(USER_AGENT_MAX_LENGTH).to.equal(256);
    expect(URL_MAX_LENGTH).to.equal(2048);
    expect(BASE62_ALPHABET).to.equal(
      "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
    );
    expect(BASE62_ALPHABET).to.have.length(62);
    expect([...RESERVED_ALIASES]).to.deep.equal(["api", "admin", "static", "docs"]);
  });

  it("ALIAS_PATTERN is equivalent to /^[A-Za-z0-9_-]{3,32}$/ (contract line 260, 569)", () => {
    expect(ALIAS_PATTERN).to.be.instanceOf(RegExp);
    expect(ALIAS_PATTERN.test("abc")).to.equal(true); // 3 chars ok
    expect(ALIAS_PATTERN.test("a".repeat(32))).to.equal(true); // 32 chars ok
    expect(ALIAS_PATTERN.test("my-link_1")).to.equal(true);
    expect(ALIAS_PATTERN.test("ab")).to.equal(false); // too short
    expect(ALIAS_PATTERN.test("a".repeat(33))).to.equal(false); // too long
    expect(ALIAS_PATTERN.test("has space")).to.equal(false);
    expect(ALIAS_PATTERN.test("dot.dot")).to.equal(false);
  });
});

// ===========================================================================
// EXTRA: InMemoryLinkStore behavioural contract (contract §3.2, lines 125-134;
// I-10)
// ===========================================================================

describe("InMemoryLinkStore (contract §3.2)", () => {
  it("createLink stores the link and seeds an empty click bucket; findByCode is get-or-null (contract line 127, 128)", async () => {
    const store = new InMemoryLinkStore();
    const link = makeLink({ code: "im0001", targetUrl: "https://im.example/a" });

    const returned = await store.createLink(link);
    expect(returned, "resolves with the stored Link (contract line 127)").to.equal(link);

    expect(await store.findByCode("im0001")).to.equal(link);
    expect(await store.findByCode("absent"), "unknown code => null (contract line 128)").to.equal(null);
    expect(await store.getClicks("im0001"), "click bucket seeded empty (contract line 127)").to.deep.equal([]);
  });

  it("findByTarget uses the secondary index; unknown target => null (contract line 129)", async () => {
    const store = new InMemoryLinkStore();
    const link = makeLink({ code: "im0002", targetUrl: "https://im.example/b" });
    await store.createLink(link);

    expect(await store.findByTarget("https://im.example/b")).to.equal(link);
    expect(await store.findByTarget("https://im.example/missing")).to.equal(null);
  });

  it("createLink updates targetIndex unconditionally: last write wins (contract line 127; D-S2)", async () => {
    const store = new InMemoryLinkStore();
    const first = makeLink({ code: "lw1", targetUrl: "https://same.example/t" });
    const second = makeLink({ code: "lw2", targetUrl: "https://same.example/t" });
    await store.createLink(first);
    await store.createLink(second);

    expect(await store.findByTarget("https://same.example/t"), "index points at the newest link").to.equal(
      second,
    );
    expect(await store.findByCode("lw1"), "older link still reachable by code").to.equal(first);
    expect(await store.findByCode("lw2")).to.equal(second);
  });

  it("recordClick appends; getClicks returns a shallow copy and [] for unknown codes (contract line 130, 131)", async () => {
    const store = new InMemoryLinkStore();
    await store.createLink(makeLink({ code: "im0003" }));
    const click: Click = {
      id: "11111111-1111-1111-1111-111111111111",
      code: "im0003",
      clickedAt: NOW,
      referrer: null,
      userAgent: null,
      ipHash: "f".repeat(64),
    };

    await store.recordClick(click);
    const firstRead = await store.getClicks("im0003");
    expect(firstRead).to.have.length(1);

    firstRead.push(click); // mutate the returned array
    const secondRead = await store.getClicks("im0003");
    expect(secondRead, "getClicks returns a fresh slice() each call (contract line 131)").to.have.length(1);

    expect(await store.getClicks("never-clicked"), "unknown code => [] (contract line 131)").to.deep.equal([]);
  });
});

// ===========================================================================
// EXTRA: layering invariant I-10 (contract §1 line 31; line 550)
// ===========================================================================

describe("Layering (contract §1 line 31; I-10)", () => {
  it("src/storage.ts does not import express", () => {
    const file = path.resolve(__dirname, "../src/storage.ts");
    const source = readFileSync(file, "utf8");

    expect(source, 'storage.ts must not `import ... "express"` (contract line 31, 550)').to.not.match(
      /\bfrom\s+['"]express['"]/,
    );
    expect(source).to.not.match(/\brequire\(\s*['"]express['"]\s*\)/);
  });
});
