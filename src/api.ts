/**
 * src/api.ts
 *
 * Everything request-facing: the `createApp` factory, routing, input
 * validation, the SSRF guard, short-code generation, idempotency, the
 * redirect + deferred click writer, stats aggregation, IP hashing, and the
 * single terminal error middleware.
 *
 * Depends only on the `LinkStore` *interface* from `./storage` — never on the
 * concrete `InMemoryLinkStore`. Never reads `process.env`; every
 * environment-derived value arrives through `CreateAppOptions`.
 */

import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LinkStore } from "./storage";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Body of every non-2xx response, without exception. */
export interface ErrorResponse {
  /** Stable machine-readable code. One of `ErrorCode`. */
  error: ErrorCode;
  /** Human-readable detail. Never a stack trace, a raw IP, or a filesystem path. */
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

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

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

  /** Sink for the two alert lines. Default: console-backed. */
  logger?: Logger;
}

export interface Logger {
  error(message: string): void;
  warn?(message: string): void;
  info?(message: string): void;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Request / response body types
// ---------------------------------------------------------------------------

export interface CreateLinkRequestBody {
  url: string;
  custom_alias?: string;
  expires_at?: string | null;
  force_new?: boolean;
}

export interface CreateLinkResponse {
  short_code: string;
  short_url: string; // `${baseUrl}/${short_code}`
  created_at: string; // ISO 8601 UTC
  expires_at: string | null; // ISO 8601 UTC, or null
}

export interface LinkStatsResponse {
  short_code: string;
  target_url: string;
  created_at: string; // ISO 8601 UTC
  expires_at: string | null; // ISO 8601 UTC, or null
  is_custom: boolean;
  total_clicks: number;
  clicks_by_day: ClicksByDayEntry[];
  top_referrers: ReferrerCount[];
  user_agents: UserAgentCount[];
}

export interface ClicksByDayEntry {
  date: string; // "YYYY-MM-DD", UTC calendar date
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SHORT_CODE_LENGTH = 7;
export const COLLISION_RETRY_LIMIT = 5;
export const USER_AGENT_MAX_LENGTH = 256;
export const URL_MAX_LENGTH = 2048;
export const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const RESERVED_ALIASES = ["api", "admin", "static", "docs"] as const;
export const ALIAS_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;

/** Largest multiple of 62 that is <= 256; bytes >= this are rejected. */
const REJECTION_THRESHOLD = 248;

// ---------------------------------------------------------------------------
// Pure helpers (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Returns a `SHORT_CODE_LENGTH`-character string over `BASE62_ALPHABET`,
 * sampled from `crypto.randomBytes` without modulo bias (rejection sampling:
 * a byte `b` is accepted only when `b < 248`, contributing `b % 62`).
 * Never uses `Math.random`.
 */
export function generateShortCode(): string {
  let out = "";
  while (out.length < SHORT_CODE_LENGTH) {
    const bytes = randomBytes(SHORT_CODE_LENGTH);
    for (let i = 0; i < bytes.length && out.length < SHORT_CODE_LENGTH; i++) {
      const b = bytes[i];
      if (b < REJECTION_THRESHOLD) {
        out += BASE62_ALPHABET[b % 62];
      }
    }
  }
  return out;
}

/**
 * HMAC-SHA-256 of `ip` under `salt`, lowercase hex. `ip` may be "" (still
 * returns a 64-char hex string). Never logs or returns the raw ip.
 */
export function hashIp(ip: string, salt: string): string {
  return createHmac("sha256", salt).update(ip).digest("hex");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const defaultLogger: Logger = {
  error: (message: string) => console.error(message),
  warn: (message: string) => console.warn(message),
  info: (message: string) => console.info(message),
};

const defaultResolveHostname = async (hostname: string): Promise<string[]> => {
  const results = await dnsLookup(hostname, { all: true });
  return results.map((r) => r.address);
};

function parseIpv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    n = n * 256 + value;
  }
  return n >>> 0;
}

function ipv4InCidr(n: number, base: string, prefixBits: number): boolean {
  const baseInt = parseIpv4ToInt(base);
  if (baseInt === null) {
    return false;
  }
  const mask =
    prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
  return (n & mask) === (baseInt & mask);
}

function isBlockedIpv4(ip: string): boolean {
  const n = parseIpv4ToInt(ip);
  if (n === null) {
    // Not a parseable IPv4 literal — caller decides; treat as not-a-v4-match.
    return false;
  }
  return (
    ipv4InCidr(n, "0.0.0.0", 8) ||
    ipv4InCidr(n, "10.0.0.0", 8) ||
    ipv4InCidr(n, "127.0.0.0", 8) ||
    ipv4InCidr(n, "169.254.0.0", 16) ||
    ipv4InCidr(n, "172.16.0.0", 12) ||
    ipv4InCidr(n, "192.168.0.0", 16)
  );
}

function expandIpv6(input: string): string | null {
  let addr = input.toLowerCase();

  // Drop any zone identifier (e.g. "fe80::1%eth0").
  const zoneIdx = addr.indexOf("%");
  if (zoneIdx !== -1) {
    addr = addr.slice(0, zoneIdx);
  }

  // Convert a trailing embedded IPv4 (e.g. "::ffff:1.2.3.4") into two hextets.
  const lastColon = addr.lastIndexOf(":");
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4ToInt(addr.slice(lastColon + 1));
    if (v4 === null) {
      return null;
    }
    const hi = ((v4 >>> 16) & 0xffff).toString(16).padStart(4, "0");
    const lo = (v4 & 0xffff).toString(16).padStart(4, "0");
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleIdx = addr.indexOf("::");
  let hextets: string[];
  if (doubleIdx !== -1) {
    const before = addr.slice(0, doubleIdx);
    const after = addr.slice(doubleIdx + 2);
    const head = before.length > 0 ? before.split(":") : [];
    const tail = after.length > 0 ? after.split(":") : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) {
      return null;
    }
    hextets = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    hextets = addr.split(":");
  }

