# Lokální provoz, cron a deployment

## Vývoj

Node24 LTS, pnpm (repo pin z prvního lockfile), Java kompatibilní s Firebase emulátory. Lokální porty: web5173, API3001, Auth9099, Firestore8080, Storage9199, emulator UI4000. Demo project ID `demo-siftera`. Servery bind127.0.0.1, emulator data v ignored `.local/`. Unit testy s fake adapters nepotřebují Java ani síť.

Předpokládané příkazy po dokončení příslušných milníků: `pnpm dev` web/API; `pnpm emulators` Firebase; `pnpm ingest:once` jednorázový due scan; `pnpm editor:run` wrapper externího klienta; `pnpm mcp:stdio` proxy. M1 implementuje jen příkazy, které skutečně fungují, zbytek označí jako budoucí.

Konfigurace: NODE_ENV,PORT,WEB_ORIGIN,FIREBASE_PROJECT_ID,FIREBASE_STORAGE_BUCKET; emulator hosts jen development/test. Cursor HMAC secret z env/Secret Manager. Local ContentStore root mimo web public dir. Přímá produkční autentizace přes ADC; žádné uložené service-account klíče ve zdrojích.

## Lokální editor (M3)

Runner je jednorázový proces; nesmí hostovat scheduler uvnitř webového serveru. Interface wrapperu: vstup provider command argv + prompt file + API URL/token env, výstup exit0 pouze pokud backend potvrdí published run. Wrapper netvoří shell command z obsahu kandidátů. Spustí CLI pomocí spawn s polem argv a promptem na stdin, timeout20min, redacted logs, OS lock na uživatele, lock vždy uvolní při shutdown. Serverové run generation/idempotency chrání i druhý počítač.

Konfiguraci agenta uložit do dedikovaného osobního prostředí s pouze Siftera MCP. Použít uživatelovo přihlášení klienta, nikoli přepisovat subscription token do Siftery. Subscription může mít limity a expiraci; failure nevede k placenému API fallbacku bez explicitního zapnutí uživatelem. API fallback je budoucí adapter, v MVP neimplementovat.

Ověřovací pořadí:

1. CLI `codex --version` a `codex exec --help` musí fungovat. Uživatel má funkční osobní login.
2. Nakonfigurovat pouze Siftera endpoint a env bearer token; ověřit tools/list a permissions.
3. Jeden ruční `codex exec` s promptem z AI_EDITOR, nejnižšími potřebnými oprávněními a uloženým loginem. Příkaz a podporované flags přizpůsobit skutečně nainstalované verzi; nevyužívat neověřený automatický signup/API.
4. V UI ověřit skutečný publikovaný run a správný uživatelský účet.
5. Teprve potom uživatel může přidat cron.

Ukázka cron, cesta je placeholder k wrapperu vytvořenému v M3, nikoli instalovaný job:

```cron
0 7 * * * /absolute/path/to/siftera-editor-runner >> /absolute/private/path/editor.log 2>&1
```

Cron má minimální PATH; wrapper musí používat absolutní cesty Node/CLI a privátní env soubor0600 mimo repo. Credential se nedává přímo do crontabu. Stroj musí být zapnutý a vzhůru; zmeškané spuštění se v MVP automaticky nedohání. Ruční retry je bezpečný. Výchozí timezone osobního OS, zobrazit uživateli při nastavení; server timestamps UTC.

## Ingest scheduling

Source lease2min s owner/expiry v transakci, jednotlivý tick≤45s. Concurrency4 zdroje,1request/host současně, nejméně1s mezi requesty stejnému hostu. Poll default60min, škola30min, min15min,max1440min. HTTP ETag/Last-Modified,304 aktualizuje lastSuccess a nextFetch, nevytváří kandidáta.429 respektuje Retry-After (cap24h);5xx exponential backoff15min,30min,60min…max24h s jitter. Po5 selháních health=degraded odvozený z consecutiveFailures; pokračovat s capped24h backoff a nabídnout ruční refresh. enabled=false nastavuje pouze uživatel.

Fetch RSS/HTML max100 položek/tick/zdroj; při větším backlogu uložit continuation a source zůstane due, zejména deliveryMode=all. Adapter nesmí jen tiše uříznout oznámení. HTML v MVP podporuje1index stránku; pokud web obsahuje stránkování mimo index, UI uvádí tento rozsah. Počáteční import max30d a oznámení ve zdrojovém indexu; starší archiv není implicitně slíben.

## Hosted cílový provoz

Firebase Hosting + Cloud Run + Firestore Standard + privátní GCS, region navržen europe-west1. Vybrat konzistentně před vytvořením databáze. Cloud Run1vCPU/512MiB jako počáteční odhad pro RSS/extrakci, request timeout60s,min0,max2. Po měření upravit memory; startup nesmí provádět ingest nebo dlouhou migraci. Cloud Scheduler volá přímo Cloud Run `/internal/ingest/tick` s OIDC dedicated service account.

Scale-to-zero se týká API compute; Firestore,storage,network a Scheduler mohou mít vlastní náklady. Specifikace negarantuje provoz zdarma. Výchozí budget alert10EUR/měsíc pro malý pilot je upozornění, nikoli tvrdý billing cap; aplikace má také source/run/size limity. Bez konkrétního projektu neprovádět provisioning.

Release: build,test,container smoke,deploy server,ověřit readiness,deploy hosting,Google redirect origins,ověřit actual login a MCP bearer. Rollback předchozí image+static release; schema změny jen zpětně kompatibilní nebo explicitní migrace. Firestore indexy dodat před query release. Zálohy a retence nastavit při skutečném hostování podle objemu, bez kopírování secretů do dokumentace.

## Runbook

- Feed starý: status posledního editor runu, počítač/cron, credential expiry, candidate availability. Ingest a AI mají oddělené health stavy.
- Zdroj selhává: error code,lastSuccess,retry time, dostupnost a změna HTML. Nezkoušet obejít blokaci.
- Publish409: profil/revize se změnila; ukončit draft a založit nový s aktuálním snapshotem.
- Storage unavailable:503, žádné falešné publish success; poslední cache zůstane.
- Únik agent tokenu: revoke,create/rotate,audit; nemusí se měnit Google login.
- Incident mezi účty: vypnout dotčený endpoint, zachovat metadata auditu, regression test před obnovením.
