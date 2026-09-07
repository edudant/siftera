/**
 * Vygeneruje veřejný ukázkový feed pro GitHub Pages z běžícího lokálního backendu (ADR-018).
 * Ven smí jen veřejná článková metadata a krátké redakční výstupy — žádné identity, privátní instrukce
 * ani plná těla článků. Vstup se proto neposílá dál celý, ale skládá se položka po položce.
 *
 *   node scripts/build-demo-feed.mjs [http://127.0.0.1:8788]
 */
import { writeFileSync } from 'node:fs';
import process from 'node:process';

const origin = process.argv[2] ?? 'http://127.0.0.1:8788';
const response = await fetch(`${origin}/api/v1/bootstrap`, { headers: { Accept: 'application/json' } });
if (!response.ok) {
  console.error(`Backend na ${origin} neodpověděl (${response.status}). Spusť pnpm dev:hosted.`);
  process.exit(1);
}
const source = await response.json();

/** Ze zdrojové adresy si ukázka nechá jen původ; dotaz a cesta mohou nést přístupový token. */
function publicOrigin(url) {
  try { return new URL(url).origin; } catch { return ''; }
}
const item = (entry) => ({
  ...entry,
  item: { ...entry.item, whyIncluded: entry.item.whyIncluded ?? '' },
  state: { ...entry.state, seenAt: null },
});
const demo = {
  user: { id: 'public-demo', email: '' },
  preferences: { ...source.preferences, instructions: source.preferences.instructions, behaviorEnabled: false },
  feed: { run: source.feed.run, items: source.feed.items.map(item) },
  library: source.library.map(item),
  stream: source.stream.map(item),
  inbox: [],
  hidden: [],
  // URL zdroje může nést privátní token (soukromý podcast feed), takže ven jde jen doména.
  sources: source.sources.map(({ id, name, url, pluginId, groups, deliveryMode, imageMode }) =>
    ({ id, name, url: publicOrigin(url), pluginId, groups, deliveryMode, imageMode, enabled: true, createdAt: new Date(0).toISOString(), lastFetchedAt: null, lastError: null })),
  plugins: source.plugins,
};

const serialized = JSON.stringify(demo);
for (const [label, pattern] of [
  ['identita', /dev-local-user/],
  ['e-mail', /"email":"[^"]+"/],
  ['odkaz na uložený obsah', /"contentRef":"[^"]/],
  ['přístupový token v adrese', /[?&](token|key|auth|secret)=/i],
  ['podpis JWT', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
]) {
  if (pattern.test(serialized)) {
    console.error(`Ukázka by obsahovala ${label}; generování zastaveno.`);
    process.exit(1);
  }
}
writeFileSync('apps/web/public/demo-feed.json', serialized);
console.log(`apps/web/public/demo-feed.json — ${demo.stream.length} ve výběru, ${demo.library.length} v knihovně, ${demo.sources.length} zdrojů, ${Math.round(serialized.length / 1024)} kB`);
