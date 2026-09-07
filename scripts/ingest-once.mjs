#!/usr/bin/env node
/* global console, process, fetch, setTimeout */
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
// SIFTERA_ONLY zúží běh na zdroje, jejichž jméno obsahuje daný text — pro cílené doplnění jednoho feedu.
const only = (process.env.SIFTERA_ONLY ?? "").toLocaleLowerCase();
const active = sources.filter((source) => source.enabled && source.pluginId === "rss"
  && (!only || source.name.toLocaleLowerCase().includes(only)));
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

/** Kolik položek se posílá v jednom requestu. Velká dávka narazí na CPU limit Workeru (chyba 1102). */
const BATCH = Number(process.env.SIFTERA_BATCH ?? 5);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Vyčerpání zdrojů Workeru je přechodné, takže se dávka zkusí znovu s odstupem. */
async function sendBatch(payload, attempt = 1) {
  const response = await authorized("/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.ok) return response.json();
  if ((response.status === 503 || response.status === 429) && attempt <= 4) {
    await sleep(attempt * 750);
    return sendBatch(payload, attempt + 1);
  }
  throw new Error(`zápis selhal (${response.status})`);
}

let total = 0;
for (const source of active) {
  try {
    const collected = await registry.collect("rss", { sourceId: source.id, sourceName: source.name, groups: source.groups, deliveryMode: source.deliveryMode, url: source.url, maxItems: 25 });
    const items = collected.inputs.map(({ url, title, excerpt, body, publishedAt, categories, image, externalId }) =>
      ({ url, title, excerpt, body, publishedAt, categories, image, externalId }));
    if (!items.length) { console.log(`${source.name}: nic nového`); continue; }
    let received = 0;
    let created = 0;
    let revised = 0;
    for (let index = 0; index < items.length; index += BATCH) {
      const result = await sendBatch({
        sourceId: source.id, sourceName: source.name, groups: source.groups, deliveryMode: source.deliveryMode,
        items: items.slice(index, index + BATCH),
      });
      received += result.received;
      created += result.created;
      revised += result.revised;
    }
    total += created;
    console.log(`${source.name}: přijato ${received}, nových ${created}, aktualizovaných ${revised}${collected.complete === false ? " (zdroj byl delší než limit)" : ""}`);
  } catch (error) {
    console.error(`${source.name}: ${error instanceof Error ? error.message : "selhalo"}`);
  }
}
console.log(`Hotovo, nových položek celkem: ${total}`);
