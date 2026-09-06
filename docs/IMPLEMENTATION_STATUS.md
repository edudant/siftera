# Stav implementace

Aktualizováno 6. 9. 2026. Uživatel změnil prioritu na první online/mobilní prototyp. Původní kompletní MVP není dokončené.

## Funkční prototyp

- Produkční tvar Workeru podle ADR-019, ověřený proti lokálnímu Worker runtimu. Dávkové čtení srazilo bootstrap z 661 D1 dotazů na 38 (konstantně, nezávisle na objemu dat) a odezvu z ~300 ms na ~38 ms. Identita jde z `Authorization: Bearer` proti serverovému tajemství — podvržená hlavička `oai-authenticated-user-id` vrací 401. CORS a preflight fungují pro povolený origin a mlčí pro cizí. Worker RSS nestahuje: `pnpm ingest:once` posbíral šest českých zdrojů lokálně a přes `POST /ingest` zapsal 44 nových položek. Vlastní nasazení na Cloudflare zatím neproběhlo — `wrangler login` je interaktivní.

- Veřejná ukázka pro GitHub Pages podle ADR-018: statický adaptér `apps/web/src/demo.ts` čte sanitizovaný snapshot a všechny změny drží v `localStorage`; akce vyžadující backend (sběr z RSS, redakční export/import, správa zdrojů) hlásí, že bez něj nefungují. `pnpm build:pages` staví do `dist/pages` s `BASE_PATH` pro podcestu repozitáře, `pnpm demo:feed` ukázková data obnoví a odmítne je zapsat, pokud by obsahovala identitu, e-mail nebo odkaz na uložený obsah. Nasazeno na <https://edudant.github.io/siftera/> z veřejného repozitáře `edudant/siftera` workflow `.github/workflows/pages.yml`. Ověřeno na živé adrese: 30 položek, šest zdrojů, načtené obrázky, funkční ukládání do prohlížeče i poctivá hláška u akcí, které vyžadují backend.

- AI editor v2 (ADR-017): dvoustupňový přehled → volitelný AI shortlist → serverové doplnění nejvýše20 originálů → redakce a import až50 položek v dávkách po10. Job obsahuje ageDays, čtenářské stavy, historii a známá témata. PublicArticleReader odstraňuje skrytý obsah; detekovaný paywall poskytuje jen veřejný popis. Plný text je svázaný s candidate revision a read receipt; neúspěšný originál neblokuje RSS podklad. Editor určuje presentation/emphasis/imageTreatment; UI respektuje zdroj a rozlišení obrazu. Model zůstává externí, cron a placené API se nezavádějí.


