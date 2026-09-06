# Siftera

Osobní AI editor internetu: vlastní zdroje, vědomé preference a pestrý feed, který stojí za přečtení.

Siftera sbírá obsah bez LLM. Externí agent z uživatelova prostředí vybere zajímavé kandidáty, přečte dostupný obsah, navrhne krátké shrnutí nebo doporučení originálu a publikuje denní výběr. Kliknutí ani označení přečteného není souhlas s větším množstvím stejného obsahu.

## Online prototyp

První internetová verze používá Sites, jeho přihlášení přes ChatGPT a trvalé D1/R2 úložiště. Původní Firebase adaptéry zůstávají v projektu. Web, HTTP API, vstupní pluginy a externí redakční job jsou samostatné části. Kontrakt a omezení: [PROTOTYPE](docs/PROTOTYPE.md), přidávání vstupů: [PLUGINS](docs/PLUGINS.md).

V aplikaci přidej RSS/Atom zdroj nebo odkaz/text do Inboxu. Celý vložený text výslovně označ. AI editor umožňuje stáhnout redakční job, zpracovat ho vlastním AI klientem a importovat výsledek; prototyp publikuje nejvýše 10 položek najednou. Bez AI je Inbox normálně použitelný. Na mobilu lze web přidat na plochu; sdílení do PWA závisí na podpoře prohlížeče. Přenosnější alternativou je ručně vložit URL.

## Veřejná ukázka na GitHub Pages

Běží na <https://edudant.github.io/siftera/>.

Statické UI s ukázkovým feedem se staví bez backendu (ADR-018):

```sh
pnpm demo:feed        # volitelně: obnoví ukázková data z běžícího lokálního backendu
pnpm build:pages      # výstup v dist/pages
```

Ukázka čte sanitizovaný snapshot `apps/web/public/demo-feed.json` — jen veřejná článková metadata a krátké redakční výstupy, žádné identity ani plná těla článků. Čtení, ukládání a ruční vstupy se drží pouze v prohlížeči konkrétního návštěvníka. Sběr z RSS a redakční export/import backend potřebují a ukázka to říká otevřeně místo tichého selhání; Pages neumí obejít CORS ani hostovat Worker. Nasazení obstará workflow `.github/workflows/pages.yml` po pushi do hlavní větve.

### Produkční nasazení Workeru

Worker je API; RSS ani AI na něm neběží. Sběr obstará lokální proces, Worker jen validuje, dedupuje a zapisuje do D1/R2:

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create siftera-prod
pnpm exec wrangler r2 bucket create siftera-content-prod
# database_id z výstupu zapiš do wrangler.jsonc
pnpm exec wrangler secret put API_TOKEN
pnpm exec wrangler secret put OWNER_UID
pnpm build:hosted
pnpm exec wrangler d1 migrations apply siftera-prod --remote
pnpm exec wrangler deploy
```

`ALLOWED_ORIGINS` musí obsahovat adresu webu (například `https://edudant.github.io`), jinak prohlížeč cross-origin volání zablokuje. Bez `API_TOKEN` API odmítne všechno — identita se bere z tokenu, nikdy z hlavičky, kterou by si mohl nastavit klient sám.

Web proti produkčnímu API se staví s adresou API místo ukázkových dat:

```sh
VITE_API_BASE_URL=https://siftera-api.<subdoména>.workers.dev pnpm build:pages
```

Ingest z lokálu (vhodné pro cron):

```sh
SIFTERA_API=https://siftera-api.<subdoména>.workers.dev SIFTERA_TOKEN=… pnpm ingest:once
```

Hosted build je samostatný Worker se statickým React klientem. Firebase je v repozitáři jen pro emulátory a Firestore/Storage adaptéry — hosting na něm nastavený není. Není to automatický cron, plný MCP ani dokončený původní MVP plán.

## Stav původního plánu

Specifikace v1, 6. 9. 2026. Implementace probíhá postupně podle [plánu](docs/MVP_PLAN.md); aktuální ověřený stav je v [IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md). Dokumentovaný cílový stav není tvrzení, že všechny funkce již fungují.

