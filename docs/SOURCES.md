# Zdroje a source adapter contract

## SourceAdapter

Core port návrh:

```ts
interface SourceAdapter {
  kind: 'rss' | 'web_page';
  fetch(input: { source: Source; cursor: string | null; now: string },
        deps: { http: SafeHttpClient }): Promise<{
    status: 'ok' | 'not_modified'; items: NormalizedSourceItem[];
    nextCursor: string | null; etag: string | null;
    lastModified: string | null; warnings: string[];
  }>;
}
// NormalizedSourceItem má title,url,canonicalUrl?,externalId?,author?,
// publishedAt?,excerpt,feedText?,medium,image?,media?,categories.
// Výsledný Candidate ID/revision/UID určuje core, nikoli adapter.
```

Parser/extractor nemá přístup k LLM ani uživatelským credentials. HTTP je injectable pro fixtures a produkční SSRF policy. RSS adapter použije zavedený parser s bezpečným XML nastavením, ne vlastní XML regex parser. Atom relative links a xml:base správně řešit.

## Obsah a extrakce

RSS může dodat full content nebo jen description; nastavení/status nesmí zaměnit krátký description za přečtený celý článek. Article text získat Readability nad parserem DOM, běžnou HTML sanitizací a omezením velikosti. Fallback na source-specific CSS contentSelector pro registrovaný web. Čistý text a title/excerpt se ukládají odděleně od rich originálu; v MVP netřeba uchovávat původní HTML.

Výchozí hybrid: ingest metadata a případný feedText; fulltext běžného článku fetch/extract on-demand při content tool call, cache uložit. HTML školní detail ingest fetchuje hned, aby bylo oznámení dostupné bez AI. Zjištění změněného fulltextu vytvoří novou revision; agent pak musí začít s aktuálním snapshotem.

CSS selectors jsou uživatelská konfigurace, nikoli executable JS. Omezit délku≤200 a max.počet matched items100/tick. Není podporováno přihlášení,interaktivní browser,nekonečné AJAX listy ani libovolné paginace. Přesun site layoutu vrací SOURCE_LAYOUT_CHANGED, ne empty success a automatické smazání historie.

## První school adapter

Výchozí stránka: [V. třída ZŠ Postřekov](https://www.zsms-postrekov.cz/zakladni-skola/aktuality-trid/v-trida/). Při rešerši obsahovala datované příspěvky4.9.,3.9. a zahájení roku s odkazy na detaily. Jeden zdrojový příspěvek = jeden Candidate; AI může rozdělit jeho obsah do více schoolDetails.

HTML ověřeno6.9.2026: itemSelector=`a.event-link`, linkSelector=`:scope` (href samotné položky), titleSelector=`.event-name`, dateSelector=`.event-info-value.event-date`, dateFormat=`cs_date`, contentSelector=`.event-detail-content .lead, .event-detail-content .event-text`. Více shod contentSelector spojit v document order a deduplikovat vnořené matches. Zachovat lead i event-text; samotný lead vynechá podstatné informace. V M2 dodat syntetickou fixture stejné struktury a ověřit případné změny layoutu. Stabilní ID: canonical detail URL, nikoli titulek/data pozice. Page group=school,deliveryMode=all,poll30min. Index i detail mají vlastní obsahové hashování, změna navigace nevyvolá nové oznámení. Bez data uložit publishedAt=null a použít discoveredAt, nevymýšlet deadline.

Systémový school item bez AI: presentation school_notice,summary původní očištěné sdělení (max800chars, zbytek v detailu),schoolDetails=[],producer=system,whyIncluded='Nové oznámení ze sledovaného školního zdroje',basis podle skutečně dostupného textu. Aktualizace systémového item je nová immutable verze, UI označí „Aktualizováno“.

## Zamýšlené uživatelské zdroje

| Zdroj | MVP cesta | Co není automaticky slíbeno |
|---|---|---|
| Hospodářské noviny | uživatelem dodaná/discovered RSS URL,veřejný titulek/perex a dostupné články | přístup backendu k předplatnému uživatele |
| BBC/CNN | ověřený veřejný RSS/Atom URL; použít metadata a legálně dostupný fulltext | konkrétní stále funkční feed bez ověření při registraci |
| Medium | RSS konkrétních autorů/publikací nebo veřejný web | personalizovaný home feed,reading list a placené texty účtu |
| Technické blogy | RSS/Atom a URL discovery | univerzální parsování každého JS webu |
| Reddit | veřejný RSS pokud funguje a respektuje limity,volitelně RSSHub | přihlášené subreddit subscriptions/private communities/API |
| Podcast/Spotify | podcast RSS metadata,odkaz na epizodu a případně Spotify link | import knihovny Spotify,exkluzivní audio,přepis celého pořadu |
| YouTube | veřejný channel RSS,poster/description a click-to-play embed | automatické pochopení videa bez přepisu |
| Wikipedia/knihy/film | kontrakt umožňuje budoucí kartu | skutečný recommendation connector v MVP |

Tabulka definuje integrační hranice, nikoli potvrzení dostupnosti každého endpointu. Testovat živou dostupnost při registraci. Zdrojový credential URL s userinfo/token query není podporovaný v MVP; privátní subscription feeds až s odděleným secret storage a explicitní implementací.

## Discovery a OPML

U vložené URL fetch HTML přes SafeHttpClient a nabídnout `link rel=alternate` RSS/Atom; při více variantách zobrazit volbu. Pokud URL přímo vrací RSS, navrhnout ji. Pokud nic, nabídnout web_page konfiguraci/preset, ne automaticky spustit LLM scraper.

OPML import: validovat XML bez DTD/externích entit,max256KiB,flat i nested outlines,duplicate normalizedURL skip. Nejprve dry-run návrh s počtem; import commit vytvoří jen validní sources a vrátí invalid s důvodem. Folder se mapuje na source group slug. Export obsahuje registrované RSS URL/názvy/skupiny a žádná credential metadata. Generic web_page zdroje export nepředstírá jako RSS; UI uvede jejich počet mimo export.