- Vizuální feed podle ADR-014: bezpatková typografie, kruhový avatar zdroje z favicony s monogramem jako fallback, relativní čas, Dnes bez hlavičky vydání a rozbalení položky přímo ve feedu. Karty ve čtyřech důrazech (lead/standard/compact/text) podle `emphasis` od AI editora, s `imageMode` na zdroj; obraz pod 480px překlopí kartu do kompaktního řádku. RSS konektor čte obrázky z `enclosure` a `media:*`, ingest je propouští do kandidáta i vydání. Barevný režim podle systému. Klik otevírá originál ve stejné kartě a návrat obnoví pozici ve feedu; vlastní detail se neukazuje, protože bez plného textu nic nepřidával.
- Jeden feed podle ADR-016: taby Výběr / Vše / Uložené a ikona filtrů v hlavičce, která uhýbá při rolování; spodní lišta zrušena, hledání je lupa. Postupné dočítání po 15 položkách, poslední bootstrap v `sessionStorage` pro okamžitý návrat z originálu včetně pohledu a hloubky scrollu. Jméno zdroje se řeší z aktuální konfigurace a zkracuje na jeden řádek. Řazení a kategorie v panelu, vkládání pod „+“. Kategorie jsou uživatelské filtry nad tématy a zdroji uložené v preferencích; Inbox jako samostatná obrazovka zanikl. Horní lišta uhýbá při rolování dolů.
- Proud nepřečteného podle ADR-015: Dnes čte publikované položky napříč vydáními (nepřečtené, neskryté, do14 dní), řazené relevancí s útlumem stáří; Knihovna je archiv. Klient hlásí dávkově, co měl uživatel aspoň z poloviny na obrazovce déle než vteřinu (`POST /items/seen`, stav `seenAt`); viděné klesá v pořadí, nemizí. Se zapnutým `behaviorEnabled` job navíc nese `recentlyIgnored`.
- Samostatná React PWA: Dnes, Knihovna, Inbox, Uložené, Zdroje, preference a AI editor. Mobilní rozložení, vyhledávání nad načtenými daty, read/save/hide a potvrzené vložení sdíleného odkazu. Inbox vedle ručního příjmu vypisuje i čekající kandidáty ze zdrojů; prázdné stavy Dnes a Knihovny podle stavu dat navigují na přidání zdroje, obnovení nebo AI editor.
- Plugin registry odděluje vstupy od databáze a AI. Ruční URL/text a RSS/Atom, bounded safe HTTP a parser. Celý ručně vložený text je nutné výslovně označit.
- Fetch HTTP API používá existující core: preference, zdroje, ingest, stav a redakční export/import/abort. Identity poskytuje Sites dispatcher; UID není klientský vstup.
- Trvalé D1/R2 adaptéry, owner-scoped záznamy, atomické SQL batches s kontrolou epochy, podmíněné content writes a neměnná redakční historie.
- AI job se exportuje do JSON a výsledek se importuje přes core validaci. scripts/editor-job.mjs může spustit zvolený lokální executable bez shellu. Není to autonomní cron ani ověřená integrace konkrétního AI klienta.
- Hosted build v apps/hosted, migrace D1 a samostatný klient. Stav nasazení je oznámen po dokončení Sites deploymentu; samotný build není důkaz dostupné URL.

## Ověření

Koordinátor nezávisle provedl typecheck, lint, 56 běžných testů a hosted build. Nové testy ověřují RSS/Atom a ruční vstup, HTTP identity/CSRF/izolaci, fulltext redakční průchod a idempotentní import, D1 rollback/stale epoch a R2 hydrataci.

První ruční ingest tří veřejných českých RSS zdrojů (ČT24, iROZHLAS, Root.cz) proběhl proti lokálnímu Worker runtimu: 55 kandidátů, opakovaný refresh správně dedupuje, redakční export vrátil 50 kandidátů bez plného textu. Na těchto datech proběhl i celý redakční cyklus: dvě vydání po 10 položkách sestavená externím AI klientem (Claude Code), validovaná proti `docs/contracts/editorial-result.schema.json` a přijatá serverovou validací. Všechny položky jsou `article` s `basis: excerpt` a odkazem na originál; `long_read` ani `distilled_fact` nešly použít, protože RSS nedodalo plný text ani read receipt. Core správně odmítl publikovat skryté položky (`ITEM_NOT_ELIGIBLE`) a už publikované kandidáty vyřadil z dalšího výběru. V UI ověřeno vydání, knihovna, uložení, označení přečteného a vyhledávání napříč vydáními.

Po redesignu proběhl ingest z pěti českých zdrojů (ČT24, iROZHLAS, Root.cz, Novinky, Seznam Zprávy, Aktuálně.cz) a páté vydání se všemi čtyřmi důrazy karet. Obrázky se liší podle zdroje: Aktuálně.cz posílá 870×580, iROZHLAS 160×107, Novinky a Seznam Zprávy žádné — všechny tři případy feed zvládá. Ověřeno v prohlížeči ve světlém i tmavém režimu včetně návratu na pozici po odchodu na originál. Core při publikaci správně odmítl skryté položky (`ITEM_NOT_ELIGIBLE`), překročenou kvótu na zdroj (`SOURCE_QUOTA`) i změněný obsah pod stejným `batchId` (`IDEMPOTENCY_CONFLICT`). HeroHero nelze přidat: nemá veřejný RSS ani feed autodiscovery. Na těchto datech se doladilo UI a opravilo, že useknutí zdroje na 25 položek se ukládalo do `lastError` a zobrazovalo jako chyba zdroje; nese ho jen `complete:false`. Data zůstala v ignorovaném lokálním úložišti. Browser QA proběhlo v mobilním i desktopovém rozložení, ne na fyzickém telefonu.