## Lokální vývoj a ověření

Vyžaduje Node 24.12+ a pnpm 11.19+.

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

M1 obsahuje runtime Zod kontrakty, deterministický core workflow a testovací memory adaptér. Původní Fastify server stále vystavuje pouze `GET /healthz`. Produktový prototyp běží v `apps/hosted/worker.ts`, používá `packages/prototype-api` a samostatnou React aplikaci `apps/web`.

M2a přidává samostatné Firestore a ContentStore adaptéry a ověřování Firebase identity. Integraci spustíš s Java 21+; Firebase CLI je zamčené v projektu:

```sh
pnpm test:integration
```

Příkaz sám spustí Auth, Firestore a Storage emulátory pro `demo-siftera`, provede testy a emulátory vypne. Nepotřebuje cloudový projekt, Firebase login ani `.env`. Používá porty 9099, 8080 a 9199; nespouštět současně s již běžícími emulátory na stejných portech. První spuštění může stáhnout emulátory a vyžaduje síť.

Pro ruční vývoj lze samostatně použít `pnpm emulators`. Příklad konfigurace je v [.env.example](.env.example); aplikační bootstrap zatím soubor automaticky nenačítá. Připojení adaptérů k produktovým HTTP routes a vytvoření uživatelského profilu patří do M2c. Testy persistence rekonstruují klienty a servis nad stejnou databází; nejsou testem produkčního nasazení.

Lokální hosted prototyp:

```sh
pnpm build:hosted
pnpm exec wrangler d1 migrations apply siftera-local --local
pnpm dev:hosted
```

Wrangler je pouze lokální runtime; v lokálních HTTP testech identitu simuluje hlavička `oai-authenticated-user-id`. Veřejný Worker se smí provozovat pouze za Sites dispatcherem, který poskytuje ověřenou identitu. Testovací hlavička není veřejný autentizační mechanismus. Soukromá lokální data jsou v ignorovaném `.wrangler/`. Tuto složku ani redakční exporty nepublikovat.

## Čtení pro implementačního agenta

1. [PRODUCT](docs/PRODUCT.md) – cíle a závazný rozsah.
2. [ARCHITECTURE](docs/ARCHITECTURE.md), [DATA_MODEL](docs/DATA_MODEL.md).
3. [API](docs/API.md), [MCP](docs/MCP.md), [AI_EDITOR](docs/AI_EDITOR.md).
4. [UX](docs/UX.md), [SECURITY](docs/SECURITY.md), [TESTING](docs/TESTING.md).
5. [MVP_PLAN](docs/MVP_PLAN.md) – konkrétní pořadí a acceptance criteria.

Další podklady: [rozhodnutí](docs/DECISIONS.md), [zdroje a integrace](docs/SOURCES.md), [nasazení a cron](docs/OPERATIONS.md), [rešerše a převzetí kódu](docs/REFERENCES.md), [datové typy](docs/contracts/domain.ts), [schéma redakčního výstupu](docs/contracts/editorial-result.schema.json), [příklady](docs/contracts/examples.json).

## Výchozí technologie

TypeScript, React/Vite PWA, Node 24, Fastify, Firebase Auth, Firestore Standard, Cloud Storage a Cloud Run. Lokální vývoj používá Firebase emulátory; testy core používají paměťové adaptéry. Cloudové prostředky a přístup k placeným zdrojům nejsou potřeba pro první milník.

Budoucí self-hosting má definované hranice úložiště a identity, není však součástí prvního MVP. První AI editor běží na zapnutém osobním počítači přes cron a MCP; Siftera neukládá přihlašovací údaje k AI subscription a standardně neplatí LLM API.

## Licence a příspěvky

Nový kód projektu: MIT, viz [LICENSE](LICENSE). Převzaté části musí mít zapsaný původ a zachované licenční oznámení v [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Nikdy necommitovat přístupové tokeny, cookies, privátní obsah ani soubory `.env`.