  if (hextets.length !== 8) {
    return null;
  }
  return hextets.map((h) => h.padStart(4, "0")).join(":");
}

function isBlockedIpv6(ip: string): boolean {
  const expanded = expandIpv6(ip);
  if (expanded === null) {
    // Unrecognisable — err on the side of blocking.
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:a.b.c.d): unwrap and apply the IPv4 rules.
  if (expanded.startsWith("0000:0000:0000:0000:0000:ffff:")) {
    const parts = expanded.split(":");
    const v4 =
      ((parseInt(parts[6], 16) << 16) | parseInt(parts[7], 16)) >>> 0;
    const dotted = [
      (v4 >>> 24) & 0xff,
      (v4 >>> 16) & 0xff,
      (v4 >>> 8) & 0xff,
      v4 & 0xff,
    ].join(".");
    return isBlockedIpv4(dotted);
  }

  if (expanded === "0000:0000:0000:0000:0000:0000:0000:0001") {
    return true; // ::1 loopback
  }
  if (expanded === "0000:0000:0000:0000:0000:0000:0000:0000") {
    return true; // :: unspecified
  }

  const firstHextet = parseInt(expanded.slice(0, 4), 16);
  if ((firstHextet & 0xffc0) === 0xfe80) {
    return true; // fe80::/10 link-local
  }
  if ((firstHextet & 0xfe00) === 0xfc00) {
    return true; // fc00::/7 unique-local
  }
  return false;
}

function isBlockedAddress(addr: string): boolean {
  const kind = isIP(addr);
  if (kind === 4) {
    return isBlockedIpv4(addr);
  }
  if (kind === 6) {
    return isBlockedIpv6(addr);
  }
  // Not an IP we can classify — block defensively.
  return true;
}

async function assertTargetAllowed(
  hostname: string,
  resolveHostname: (hostname: string) => Promise<string[]>,
): Promise<void> {
  const blocked = () =>
    new HttpError(400, "blocked_target", "The target host is not allowed.");

  let host = hostname;
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1); // WHATWG URL keeps IPv6 hosts bracketed
  }

  if (host.toLowerCase() === "localhost") {
    throw blocked();
  }

  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw blocked();
    }
    return;
  }

  let addresses: string[];
  try {
    addresses = await resolveHostname(host);
  } catch {
    throw blocked();
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw blocked();
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw blocked();
    }
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

interface LinkView {
  code: string;
  targetUrl: string;
  createdAt: Date;
  expiresAt: Date | null;
  isCustom: boolean;
}

function buildCreateResponse(
  link: LinkView,
  baseUrl: string,
): CreateLinkResponse {
  return {
    short_code: link.code,
    short_url: `${baseUrl}/${link.code}`,
    created_at: link.createdAt.toISOString(),
    expires_at: link.expiresAt ? link.expiresAt.toISOString() : null,
  };
}

function aggregateClicksByDay(
  clickedAts: Date[],
): ClicksByDayEntry[] {
  const counts = new Map<string, number>();
  for (const clickedAt of clickedAts) {
    const key = clickedAt.toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, count]) => ({ date, count }));
}

