# Implementační plán

Milníky dělat v pořadí. Přidělit implementačnímu agentovi vždy ohraničený milník; mění pouze potřebné soubory, nepřepisuje produktová rozhodnutí. Terra je vhodná pro implementaci podle tohoto kontraktu, architektonické odchylky musí vrátit koordinátorovi. Stav a důkazy psát do [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md).

## M1 – runnable foundation a core redakční průchod

Závisí jen na této specifikaci. Vytvořit pnpm monorepo, shared Zod kontrakty a types, core ports a memory storage adapter pro testy. Implementovat default preferences, URL normalizaci/deduplikaci, prefilter, begin/submit/publish/abort a read/save/feedback oddělení. Fake clock a test fixtures dovolují ověřit workflow bez sítě. Přidat Fastify factory s healthz a dependency injection; nejde ještě o veřejný server s autentizací. Vite shell s jasným stavem „vývojový základ“, bez falešného produkčního loginu.

Acceptance:

- `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` projdou na Node24.
- Integration core fixture ingest→candidate→content receipt→proposal→publish→feed, s více než jedním candidate a různými uživateli.
- Druhý publish stejné operace nevytvoří duplicity; cizí UID, stará revision/preference, hidden a nevalidní distilled výstup jsou odmítnuty.
- School all vytvoří systémový item bez LLM, bulk/read/save nemění preference.
- Sdílená schémata přijímají docs examples a odmítají negative fixtures; JSON Schema parity s runtime pro redakční výstup.
- Core neimportuje provider/server SDK. Memory adapter je test/dev-only; produkce s ním nesmí tiše startovat.
- README obsahuje skutečně fungující lokální příkazy; status jasně odlišuje M1 od kompletního MVP.

Tento milník spustit jako první. Bez Firebase projektu, AI loginu, placeného API, scraperů skutečných zdrojů a bez nasazení.

## M2 – perzistence, identity a sběr zdrojů

Ověřené lokální předpoklady a menší úkoly M2a/M2b/M2c jsou v [M2_HANDOFF](M2_HANDOFF.md).

Závisí M1. Firestore repositories + ContentStore GCS/local, Firebase login middleware, tenant isolation, source CRUD/discovery/OPML, safe HTTP, RSS/Atom a school web_page, scheduler tick/CLI, revize a okamžité all doručení. Emulátory a index/rules config.

Acceptance: restart zachová data; reálné emulované Firebase tokeny A/B neprojdou cizím tenantem; deny-all rules; RSS/Atom/HTML fixtures včetně změny stejného příspěvku,304/429/SSRF; source lease bez dvojího ingestu; žádný LLM dependency/call v ingestu. Jeden read-only smoke skutečné veřejné školní stránky a jednoho RSS zdroje, výsledek bez privátních dat. Dodat `.env.example`, žádné reálné secrets.

## M3 – API, MCP a externí editor

Závisí M2. REST kontrakty, hashed agent credentials,6 scopes,revoke/rotation,audit, bounded content chunks a idempotency receipts, remote MCP a stdio proxy. Implementovat renderer-neutral published feed DTO. Runner wrapper s lokálním lockem,timeoutem,exit status a onboarding config/prompt.

Acceptance: celý HTTP+MCP workflow přes SDK client a emulator; read-only token nemůže publish, token nelze použít v user settings, revokace účinná dalším requestem; dvakrát stejný cron run bez duplicit; editor nedostane content patřící B; source/URL provenance je server-owned. Jeden skutečný ruční externí AI run po připravení lokálního klienta uživatele. Tento poslední smoke uvést jako neprovedený, pokud klient/auth nejsou funkční; fixture není jeho náhrada. Neinstalovat cron do systému automaticky.

## M4 – každodenní webový produkt

Závisí M3. Google login v PWA, sources/preferences/token UI, Dnes/Knihovna/Uložené/Nastavení,6 card renderers,detail/provenance,read/save/hide/explicit feedback,škola chip/badge,historie a stabilní scroll.

Acceptance: mobil+desktop browser E2E hlavních cest proti emulatoru; nové vydání neskáče do rozečteného; article/long_read/fact/school/video/audio mají skutečně odlišné renderery; YouTube klik lazy embed a metadata warning; source statuses a empty/error states; logout vyčistí předchozí UI.

## M5 – search, offline a plynulost

Závisí M4. Bounded search snapshot/MiniSearch,index worker,URL filtry,čas/relevance,IndexedDB partition,offline queue conflict handling,service worker,prefetch,windowing a install manifest.

Acceptance: offline reload posledního vydání, save/read feedback replay po reconnect právě jednou, účet B nikdy nevidí A; search české diakritiky,rozsah90d+saved a truncated stav; kombinované filtry,stránka s0 výsledky a cursorem nekončí předčasně; manifest+SW a ikony;30MiB image budget; žádné layout shifts kvůli nezarezervovaným obrázkům.

## M6 – nasazení a pilot

Závisí M5. Dockerfile, Firebase Hosting rewrites,Cloud Run config,min instances0,max instances2,OIDC Scheduler,health/logging,release/security checklist a provozní instrukce. Konečná repo dokumentace má přesné příkazy a aktuální stav, nikoli hypotetické „done“.

Acceptance: všechny required testy zelené,measured performance a accessibility audit,production config reject emulator flags,smoke Google login→zdroj→lokální externí editor→feed na telefonu. Je-li uživatelem určen a autorizován GCP projekt, lze nasadit; před vytvořením placených prostředků musí být konkrétní projekt,region a nákladový rozsah potvrzený. Bez něj odevzdat připravené artefakty a přesný zbývající krok. Pilot3–7 dní validuje kvalitu výběru, nesmí se tvrdit dokončený před uplynutím.

## Pravidla pro předávání

Implementační zadání obsahuje milník,acceptance a povolené adresáře. Výstup: změněné soubory,spuštěné příkazy a výsledky,neprovedená ověření,odchylky. Koordinátor provede review před dalším milníkem. Paralelizovat lze až nezávislé části s hotovými shared contracts; dva agenti nemají současně měnit shared/runtime schema nebo lockfile.
