/**
 * src/main.ts
 *
 * Composition root. The only place concrete wiring and process concerns live:
 * read environment, construct the in-memory store, build the app, listen.
 * Exports nothing; runs on import.
 */

import { randomBytes } from "node:crypto";
import { InMemoryLinkStore } from "./storage";
import { createApp } from "./api";

const port = Number(process.env.PORT) || 3000;
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`;
const ipHashSalt =
  process.env.IP_HASH_SALT ?? randomBytes(32).toString("hex");

if (!process.env.IP_HASH_SALT) {
  // Never log the salt value itself (NFR-4).
  console.log(
    "url-shortener: IP_HASH_SALT not set; using a random per-process salt",
  );
}

const store = new InMemoryLinkStore();
const app = createApp(store, { baseUrl, ipHashSalt });

app.listen(port, () => {
  console.log(`url-shortener listening on port ${port} (baseUrl ${baseUrl})`);
});
