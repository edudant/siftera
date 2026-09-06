#!/usr/bin/env node
/* global console, process, fetch */
/**
 * Lokální ingest (ADR-018): stáhne RSS zdroje, znormalizuje položky a pošle je Workeru jako dávku.
 * Stahování ani AI nikdy neběží na edge — Worker jen validuje, dedupuje a zapisuje.
 *
 *   SIFTERA_API=https://… SIFTERA_TOKEN=… node scripts/ingest-once.mjs
 */
import { createDefaultConnectorRegistry, SafeHttpClient } from "../packages/connectors/dist/index.js";

const api = (process.env.SIFTERA_API ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.SIFTERA_TOKEN ?? "";
if (!token) {
  console.error("Chybí SIFTERA_TOKEN; bez něj Worker zápis odmítne.");
  process.exit(1);
}
const authorized = (path, init) => fetch(`${api}/api/v1${path}`, {
  ...init,
  headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}`, accept: "application/json" },
});

const bootstrap = await authorized("/bootstrap");
if (!bootstrap.ok) {
  console.error(`Bootstrap selhal (${bootstrap.status}). Zkontroluj adresu a token.`);
  process.exit(1);
}
const { sources } = await bootstrap.json();
const active = sources.filter((source) => source.enabled && source.pluginId === "rss");
if (!active.length) {
  console.log("Žádný aktivní RSS zdroj.");
  process.exit(0);
}

const { lookup } = await import("node:dns/promises");
const http = new SafeHttpClient({
  fetch: (input, init) => fetch(input, init),
  resolveHost: async (hostname) => (await lookup(hostname, { all: true })).map(({ address, family }) => ({ address, family })),
  maxBodyBytes: 4 * 1024 * 1024,
  timeoutMs: 20_000,
});
const registry = createDefaultConnectorRegistry({ http });

let total = 0;
for (const source of active) {
  try {
    const collected = await registry.collect("rss", { sourceId: source.id, sourceName: source.name, groups: source.groups, deliveryMode: source.deliveryMode, url: source.url, maxItems: 25 });
    const items = collected.inputs.map(({ url, title, excerpt, body, publishedAt, categories, image, externalId }) =>
      ({ url, title, excerpt, body, publishedAt, categories, image, externalId }));
    if (!items.length) { console.log(`${source.name}: nic nového`); continue; }
    const response = await authorized("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: source.id, sourceName: source.name, groups: source.groups, deliveryMode: source.deliveryMode, items }),
    });
    if (!response.ok) { console.error(`${source.name}: zápis selhal (${response.status})`); continue; }
    const result = await response.json();
    total += result.created;
    console.log(`${source.name}: přijato ${result.received}, nových ${result.created}, aktualizovaných ${result.revised}${collected.complete === false ? " (zdroj byl delší než limit)" : ""}`);
  } catch (error) {
    console.error(`${source.name}: ${error instanceof Error ? error.message : "selhalo"}`);
  }
}
console.log(`Hotovo, nových položek celkem: ${total}`);
