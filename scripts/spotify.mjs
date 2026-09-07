/* global Buffer, console, fetch, setTimeout, URLSearchParams */
/**
 * Přístup ke Spotify Web API pro lokální ingest (ADR-023). Klíče zůstávají na tomto stroji: Worker je
 * nedostane, protože epizody se dohledávají při sběru, ne za běhu API.
 *
 * Soubor .siftera-spotify má řádky `ClientID: …` a `ClientSecret: …` (přijímá se i `KEY=value`).
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';

const CREDENTIALS = '.siftera-spotify';

/** Diakritika, interpunkce ani velikost písmen nesmí rozhodovat o tom, jestli je to tatáž epizoda. */
export function folded(value) {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function credential(raw, ...names) {
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_]+)\s*[:=]\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase().replace(/_/g, '');
    if (names.includes(key)) return match[2];
  }
  return null;
}

/** Vrátí klienta, nebo null, když klíče nejsou — ingest má běžet i bez Spotify. */
export async function spotifyClient() {
  let raw;
  try {
    raw = readFileSync(CREDENTIALS, 'utf8');
  } catch {
    return null;
  }
  const id = credential(raw, 'clientid', 'spotifyclientid');
  const secret = credential(raw, 'clientsecret', 'spotifyclientsecret');
  if (!id || !secret) {
    console.error(`${CREDENTIALS}: chybí ClientID nebo ClientSecret.`);
    return null;
  }
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  if (!response.ok) {
    console.error(`Spotify token selhal (${response.status}). Zkontroluj klíče v ${CREDENTIALS}.`);
    return null;
  }
  const { access_token: token } = await response.json();
  const market = process.env.SPOTIFY_MARKET ?? 'CZ';

  const call = async (path, params) => {
    const url = `https://api.spotify.com/v1/${path}?${new URLSearchParams({ market, ...params })}`;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (result.ok) return result.json();
      // 429 nese Retry-After v sekundách; jiná chyba se opakovat nemá.
      if (result.status !== 429) throw new Error(`Spotify ${path} → ${result.status}`);
      const wait = Number.parseInt(result.headers.get('retry-after') ?? '2', 10);
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 30) * 1000 * attempt));
    }
    throw new Error(`Spotify ${path}: vyčerpané pokusy po 429`);
  };

  return {
    /** Najde pořad podle jména; vrací jen jistou shodu, aby zdroj neskončil u cizího podcastu. */
    async findShow(name) {
      const found = await call('search', { q: name, type: 'show', limit: '10' });
      const wanted = folded(name);
      const items = found.shows?.items?.filter(Boolean) ?? [];
      const exact = items.find((show) => folded(show.name) === wanted);
      if (exact) return { id: exact.id, name: exact.name, confidence: 'exact' };
      const contains = items.find((show) => folded(show.name).includes(wanted) || wanted.includes(folded(show.name)));
      return contains ? { id: contains.id, name: contains.name, confidence: 'partial' } : null;
    },
    /** Epizody pořadu od nejnovější; víc než dvě stránky nemá smysl, ingest bere čerstvé položky. */
    async showEpisodes(showId, pages = 2) {
      const episodes = [];
      for (let page = 0; page < pages; page += 1) {
        const chunk = await call(`shows/${showId}/episodes`, { limit: '50', offset: String(page * 50) });
        const items = (chunk.items ?? []).filter(Boolean);
        episodes.push(...items);
        if (items.length < 50) break;
      }
      return episodes;
    },
  };
}

/**
 * Přiřadí epizodu k položce feedu podle názvu. Přesná shoda má přednost; jinak se přijme jen zanoření
 * jednoho názvu do druhého (feedy si k názvu přidávají čísla dílů nebo předřazují jméno pořadu).
 */
export function matchEpisode(episodes, title) {
  const wanted = folded(title);
  if (!wanted) return null;
  const exact = episodes.find((episode) => folded(episode.name) === wanted);
  if (exact) return exact;
  return episodes.find((episode) => {
    const name = folded(episode.name);
    return name.length > 12 && wanted.length > 12 && (name.includes(wanted) || wanted.includes(name));
  }) ?? null;
}
