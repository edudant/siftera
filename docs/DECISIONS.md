# Architektonická rozhodnutí (ADR)

Status accepted, v1, 2026-09-06. Tento soubor uzavírá doporučené volby; změny vyžadují konkrétní důvod a dopad, nikoli opakované obecné porovnávání stacků.

## ADR-013 Rychlý online prototyp a vstupní pluginy

6. 9. uživatel upřednostnil první internetový/mobilní prototyp před dokonalým dokončením milníků a výslovně požaduje oddělené vstupy, AI job a UI. Vstupy proto implementují ConnectorRegistry a normalizují do existujícího ingestu; ruční URL/text je rovnocenný RSS. Hosted prototyp přidává D1/R2 a Sites identity adaptéry, aby nevyžadoval nový placený cloudový projekt. Core ani existující Firebase implementace se nezahazují. UI je přenositelné na statický hosting, včetně uživatelem zmíněného GitHub Pages, ale potřebuje externí API. První job je explicitní export/import pro vlastní AI klient, nikoli předstíraná automatická AI.

Prototypový D1 adaptér ukládá jednotlivé doménové záznamy do owner-scoped SQL rows a používá optimistic epoch + atomický batch pro transakce. Omezený DraftData je jeden dokument s limitem800kB; není to neomezený blob celého účtu. Tento kompromis nemění core port ani Firestore mapování. Sources jsou v samostatné tabulce. Produkční maxima a benchmarky nebyly ověřeny.

## ADR-001 Produkt a samostatné účty

Osobní editor vlastních zdrojů s multimediálním feedem. Žádný parent/child vztah ani Audience entity. Škola = source group a režim all. Alternativa rodinné hierarchie byla výslovně odmítnuta uživatelem. Nezaměnit samostatnost účtu se slibem dětské moderace.

## ADR-002 Vite React a modulární TypeScript monolit

PWA je přihlášená osobní aplikace, nepotřebuje veřejné SEO/SSR. Vite snižuje počet runtime vrstev. Fastify obsluhuje REST/MCP přes sdílené core services. Next.js/Lion Reader fork by přinesl další rozhodnutí a závislosti, aniž by nahradil specifický redakční workflow.

## ADR-003 Firebase/Firestore Standard pro hosted MVP

Zachovat uživatelovu preferenci Google login,Hosting,Firestore,Cloud Run. Izolovat provider SDK do server wiring/storage a nevyužívat client Firestore reads. SQL je dobrá budoucí alternativa, ale nevytvářet současně druhý production persistence stack. Memory adapter pouze pro testování. Úložiště textu oddělit od Firestore metadata a feed entries.

## ADR-004 Search je deklarovaně omezený klientský index

MiniSearch nad≤3000 metadata položkami posledních90d a≤1000 saved. Výslovně zobrazit coverage/truncated. Historická vydání jsou samostatně procházetelná. Neomezený archive FTS není součástí MVP.

Aktuální dokumentace uvádí nativní text search pro **Firestore Enterprise**; tvrzení „Firestore nemá fulltext“ by bylo nepřesné. Pro Standard MVP nepotřebujeme měnit edici ani přidávat search server. Později SearchProvider může použít Enterprise search,PostgreSQL FTS,Meilisearch či Typesense. [Oficiální dokumentace](https://firebase.google.com/docs/firestore/enterprise/text-search), ověřeno2026-09-06.

## ADR-005 Externí AI subscription a lokální cron

Backend poskytuje kontrakt, nevolá primárně LLM API. První integrace osobní CLI+cron; volitelný API adapter není v MVP nutný. Codex dokumentuje noninteractive exec a subscription sign-in. Lokální prostředí a podporované flags ověřit před nastavením. Uživatelův OpenAI login nikdy nekopírovat do projektu nebo veřejného CI. [Exec](https://learn.chatgpt.com/docs/non-interactive-mode), [auth](https://learn.chatgpt.com/docs/auth), ověřeno2026-09-06.

## ADR-006 MCP je adaptér

Streamable HTTP na stejném backendu, explicitní agent token a scopes. Stdio proxy používá stejný remote auth. Plný OAuth odložen; raw bearer není příslib kompatibility s každým hosted klientem. Žádné business rules duplicitně v tool handleru. [MCP server guide](https://modelcontextprotocol.io/docs/develop/build-server), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## ADR-007 Ingest scheduling a scale-to-zero

Krátký synchronní tick přes Cloud Scheduler OIDC nebo lokální CLI/cron, source leases a nextFetchAt v DB. Žádný setInterval loop potřebný pro fungování na Cloud Run, žádný background promise po response. Cloud Tasks/queue přidat až když45s bounded tick nedostačuje. [Cloud Run scheduling](https://docs.cloud.google.com/run/docs/triggering/using-scheduler).

## ADR-008 RSSHub je volitelný vstup

RSS/Atom preferovat přímo. RSSHub URL je RSS source s externím poskytovatelem; backend na něm není závislý, neprovozuje RSSHub jako povinnou službu. Availability a privacy specifického RSSHub hostu zůstává vlastností source config.

## ADR-009 Rychlá redakce a stručná evidence

relevance/quality/novelty/basis, nikoli truth scoring. Zdroj a krátká přesná evidence pro distilled kartu brání vymyšlené pointě, ale nejsou fact-check. long_read potřebuje dostupný přečtený text. Metadata-only audio/video jasně označit. Sloučení stejné zprávy probíhá v AI výběru nad candidate refs, ne embeddingovým clusterem.

## ADR-010 Immutable vydání a mutable čtenářský stav

FeedRun a EditorialItem po publikování neměnit. Read/save/hide patří Candidate napříč historií. Podmíněná transakce s generation/revision/preferences version zamezí stale publish. Nový run během scrollu zobrazí banner, neprovede skryté přeuspořádání.

## ADR-011 Převzetí kódu

Newscope a Lion Reader MIT: cíleně zhodnotit konkrétní moduly a testy, přizpůsobit našim ports, zachovat licenci. Žádný automatický fork celého produktu. Dibao BUSL jen funkční inspirace, ne zdroj kopírovaného kódu. feeeed/Particle/Surf UI a produktové reference, žádné kopírování assetů.

## ADR-012 Bezpečné selhání a omezený offline rozsah

Poslední feed zůstává při selhání AI; škola se publikuje deterministicky. Offline shell+last feed+stavová fronta; video,celý archiv a všechny originální články nejsou offline slib. Conflict server versions vyvolá viditelný konflikt, nikoli tiché přepsání novějšího stavu.
