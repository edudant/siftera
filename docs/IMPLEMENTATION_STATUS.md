# Stav implementace

Aktualizováno 6. 9. 2026. Uživatel změnil prioritu na první online/mobilní prototyp. Původní kompletní MVP není dokončené.

## Funkční prototyp

- Samostatná React PWA: Dnes, Knihovna, Inbox, Uložené, Zdroje, preference a AI editor. Mobilní rozložení, vyhledávání nad načtenými daty, read/save/hide a potvrzené vložení sdíleného odkazu.
- Plugin registry odděluje vstupy od databáze a AI. Ruční URL/text a RSS/Atom, bounded safe HTTP a parser. Celý ručně vložený text je nutné výslovně označit.
- Fetch HTTP API používá existující core: preference, zdroje, ingest, stav a redakční export/import/abort. Identity poskytuje Sites dispatcher; UID není klientský vstup.
- Trvalé D1/R2 adaptéry, owner-scoped záznamy, atomické SQL batches s kontrolou epochy, podmíněné content writes a neměnná redakční historie.
- AI job se exportuje do JSON a výsledek se importuje přes core validaci. scripts/editor-job.mjs může spustit zvolený lokální executable bez shellu. Není to autonomní cron ani ověřená integrace konkrétního AI klienta.
- Hosted build v apps/hosted, migrace D1 a samostatný klient. Stav nasazení je oznámen po dokončení Sites deploymentu; samotný build není důkaz dostupné URL.

## Ověření

Koordinátor nezávisle provedl typecheck, lint, 56 běžných testů a hosted build. Nové testy ověřují RSS/Atom a ruční vstup, HTTP identity/CSRF/izolaci, fulltext redakční průchod a idempotentní import, D1 rollback/stale epoch a R2 hydrataci.

Lokální skutečný Worker runtime s D1/R2 prošel HTTP smoke: anonymní API 401, vložení článku, saved state, fulltext export, publish/import replay, nový bootstrap s publikovanou položkou a prázdný účet druhé identity. Reálné veřejné BBC RSS úspěšně načetlo25 položek. Tyto testovací články jsou pouze v ignorovaném lokálním úložišti, nejsou seed produkce.

Předchozí M2a má13 úspěšných integračních testů Auth/Firestore/Storage emulátorů. Firebase kód se v prototypové etapě neměnil; jeho plný ověřený průchod je zachován. Celkem repozitář obsahuje56 běžných a13 Firebase integračních testů. HTTP smoke je navíc.

WebMCP read-only status tool je feature-detected; nebyl ověřen v podporovaném browser kontextu. Browser E2E/visual QA, instalace na fyzický telefon, offline privátní feed, max-load, cloudové náklady a reálný externí AI run nebyly ověřeny.

## Omezení první verze

- AI import je jeden batch, nejvýše10 vybraných položek. Job expiruje podle core draft TTL. UI a běžný Inbox fungují i bez AI.
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
