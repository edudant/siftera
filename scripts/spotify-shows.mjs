#!/usr/bin/env node
/* global console, fetch */
/**
 * Dohledá pořady na Spotify pro zdroje označené skupinou `spotify` a uloží jejich ID do konfigurace
 * zdroje (`spotifyShowId`). Skupina je záměr („tenhle podcast na Spotify je"), pole je dohledaný fakt.
 *
 * Spouští se ručně, je idempotentní a už uložené ID nepřepisuje:
 *   SIFTERA_TOKEN=… SIFTERA_API=https://… node scripts/spotify-shows.mjs [--force]
 */
import process from 'node:process';
import { folded, spotifyClient } from './spotify.mjs';

const api = (process.env.SIFTERA_API ?? 'http://127.0.0.1:8788').replace(/\/$/, '');
const token = process.env.SIFTERA_TOKEN ?? '';
const force = process.argv.includes('--force');
const headers = {
  accept: 'application/json',
  'content-type': 'application/json',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

const spotify = await spotifyClient();
if (!spotify) {
  console.error('Bez klíčů ke Spotify není co dohledávat.');
  process.exit(1);
}

const bootstrap = await fetch(`${api}/api/v1/bootstrap`, { headers });
if (!bootstrap.ok) {
  console.error(`Backend na ${api} neodpověděl (${bootstrap.status}).`);
  process.exit(1);
}
const { sources } = await bootstrap.json();
const wanted = sources.filter((source) => (source.groups ?? []).includes('spotify'));
if (!wanted.length) {
  console.log('Žádný zdroj není označený skupinou spotify.');
  process.exit(0);
}

let linked = 0;
for (const source of wanted) {
  if (source.spotifyShowId && !force) {
    console.log(`${source.name.padEnd(18)} už má ${source.spotifyShowId}`);
    continue;
  }
  let show;
  try {
    show = await spotify.findShow(source.name);
  } catch (error) {
    console.error(`${source.name.padEnd(18)} hledání selhalo: ${error instanceof Error ? error.message : 'neznámá chyba'}`);
    continue;
  }
  if (!show) {
    console.log(`${source.name.padEnd(18)} nenalezeno — zůstává na stránce zdroje`);
    continue;
  }
  const response = await fetch(`${api}/api/v1/sources/${source.id}`, {
    method: 'PATCH',
    headers: { ...headers, origin: 'https://edudant.github.io' },
    body: JSON.stringify({ spotifyShowId: show.id }),
  });
  if (!response.ok) {
    console.error(`${source.name.padEnd(18)} zápis selhal (${response.status})`);
    continue;
  }
  linked += 1;
  // Částečná shoda se vypisuje jmenovitě, aby se dala překontrolovat lidským okem.
  const note = show.confidence === 'exact' ? '' : `  ← částečná shoda, zkontroluj: „${show.name}"`;
  console.log(`${source.name.padEnd(18)} → ${show.id}  ${folded(show.name) === folded(source.name) ? '' : show.name}${note}`);
}
console.log(`Hotovo, propojeno ${linked} z ${wanted.length}.`);
