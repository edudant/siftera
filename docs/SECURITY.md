# Security a trust boundaries

## Threat model

| Hrozba | Povinná ochrana | Test |
|---|---|---|
| Cizí UID/ID v API či MCP | identita z tokenu, tenant-scoped repositories,404 u cizího ID | dvě identity, všechny read/write cesty |
| Agent si mění zdroje/preference | allowlist6 scopes, mutace settings jen Firebase user |403 pro agent token |
| Únik tokenu |32 random bytes, hash, TLS, redact authorization, jednorázové zobrazení | token není v log/response list |
| Revokace ignorovaná cache | načíst credential při každém requestu | revoke mezi tools/list a tools/call |
| Firestore client obejde API | deny-all client rules, Admin IAM minimum | emulator rules test |
| unsigned auth z emulatoru v produkci | start fails při emulator env v production; žádný dev UID header | config fail-closed test |
| SSRF přes URL/redirect/DNS | safe fetch pipeline níže | private IPv4/IPv6, rebinding, redirects |
| XSS z RSS/HTML/AI | plain text na hranici, sanitize případné HTML, React escaping | script/event attrs/javascript URLs |
| Prompt injection | zdroj jako data, limit tools/scopes, server-owned provenance | malicious article fixture |
| Stale/duplicate publish | generation/preferences/revision checks a transakce | concurrency+retry tests |
| Offline cross-user leak | UID cache partition, logout clearing, queue identity | browser two-user test |
| Velký/škodlivý feed | bounded decompress/parse/download, no external entities | gzip/XML bombs fixtures |

## Safe HTTP fetch (všechny zdroje, obrázky i link discovery)

Pouze http/https; zakázat userinfo, neobvyklé porty (jen80/443), fragment zahodit. Odmítnout IP literal pokud není globálně routovatelný. DNS lookup musí zkontrolovat všechny A/AAAA: private, loopback, link-local, multicast, unspecified, reserved a IPv4-mapped IPv6. Kontrola musí být navázána na skutečný socket lookup/connection; samotné předchozí resolve a následný obyčejný fetch je zranitelný rebindingem. Použít undici dispatcher s kontrolovaným lookup a zachovat TLS hostname verification.

Redirecty manual, max.5, každá destinace znovu validovat, neforwardovat auth/cookies. Žádný ambient browser cookie jar. Blokovat metadata hostnames i IP, localhost a lokální suffixy. Max.request15s, max5MiB decompressed HTML/XML, max.text200k znaků, Content-Type allowlist. Při chybě nic nespouštět přes shell/browser/LLM. XML parser nemá resolve external entities/DTD. Velký nebo malformed feed nesmí zastavit další zdroje.

Volitelný serverový image proxy má stejné omezení, přijímá pouze candidateId a image index z vlastní DB, nikdy libovolnou URL od klienta. MVP může obrázky načítat přímo s no-referrer a pevnými rozměry; privátní credential URL nikdy nevracet browseru. Žádné sdílení privátní raw cache s jiným uživatelem.

Robots pravidla a rate limity respektovat při fulltext fetch. HTTP401/403/paywall/error se nikdy neřeší obcházením; uložit dostupná metadata. Cizí obsah není autorizace ke změně konfigurace.

## Backend identity

Firebase ID token ověřovat Admin SDK, audience/issuer/project, expiry a disabled/revoked user podle SDK. Nespoléhat na dekódování JWT bez podpisu. REST PWA endpoints nepřijímají agent token jako plnohodnotného uživatele. Agent root lookup vrátí Principal s omezenými scopes.

Produkce vyžaduje explicitní project/bucket a nesmí mít FIREBASE_AUTH_EMULATOR_HOST/FIRESTORE_EMULATOR_HOST ani DEV_AUTH_MODE. Lokální demo bind pouze127.0.0.1; test identity verifier jde injectovat do test factory, nesmí existovat univerzální dev auth header v produkčním serveru.

Cloud Run service account jen Firestore data a příslušný bucket; deployment identity oddělená. Žádný service-account JSON v repozitáři, používat ADC a workload identity. Scheduler OIDC token explicitně audience+email allowlist+verified issuer. CORS explicitní frontend origins, remote MCP validuje Origin pokud existuje (non-browser klient bez Origin může), zabránit DNS rebindingu na lokálním transportu.

## Prompt injection a redakční výstup

Backend zaručuje hranice dat a povolených zápisů; nemůže garantovat chování libovolně nakonfigurovaného externího agenta. Onboarding doporučí dedikovaný agentní kontext s pouze Siftera MCP a bez dalších účtů/dat. AI článek nesmí ovlivnit systémové instrukce, tool endpoint či scope.

Proposals obsahují jen interní refs; backend odvodí provenance, source URL, media, UID a ID. Zkontrolovat candidate patří do run snapshotu, správnou revision a serverem zaznamenanou dostupnost textu. EvidenceQuote ověřit jako substring normalizovaného textu. Toto ověřuje oporu shrnutí ve zdroji, nikoli pravdivost zdroje.

Povolené vlastnosti a max.délky pomocí strict runtime schema. Renderer nikdy nevykonává markdown HTML ani URL scheme `javascript:`/`data:`. External embeds povolit pouze konkrétním providerům s generovanou URL. CSP default-src self, object-src none, base-uri self, frame-ancestors none; connect-src explicitní Firebase/Auth/API, frame-src konkrétní Google auth/YouTube domains. Žádné unsafe-eval v produkci.

## Provozní data

Audit: co, kdy, credentialId/runId/sourceId, success/failure code. Žádné fulltexty, preference instructions, search queries ani secrets do běžných logů. Chybové hlášky uživateli odstraní query params privátních URL. Token v query URL nikdy nepodporovat. Source import s URL obsahující credentials odmítnout. Rate limiting nesmí používat plaintext token jako key.

Samostatný účet dítěte znamená plnou tenant izolaci; neposkytuje rodičovské schvalování ani slib bezpečného obsahu. Výběr zdrojů/instrukcí ovládá daný uživatel. Produkční onboarding a podmínky přihlašovacích providerů se musí ověřit před veřejným zpřístupněním, nesmí se simulovat věk ani obcházet provider omezení.
