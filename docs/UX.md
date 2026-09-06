# UX a frontend

## Vzhled a navigace

Mobile-first, šířka hlavního sloupce max.680px. Vizuální jazyk je obrazový feed instagramového typu (ADR-014), nikoli seznam odkazů: souvislý scroll, karty bez rámečků oddělené jen mezerou a vlasovou linkou, obraz přes celou šířku sloupce. Sociální mechanika se nepřebírá — žádné komentáře, veřejné lajky, sdílení, profily ani počty. Barevný režim se řídí systémem (`prefers-color-scheme`) v obou směrech; světlá i tmavá varianta musí držet kontrast AA včetně textu nad obrazem. Nadpisy výrazné, tělo16–18px/1.5, system font stack; bez povinného font CDN.

Obraz je nosný prvek karty: poměr16:9, `object-fit: cover`, vždy rezervovaná výška proti CLS. Načítá se přímo z domény zdroje s `loading="lazy"`, `decoding="async"` a `referrerpolicy="no-referrer"`; obrázky se neproxují ani nehostují. Zdroj bez obrázků je normální stav, ne chyba — fallback je typografická karta s barevným podkladem odvozeným deterministicky od zdroje, aby feed nebyl děravý a aby se stejný zdroj držel stejné barvy.

Spodní navigace: **Dnes / Knihovna / Inbox / Uložené / Nastavení**. Horní lišta Dnes: Siftera, datum vydání, search. Horizontální chips Vše, Škola (badge unread), Články, Video, Poslech; ne všechna témata najednou. Další filtry v bottom sheetu. Na desktopu stejná informační struktura s levým úzkým navigation sloupcem.

Dnes zobrazuje poslední publikovaný run v redakčním pořadí. Škola chip vede do knihovny s group=school, kde se zobrazí všechny automaticky publikované zprávy. Badge musí fungovat i bez AI runu. Knihovna má chronologii/relevanci, zdroj/téma/typ/datum/read/saved filtry; saved je také rychlý samostatný vstup. Audience browsing je odstraněn.

Vizuální jazyk platí pro celou aplikaci, ne jen pro Dnes. Knihovna, Uložené i čekající položky v Inboxu používají stejnou kartu; liší se hustotou a doprovodným textem, nikoli tvarem.

## Karty

Všechny renderery dostávají `FeedItem`. Společné prvky: zdroj, datum, headline, uložit, stav přečteno, menu feedback/provenance. Zdroj i datum čitelné, nikoli přes celé obrázky s nízkým kontrastem.

| Presentation | Obsah a hlavní akce |
|---|---|
| article | obraz16:9 přes celou šířku, pod ním akce, nadpis a perex; bez obrázku typografický fallback |
| long_read | větší nadpis, delší perex, odhad času, viditelné „Stojí za přečtení“ |
| distilled_fact | velký krátký text, decentní téma, dole malý dohledatelný zdroj; žádné „klikni pro pointu“ |
| school_notice | datum oznámení, text, případné rozlišené úkol/test/učivo, jasně odlišit tip AI |
| video | poster s poměrem stran, play na klik, titulek a provider; načíst YouTube iframe až po akci |
| audio | čtvercový cover, pořad/epizoda, délka pokud známá, otevřít Spotify/originál |
| budoucí typ | bezpečná textová/link karta s fallback label; necrashovat |

Media a platforma jsou samostatné od prezentace a témat. YouTube external ID validovat, nikdy nevkládat raw iframe HTML z ingestu/AI. Jedno přehrávané video současně, žádný autoplay při scrollování, nevytvářet player pro všechny položky předem.

## Detail, čtení a feedback

Tap kdekoli na kartě otevře celoobrazovkový detail uvnitř aplikace: obraz, headline, redakční shrnutí, perex od zdroje, témata a původ. Detail je vlastní vrstva nad feedem, ne nová stránka — otevření i zavření zachová přesnou pozici feedu a nepřenačítá data. Zavřít lze tlačítkem i gestem zpět; gesto nikdy není jediná cesta.

Vestavěný prohlížeč cizího webu není součástí produktu a nebude se předstírat: zpravodajské weby zakazují vkládání do rámu (ADR-014). Dokud ingest neuloží plný text, detail nabízí odchod na originál jako poslední krok, jasně označený jako opuštění Siftery, s `noopener`/`noreferrer`. Jakmile je k dispozici `access: full`, detail zobrazí uložený plain text bezpečně formátovaný bez zdrojového HTML a odkaz ustoupí do pozadí.

Stav read je samostatný: otevření detailu nebo originálu označí read, pouhé projetí karty scrollováním ne. U distilled_fact a school_notice je viditelná malá akce „Přečteno“, protože není nutné otevírat detail. Lze vrátit na unread. Přečtená karta se během aktivního scrollu jen ztlumí, nezmizí a nepřeskládá okolí; filtr se znovu uplatní při explicitním refresh/navigaci.