function groupCounts(
  values: (string | null)[],
): { key: string | null; count: number }[] {
  const counts = new Map<string, number>();
  let nullCount = 0;
  for (const value of values) {
    if (value === null) {
      nullCount += 1;
    } else {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  const entries: { key: string | null; count: number }[] = [
    ...counts.entries(),
  ].map(([key, count]) => ({ key, count }));
  if (nullCount > 0) {
    entries.push({ key: null, count: nullCount });
  }
  entries.sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    if (a.key === null) {
      return 1; // null bucket sorts last
    }
    if (b.key === null) {
      return -1;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return entries.slice(0, 10);
}

function isBodyParserSyntaxError(err: unknown): boolean {
  if (!(err instanceof SyntaxError)) {
    return false;
  }
  const candidate = err as { body?: unknown; type?: unknown };
  return "body" in err || candidate.type === "entity.parse.failed";
}

type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

function wrapAsync(handler: AsyncRouteHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}

// ---------------------------------------------------------------------------
// createApp
// ---------------------------------------------------------------------------

export function createApp(
  store: LinkStore,
  options: CreateAppOptions = {},
): Express {
  const baseUrl = stripTrailingSlash(
    options.baseUrl ?? "http://localhost:3000",
  );
  const ipHashSalt =
    options.ipHashSalt ?? randomBytes(32).toString("hex");
  const generateCode = options.generateCode ?? generateShortCode;
  const now = options.now ?? (() => new Date());
  const resolveHostname = options.resolveHostname ?? defaultResolveHostname;
  const logger = options.logger ?? defaultLogger;

  const app = express();

  // 1. Body parser.
  app.use(express.json());

  // 2. POST /api/links — create (or idempotent hit).
  app.post(
    "/api/links",
    wrapAsync(async (req, res) => {
      const body: unknown = req.body;

      // Step 2: body shape + force_new type.
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body)
      ) {
        throw new HttpError(
          400,
          "invalid_request",
          "Request body must be a JSON object.",
        );
      }
      const input = body as Record<string, unknown>;
      if (
        input.force_new !== undefined &&
        typeof input.force_new !== "boolean"
      ) {
        throw new HttpError(
          400,
          "invalid_request",
          "`force_new` must be a boolean.",
        );
      }
      const forceNew = input.force_new === true;

      // Step 3: url presence / type.
      const url = input.url;
      if (typeof url !== "string" || url.length === 0) {
        throw new HttpError(
          400,
          "invalid_url",
          "`url` is required and must be a non-empty string.",
        );
      }

      // Step 4: url length.
      if (url.length > URL_MAX_LENGTH) {
        throw new HttpError(
          400,
          "url_too_long",
          `\`url\` must be at most ${URL_MAX_LENGTH} characters.`,
        );
      }

      // Step 5: url parse + scheme.
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw new HttpError(
          400,
          "invalid_url",
          "`url` must be an absolute http(s) URL.",
        );
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new HttpError(
          400,
          "invalid_url",
          "`url` must use the http or https scheme.",
        );
      }

      // Step 6: SSRF guard.
      await assertTargetAllowed(parsedUrl.hostname, resolveHostname);

      // Step 7 + 8: custom_alias charset then reserved words.
      const rawAlias = input.custom_alias;
      let customAlias: string | undefined;
      if (rawAlias !== undefined) {
        if (typeof rawAlias !== "string" || !ALIAS_PATTERN.test(rawAlias)) {
          throw new HttpError(
            400,
            "invalid_alias",
            "`custom_alias` must match ^[A-Za-z0-9_-]{3,32}$.",
          );
        }
        if (
          RESERVED_ALIASES.some(
            (reserved) => reserved === rawAlias.toLowerCase(),
          )
        ) {
          throw new HttpError(
            400,
            "alias_reserved",
            "`custom_alias` is reserved.",
          );
        }
        customAlias = rawAlias;
      }

      // Step 9 + 10: expires_at parse then future check.
      const rawExpiresAt = input.expires_at;
      let expiresAt: Date | null = null;
      if (rawExpiresAt !== undefined && rawExpiresAt !== null) {
        if (
          typeof rawExpiresAt !== "string" ||
          Number.isNaN(Date.parse(rawExpiresAt))
        ) {
          throw new HttpError(
            400,
            "invalid_expires_at",
            "`expires_at` must be a valid date-time string.",
          );
        }
        const candidate = new Date(rawExpiresAt);
        if (candidate.getTime() <= now().getTime()) {
          throw new HttpError(
            400,
            "expires_at_in_past",
            "`expires_at` must be in the future.",
          );
        }
        expiresAt = candidate;
      }

      // Step 11: idempotency / alias-conflict decision tree.
      let code: string;
      let isCustom: boolean;

      if (customAlias !== undefined) {
        const clash = await store.findByCode(customAlias);
        if (clash) {
          if (!forceNew && clash.targetUrl === url) {
            res.status(200).json(buildCreateResponse(clash, baseUrl));
            return;
          }
          throw new HttpError(
            409,
            "alias_taken",
            "`custom_alias` is already in use.",
          );
        }
        code = customAlias;
        isCustom = true;
      } else {
        if (!forceNew) {
          const existing = await store.findByTarget(url);
          if (existing) {
            res.status(200).json(buildCreateResponse(existing, baseUrl));
            return;
          }
        }

        // Step 12: code generation with bounded collision retry.
        let generated: string | null = null;
        for (let attempt = 0; attempt < COLLISION_RETRY_LIMIT; attempt++) {
          const candidate = generateCode();
          if ((await store.findByCode(candidate)) === null) {
            generated = candidate;
            break;
          }
        }
        if (generated === null) {
          logger.error(
            `ALERT code_generation_collision_exhausted attempts=${COLLISION_RETRY_LIMIT}`,
          );
          throw new HttpError(
            500,
            "code_generation_failed",
            "Could not allocate a unique short code.",
          );
        }
        code = generated;
        isCustom = false;
      }

      // Step 13: create.
      const created = await store.createLink({
        code,
        targetUrl: url,
        createdAt: now(),
        expiresAt,
        isCustom,
        createdByIpHash: hashIp(req.socket.remoteAddress ?? "", ipHashSalt),
      });
      res.status(201).json(buildCreateResponse(created, baseUrl));
    }),
  );

  // 3. GET /api/links/:code — metadata + stats.
  app.get(
    "/api/links/:code",
    wrapAsync(async (req, res) => {
      const { code } = req.params;
      const link = await store.findByCode(code);
      if (!link) {
        throw new HttpError(404, "not_found", "No link found for that code.");
      }
      const clicks = await store.getClicks(code);

      const responseBody: LinkStatsResponse = {
        short_code: link.code,
        target_url: link.targetUrl,
        created_at: link.createdAt.toISOString(),
        expires_at: link.expiresAt ? link.expiresAt.toISOString() : null,
        is_custom: link.isCustom,
        total_clicks: clicks.length,
        clicks_by_day: aggregateClicksByDay(clicks.map((c) => c.clickedAt)),
        top_referrers: groupCounts(clicks.map((c) => c.referrer)).map((e) => ({
          referrer: e.key,
          count: e.count,
        })),
        user_agents: groupCounts(clicks.map((c) => c.userAgent)).map((e) => ({
          user_agent: e.key,
          count: e.count,
        })),
      };
      res.status(200).json(responseBody);
    }),
  );

  // 4. GET /:code — redirect + deferred click.
  app.get(
    "/:code",
    wrapAsync(async (req, res) => {
      const { code } = req.params;
      const link = await store.findByCode(code);
      if (!link) {
        throw new HttpError(404, "not_found", "No link found for that code.");
      }
      if (
        link.expiresAt !== null &&
        link.expiresAt.getTime() <= now().getTime()
      ) {
        throw new HttpError(410, "gone", "This link has expired.");
      }

      res.set("Cache-Control", "no-store");
      res.redirect(302, link.targetUrl);

      // Analytics must never add latency to, or fail, the redirect.
      setImmediate(() => {
        void (async () => {
          try {
            await store.recordClick({
              id: randomUUID(),
              code: link.code,
              clickedAt: now(),
              referrer: req.get("referer") ?? null,
              userAgent:
                (req.get("user-agent") ?? "").slice(
                  0,
                  USER_AGENT_MAX_LENGTH,
                ) || null,
              ipHash: hashIp(req.socket.remoteAddress ?? "", ipHashSalt),
            });
          } catch {
            logger.error(`ALERT analytics_write_failed code=${link.code}`);
          }
        })();
      });
    }),
  );

  // 5. Fallback — any unmatched route or method.
  app.use((_req: Request, res: Response) => {
    const errorBody: ErrorResponse = {
      error: "not_found",
      message: "The requested resource was not found.",
    };
    res.status(404).json(errorBody);
  });

  // 6. Terminal error middleware — the single error-translation point.
  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof HttpError) {
        const errorBody: ErrorResponse = {
          error: err.code,
          message: err.message,
        };
        res.status(err.status).json(errorBody);
        return;
      }
      if (isBodyParserSyntaxError(err)) {
        const errorBody: ErrorResponse = {
          error: "malformed_json",
          message: "Request body is not valid JSON.",
        };
        res.status(400).json(errorBody);
        return;
      }
      const errorBody: ErrorResponse = {
        error: "internal_error",
        message: "An unexpected error occurred.",
      };
      res.status(500).json(errorBody);
    },
  );

  return app;
}