Lokální skutečný Worker runtime s D1/R2 prošel HTTP smoke: anonymní API 401, vložení článku, saved state, fulltext export, publish/import replay, nový bootstrap s publikovanou položkou a prázdný účet druhé identity. Reálné veřejné BBC RSS úspěšně načetlo25 položek. Tyto testovací články jsou pouze v ignorovaném lokálním úložišti, nejsou seed produkce.

Předchozí M2a má13 úspěšných integračních testů Auth/Firestore/Storage emulátorů. Firebase kód se v prototypové etapě neměnil; jeho plný ověřený průchod je zachován. Celkem repozitář obsahuje56 běžných a13 Firebase integračních testů. HTTP smoke je navíc.

WebMCP read-only status tool je feature-detected; nebyl ověřen v podporovaném browser kontextu. Browser E2E/visual QA, instalace na fyzický telefon, offline privátní feed, max-load, cloudové náklady a reálný externí AI run nebyly ověřeny.

## Omezení první verze

- AI import podporuje až50 vybraných položek v dávkách po10. Job expiruje za60 minut. Extrakce originálu je heuristická, u některých webů zůstane jen popis nebo RSS výňatek.
- RSS refresh je ruční a zpracuje nejvýše25 prvních položek; starší položky nemají implementovaný continuation cursor. Není hotový plánovač/lease ani source discovery/OPML/školní HTML parser.
- RSS text je partial; shrnutí z něj nesmí předstírat přečtený celý článek. Paywally se neobcházejí.
- PWA ukládá app shell, nikoli poslední soukromé vydání ani offline frontu mutací. Share target závisí na prohlížeči. Přidání na plochu je třeba ověřit na uživatelově telefonu.
- Sites přihlášení je pro tuto verzi přes ChatGPT; Google login/Firebase produktový bootstrap z původního plánu není zapojený.
- Hosted identitě lze důvěřovat jen za Sites dispatcherem. Samotný Worker s klientem volně volitelnými identitními hlavičkami nesmí být veřejně vystaven.
- Retenční cleanup, komplexní zdrojové konektory, automatický AI běh, plný MCP, pilot a produkční zátěž zbývají. D1 DraftData je omezený na800kB.

## Původní milníky

| Milník | Stav |
|---|---|
| Specifikace v1 | hotová; prototypová změna ADR-013 |
| M1 Core | hotovo, původních41 testů |
| M2 Persistence/ingest | Firestore M2a hotovo, část konektorů hotova, zbývá integrace plánovače a dalších zdrojů |
| M3 API/MCP/editor | kompaktní prototype API a export/import hotové; plný MCP/cron zbývá |
| M4 UI | první mobilní web hotový; kompletní MVP acceptance zbývá |
| M5 Offline/search | shell a lokální search; plný rozsah zbývá |
| M6 Deployment/pilot | Sites deploy se ověřuje samostatně; pilot neproběhl |

## Prostředí

Node24.12, pnpm11.19, Java25. Firebase CLI15.18 je zamčené v projektu. Root implementaci koordinoval; konektory, API a UI implementovala Terra.

Dříve ověřené globální Codex CLI selhávalo na chybějícím executable. Desktop podagenti fungují. Osobní auth soubory nebyly čtené, cron není instalovaný. Existující Firebase projekty byly pouze vypsané; žádný z nich se nepoužil ani neupravoval.
