# Ověřené reference a možné převzetí

Rešerše2026-09-06. U aplikací veřejná dokumentace/ukázky, nikoli měřený benchmark. U Newscope/Lion Reader navíc read-only inspekce konkrétních zdrojových souborů; test suites těchto projektů nebyly spouštěny. Původní projekty nejsou závislostí Siftery.

## Newscope

[Repo](https://github.com/umputun/newscope), commit `e220a28d9ee3459a82b6f8c01cc60180ad681565`, MIT. Go/SQLite/HTMX. Čtené: pkg/llm/classifier.go,pkg/scheduler/feed_processor.go,pkg/content/extractor.go,ARCHITECTURE.md,LICENSE.

Vhodné principy: batch classification,kompaktní feedback a preference summary,konzistentní topics,shrnutí bez meta-úvodu. Nepřevzít přímou vazbu ingest→placené LLM API ani likes/dislikes jako náhradu explicitních přání. Při adaptaci promptů odstranit kategorické přepisování tvrzení do „ověřených faktů“; zachovat nejistotu původního textu.

## Lion Reader

[Repo](https://github.com/brendanlong/lion-reader), commit `34a5f1fac3503e0df19e6904da44eeb048b76700`, LICENSE MIT (README má zastaralé TBD). TypeScript/Next.js/Postgres/Redis. Čtené: src/server/mcp/README.md,index.ts,vybrané tools.ts,src/server/http/ssrf.ts,src/server/feed/cache-headers.ts,src/server/plugins/types.ts,src/FRONTEND_STATE.md,LICENSE.

Kandidáti k portu: cache header parser+testy,safe DNS lookup+SSRF testy,source plugin capabilities,oddělení MCP/services a postupy pro race conditions optimistic updates/pagination. Nejprve zhodnotit nezávislost na jeho DB/logger/types,nepřidávat Redis/Postgres jen kvůli kopii helperu. Stdio přímý trusted UID režim v Sifteře nahradí scoped HTTP proxy.

Před skutečným kopírováním zkontrolovat licenci každého souboru/balíčku a případného převzatého upstreamu. Do THIRD_PARTY_NOTICES zapsat původ a celý required notice. Specifikace nevytváří povinnost kopírovat, pokud je menší vlastní implementace nad zavedenou knihovnou.

## Produktové/UI reference

- [feeeed](https://feeeed.nateparrott.com/) a [App Store](https://apps.apple.com/us/app/feeeed-rss-reader-and-more/id1600187490): pestré karty,rychlé čtení,podcast metadata,offline a zvýraznění zřídka publikujících zdrojů. Inspirace,žádné kopírování assetů.
- [Dibao features](https://dibao.app/en/features/): vlastní zdroje,vysvětlitelné doporučení,exploration radius,oddělení bulk-read od pozitivního feedbacku. [BUSL parametry](https://github.com/Pls-1q43/Dibao/blob/main/LICENSE-PARAMETERS.md) mají omezení komerčního využití; nepřebírat jeho kód do MIT základu.
- [Particle](https://particle.news/blog/introducing-particle-the-news-organized): seskupení pokrytí jedné zprávy a krátká shrnutí. Siftera MVP neimplementuje rozsáhlou syntézu ani fact-checking.
- [Surf](https://flipboard.helpshift.com/hc/en/12-surf/faq/1681-how-to-create-surf-feeds/?p=we): kombinace profilů,publikací,videa,podcastů a pohledů Read/Watch/Listen.

## Technologické zdroje

- [Firestore Enterprise text search](https://firebase.google.com/docs/firestore/enterprise/text-search): edition requirement; MVP Standard volí bounded client index.
- [Firebase auth emulator](https://firebase.google.com/docs/emulator-suite/connect_auth): emulator env umožní unsigned tokens; produkce je musí odmítnout.
- [Firestore rules](https://firebase.google.com/docs/firestore/security/rules-conditions): Admin/server SDK auth musí řešit server,IAM; client deny-all nestačí pro backend.
- [Cloud Run Scheduler](https://docs.cloud.google.com/run/docs/triggering/using-scheduler): OIDC scheduled HTTP invocation.
- [Vite guide](https://vite.dev/guide/): frontend scaffold/build; Node24 zvolen pro lokální i hosted runtime.
- [MCP server](https://modelcontextprotocol.io/docs/develop/build-server): SDK/transporty,nikoli vlastní protokol.
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),[noninteractive](https://learn.chatgpt.com/docs/non-interactive-mode),[auth](https://learn.chatgpt.com/docs/auth): první lokální integrační cesta. CLI na tomto hostu zatím neprošlo version check; reálný smoke neproběhl.

Technologické stránky ověřeny při tvorbě návrhu; finální dependency versions a CLI kompatibilitu ověřit při implementaci příslušného milníku a uložit lockfile. Rešerše není souhlas s přístupem k soukromým zdrojům.
