Build a URL shortener service.

Stack

TypeScript (strict: true) on Express 4, run with ts-node — no build step needed for dev or test. Persistence is an in-memory store built on Map, sitting behind a LinkStore interface, so the backing store can later be swapped for something real without touching request handlers. Tests run on Mocha + Chai, with ts-node/register so specs execute directly against the TypeScript source.

API
Method	Path	Behavior
POST	/api/links	Body: {url, custom_alias?, expires_at?}. Returns {short_code, short_url, created_at, expires_at}. 201 on create.
GET	/{code}	302 redirect to the target URL. Records a click.
GET	/api/links/{code}	Link metadata plus stats: click count, daily time series, top referrers, user-agent breakdown.
Short codes are 7-character base62, generated with crypto.randomBytes (not Math.random), with bounded collision retry — max 5 attempts, then 500 with a logged alert. Random rather than sequential, so the link set can't be walked by enumeration.
Custom aliases are validated against a reserved-word list (api, admin, static, docs) and a charset allowlist ([A-Za-z0-9_-]{3,32}).
Creation is idempotent per (url, custom_alias): submitting the same URL twice returns the existing code instead of creating a duplicate, unless force_new: true is passed.
Expired links return 410 Gone, not 404 — an expired link is semantically distinct from one that never existed.
Data model
ts
interface Link {
code: string;            // PK: 7-char base62 or custom alias
targetUrl: string;       // stored as submitted
createdAt: Date;         // UTC
expiresAt: Date | null;
isCustom: boolean;
createdByIpHash: string; // hashed, never raw
}

interface Click {
id: string;
code: string;            // references Link.code
clickedAt: Date;         // UTC
referrer: string | null;
userAgent: string | null; // truncated
ipHash: string;          // salted hash, never raw IP
}
Code lookup on the redirect path is a single Map.get(code) — O(1), no iteration over the link collection.
Client IPs are stored as salted hashes, never in raw form.
Clicks are indexed by code (Map<string, Click[]>), not held in one flat list filtered per stats request — stats reads shouldn't degrade with total click volume across all links.
The idempotency check is served by a secondary index (Map<targetUrl, code>) maintained alongside the primary map and kept consistent with it on every write — not by scanning links.
Reliability
Analytics is decoupled from redirection: if the analytics write fails, the redirect must still succeed. With an in-process store, that means a deferred call (setImmediate or a queue) with its own error boundary — an unhandled rejection there must not take down the process.
Storage sits behind a LinkStore interface, and every method is async (returns a Promise) even though the Map implementation resolves immediately:
ts
interface LinkStore {
createLink(link: Link): Promise<Link>;
findByCode(code: string): Promise<Link | null>;
findByTarget(targetUrl: string): Promise<Link | null>;
recordClick(click: Click): Promise<void>;
getClicks(code: string): Promise<Click[]>;
}
Testing

Unit tests only, with Mocha + ts-node/register and Chai assertions, covering: code generation, collision retry, expiry logic, and idempotency.