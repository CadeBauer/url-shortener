/**
 * src/storage.ts
 *
 * Data shapes and in-memory persistence for the URL shortener.
 *
 * This module has ZERO HTTP concerns: it never imports `express`, never
 * references `req`/`res`, and knows nothing about status codes or headers.
 * All persistence sits behind the `LinkStore` interface so a real store is a
 * drop-in replacement.
 */

export interface Link {
  /** Primary key: 7-char base62 code or a custom alias. */
  code: string;
  /** Target URL, stored exactly as submitted. */
  targetUrl: string;
  /** Creation instant (UTC). */
  createdAt: Date;
  /** Expiry instant (UTC), or `null` to never expire. */
  expiresAt: Date | null;
  /** True iff the link was created from a `custom_alias`. */
  isCustom: boolean;
  /** HMAC-SHA-256 hex digest of the creator IP. Never a raw IP. */
  createdByIpHash: string;
}

export interface Click {
  /** `crypto.randomUUID()` value. */
  id: string;
  /** References `Link.code`. */
  code: string;
  /** Click instant (UTC). */
  clickedAt: Date;
  /** `Referer` header value, or `null` when absent. */
  referrer: string | null;
  /** `User-Agent` header truncated to 256 chars, or `null` when absent/empty. */
  userAgent: string | null;
  /** HMAC-SHA-256 hex digest of the clicker IP. Never a raw IP. */
  ipHash: string;
}

export interface LinkStore {
  createLink(link: Link): Promise<Link>;
  findByCode(code: string): Promise<Link | null>;
  findByTarget(targetUrl: string): Promise<Link | null>;
  recordClick(click: Click): Promise<void>;
  getClicks(code: string): Promise<Click[]>;
}

/**
 * In-memory `LinkStore`.
 *
 * State:
 *  - `links`:       primary `Map<code, Link>`.
 *  - `targetIndex`: secondary `Map<targetUrl, code>` (last-write-wins).
 *  - `clicks`:      `Map<code, Click[]>`.
 *
 * All methods are `async` but resolve synchronously (no timers, no delay).
 */
export class InMemoryLinkStore implements LinkStore {
  private readonly links = new Map<string, Link>();
  private readonly targetIndex = new Map<string, string>();
  private readonly clicks = new Map<string, Click[]>();

  async createLink(link: Link): Promise<Link> {
    // Primary map and secondary index are always written together, so they
    // cannot disagree. The index write is unconditional: last write wins.
    this.links.set(link.code, link);
    this.targetIndex.set(link.targetUrl, link.code);
    if (!this.clicks.has(link.code)) {
      this.clicks.set(link.code, []);
    }
    return link;
  }

  async findByCode(code: string): Promise<Link | null> {
    // Exactly one primary-map probe. No iteration.
    return this.links.get(code) ?? null;
  }

  async findByTarget(targetUrl: string): Promise<Link | null> {
    // Index lookup, then a single primary-map probe. Never scans.
    const code = this.targetIndex.get(targetUrl);
    if (code === undefined) {
      return null;
    }
    return this.links.get(code) ?? null;
  }

  async recordClick(click: Click): Promise<void> {
    let bucket = this.clicks.get(click.code);
    if (bucket === undefined) {
      bucket = [];
      this.clicks.set(click.code, bucket);
    }
    bucket.push(click);
  }

  async getClicks(code: string): Promise<Click[]> {
    // Shallow copy so callers can sort/group without touching stored data.
    const bucket = this.clicks.get(code);
    return bucket ? bucket.slice() : [];
  }
}