Akce na kartě jsou tři a jsou to stavové přepínače vlastního prostoru, ne signály pro ostatní: přečteno, uložit, skrýt. Skryté položky musí jít znovu zobrazit — jednosměrné skrytí bez cesty zpět není přijatelné.

Menu: „Více podobného“, „Jsem rád, že jsem to viděl“, „Méně podobného“, „Dobrý objev“, „Skrýt“, „Proč to vidím / Zdroj“. More/less dovoluje volitelně upřesnit položku/téma/zdroj v druhém kroku, ale výchozí akce bez povinného dialogu target=item. Volný komentář≤500 znaků zůstává soukromou poznámkou pro vlastní AI editor; nikde se nezveřejňuje. Save/read/hide jsou stavové přepínače a nekladou otázku na preference.

Provenance detail: zdrojový titulek, URL, datum, „AI shrnutí“, basis „celý dostupný text / výňatek / pouze metadata“, případně „Plný text nedostupný“. Hodnoticí čísla schovat do detailu; nevytvářet vizuální dojem ověřené pravdy.

## Vydání a historie

Po poslední položce „To je dnešní výběr“ + „Označit vydání jako přečtené“ + „Pokračovat do historie“. Historická vydání se stránkují plynule, každý má datum. Nové vydání během čtení pouze zobrazí banner „Je připraven nový výběr“, nahradí seznam až po tapu. Empty run má lidskou zprávu a odkazy Knihovna/Škola, nikoli nekonečný skeleton.

Relevance sort v Knihovně řadí podle posledního uloženého relevance skóre, není novým LLM voláním. Historický run zachovává originální rank, změny read/save jsou aktuální napříč historií.

## Search

Search otevře full-screen input, keyboard focus a chips filtrů. Index MiniSearch v workeru pro ≥500 dokumentů; češtinu pro matching normalizovat lowercase a diakritiku, originální text neměnit. Search nad headline/summary/topics/source names, prefix matching s omezenou fuzzy tolerancí, explicitně uvést „Posledních90 dní a uložené“ + případné truncated upozornění. Starší historii lze procházet po vydáních, nepředstírat její prohledání.

Po dokončení snapshotu ukládat index/documents do user-scoped IndexedDB. Search nesmí čekat na další AI běh. Při prvním stahování postupový stav, při offline použít poslední index s datem aktualizace.

## Preferences a zdroje

Nastavení: Zdroje / Co chci číst / AI editor / Vzhled. Textové preference nahoře, strukturované ovládání až pod nimi. Žádný wizard o desítkách kroků. Přidání zdroje: vložit URL → discovery návrh → název/skupina a režim curated/all → uložit. Školní preset vyplní group=school a all, lze zobrazit původní URL. U problému viditelný status „načítání selhalo“, „jen perex“, datum posledního úspěchu.

AI editor obrazovka ukazuje credential label/expiry a poslední úspěšný run. Nový token lze zkopírovat jednou, po zavření už ne; revoke/rotate jasně popsat. Config ukázky nesmí se serverem sdílet AI přihlašovací údaje.

## Offline a výkon

- Service worker precache app shell; poslední vydání a jeho editorial metadata v IndexedDB, max.50 karet. Obrázky posledního vydání best-effort cache max.30MiB/60 obrázků, bez záruky cross-origin dostupnosti. Video/audio offline jen metadata a disabled play s vysvětlením.
- App shell network-independent, API nikdy do globálního service-worker cache. User-scoped data partition UID; při logout smazat query cache, IndexedDB partition a privátní image cache, odpojit pending queue. Přepnutí účtu nesmí zobrazit ani na snímek předchozí feed.
- Offline read/save/hide queue max.200 operací, TTL7d. Per candidate sloučit neodeslané změny polí; operationId stabilní při retry. Po připojení ověřit stejný UID, načíst verze a replay FIFO. Konflikt409 nechá serverový stav a ukáže možnost uživateli akci zopakovat; nesmí tiše přepsat novější zařízení. More/good/less/discovery eventy mají jedinečné ID a stejný retry.
- Neprefetchovat celý archiv: další1 stránka při posledních5 položkách, detail next2. Obrázky lazy kromě první viditelné, vždy width/height nebo rezervovaný poměr. Skeleton kopíruje rozměry karet.
- Render dlouhé historie pomocí windowing po100 položkách, stabilní keys podle editorialItemId, zachovat anchor při změně výšky a návratu. Žádné recyklování přehrávajícího iframe na jinou položku.
- Cíle na středním Androidu s throttled4G: LCP≤2.5s, CLS≤0.05, INP≤200ms; optimistická akce<100ms. Initial JS gzip cíl≤250KiB bez lazy editor/video/search. Benchmark run se zdokumentovaným zařízením; nejde o tvrzení měřeného výkonu.
- Touch target≥44×44px, keyboard focus, aria labels, reduced motion, screen-reader oznámení feedbacku a chyb. Žádná akce dostupná jen gestem.
