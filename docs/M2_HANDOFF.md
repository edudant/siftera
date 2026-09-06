# Příprava M2: perzistence, identity a skutečné zdroje

Navazuje na dokončení M1. Aktuální výsledky implementace a testů jsou v [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md); následující runtime smoke byl pouze přípravou.

## Ověřené místní prostředí

6. 9. 2026 proběhl samostatný smoke mimo produktový kód: Firebase CLI 15.18.0, Node 24.12.0, Java 25.0.2. Auth, Firestore Standard a Storage emulátory se spustily pod `demo-siftera`; vznikl syntetický testovací účet a oba datové emulátory odmítly neautorizovaný přístup pomocí deny-all rules. Proces skončil s kódem 0 a emulátory se vypnuly. Neproběhla integrace s aplikačními repository ani produkčním projektem.

Pro tento vývoj není třeba vytvářet skutečný Firebase projekt. Demo projekty podporují provoz pouze proti emulátorům. Viz [Firebase: demo projects](https://firebase.google.com/docs/emulator-suite/connect_auth#choose_a_firebase_project).

M2 má použít jeden konzistentní project ID, např. `demo-siftera`, a localhost porty z OPERATIONS. Přesné verze lokálních dev dependencies uzamknout v repozitáři, nespoléhat na globální CLI. Firestore dokumentace doporučuje Java 21 nebo novější; zde je dostupná Java 25. Viz [Firestore emulator](https://firebase.google.com/docs/emulator-suite/connect_firestore).

## Doporučené ohraničení implementačních úkolů

1. **M2a – perzistence a identity.** Firestore adaptér doménových repository operací, GCS/local ContentStore, Firebase identity verifier, deny-all rules/indexes, emulator konfigurace a integration test harness. Žádné veřejné datové routes bez ověřené identity. Testy pro nové klienty nad stejnou databází, dva uživatele, souběžný publish, rollback a opakování operací spustit proti skutečným emulátorům.
2. **M2b – adaptéry zdrojů.** Safe HTTP transport s DNS/IP/redirect ochranami a omezením velikosti, RSS/Atom, HTML školní seznam/detail a deterministická extrakce. Použít syntetické fixtures; nespouštět LLM. Dodat source discovery a OPML dry-run/import/export podle API. Veřejný read-only smoke školní stránky a jednoho RSS provést až po testech transportu.
3. **M2c – propojení a scheduling.** Uživatelský bootstrap, ověřování identity v HTTP middleware, Source CRUD, per-source lease, due scan, retry/backoff/304, ingest CLI a runtime konfigurace. Propojit zdroje se stávajícím core, ověřit nové školní oznámení bez agenta a zachování dat po restartu. Doplnit skutečně fungující lokální příkazy do README.

M2a/b/c jsou menší implementační úkoly uvnitř původního M2, nemění produktový rozsah. Neuzavírat celé M2 po dokončení pouze jednoho z nich.

## Zvláštní pozornost při implementaci adaptéru

- Repository transakce musí dát core možnost číst vlastní čekající zápisy. Firestore write operace odeslat až po dokončení callbacku; neporušit požadované pořadí čtení a zápisů.
- `getRun` vrací omezený redakční agregát. Ve Firestore zachovat samostatné draftItems/contentReads a limity velikosti podle DATA_MODEL, neukládat neomezenou historii do jednoho dokumentu.
- Candidate/query limits jsou limity výsledků; nezískávat kvůli nim celý účet. Předvýběr, rejection lookup a skóre řídkých zdrojů potřebují promyšlené bounded queries. Ověřit množství čtených dat při max. 3000 kandidátech.
- Fulltext patří do ContentStore, ne do dokumentů Firestore. Vyřešit idempotentní blob zápis, retry transakce a orphan cleanup bez změny historického snapshotu.
- Runtime explicitně rozlišuje development/test a production. `FIREBASE_AUTH_EMULATOR_HOST` umožňuje Admin SDK přijímat nepodepsané testovací tokeny a nesmí být povolen v produkci. Viz [Firebase Admin SDK a emulátor](https://firebase.google.com/docs/emulator-suite/connect_auth#admin_sdks).
- Testy identity používají skutečné tokeny emulátoru; ručně vytvořený `Principal` ověřuje pouze core. Úspěch runtime smoke výše nesmí nahrazovat integrační test aplikace.

Pro M2 nejsou zapotřebí uživatelské přístupové tokeny ani AI login. Výběr skutečného cloudového projektu a nasazení patří do M6, skutečný externí AI smoke do M3.
