# Datový model a persistence

## Pravidla identity

Wire návrh: [domain.ts](contracts/domain.ts). UID je identita z Firebase, žádný endpoint nepřijímá cizí UID. Interní objekty mohou mít UID explicitně; public DTO ho nepotřebují kromě `/me`. Všechny timestamps na drátu jsou UTC RFC3339, datum úkolu `YYYY-MM-DD` nebo null. UI formátuje v uživatelově timezone.

ID zdrojů/runů/batch/feedback jsou UUID. Candidate ID vzniká jako UUID při prvním výskytu; nemění se změnou titulku, URL redirectem či revizí. `sourceId` je první původ, `sourceIds` obsahuje všechny vlastní zdroje, kde kandidát dorazil. Identity originálů sjednocují `urlKeys` a `externalKeys`; globální mezivlastnická deduplikace není součástí MVP.

## Firestore collections – cílový model MVP

Vše níže kromě agentCredentials je pod `users/{uid}`. Přístup Admin SDK vyžaduje UID v každé repository operaci, nikoli dodatečné filtrování výsledků.

| Cesta | Obsah / key |
|---|---|
| users/{uid} | User |
| preferences/current | PreferenceProfile; version začíná 1 |
| preferenceVersions/{version} | immutable snapshot při změně, reference z runu |
| sources/{sourceId} | Source včetně lease `{owner,until}` interně |
| urlKeys/{sha256(normalizedURL)} | candidateId; hash v rámci uživatele |
| externalKeys/{sha256(sourceId + externalId)} | candidateId; RSS GUID/Atom ID |
| candidates/{candidateId} | aktuální Candidate |
| candidates/{candidateId}/revisions/{revision} | immutable Candidate metadata snapshot |
| feedRuns/{runId} | FeedRun; ≤80 refs, ≤50 entries |
| feedRuns/{runId}/draftItems/{candidateId} | validovaný proposal, revision, batchId |
| feedRuns/{runId}/contentReads/{candidateId} | revision, hash, chunksServed, fullServed, servedAt |
| editorialItems/{itemId} | immutable EditorialItem bez fulltextu |
| libraryItems/{candidateId} | latestEditorialItemId, sourceIds, groups, topics, presentation, headline, summary, sortDate, relevance, updatedAt |
| itemStates/{candidateId} | UserItemState; chybějící = false/false/false/version0 |
| feedback/{eventId} | Feedback; immutable |
| operations/{operationId} | route, payloadHash, response, createdAt, expiresAt |
| system/feed | generation, latestRunId, activeRunId |
| audit/{eventId} | credential/run/source action metadata bez obsahu či tokenu |
| agentCredentials/{credentialId} (root) | uid, secretHash, AgentCredential; přímý lookup |

Root credential collection nemá klientské reads; slouží ověření bearer tokenu bez query nad všemi uživateli. Použití tokenu neumožňuje enumerate credentials.

## ContentStore

Klíč `users/{uid}/content/{candidateId}/{revision}.json.gz`. JSON obsahuje CandidateContent. GCS bucket je privátní, browser ani MCP nedostává storage URL. API vrací pouze autorizovaný plain text. Výchozí retain raw/extracted 30 dní, saved kandidáty nečistit. Metadata historie se v MVP automaticky nemažou. Při chybějícím starém textu vrátit `CONTENT_EXPIRED`; historické perexy a provenance fungují dál.

Extrakce on-demand může k existující revizi doplnit contentRef/hash bez změny jejího zdrojového obsahu. Jestli fetch detekuje odlišný skutečný obsah, vytvoří novou revizi a starý run vrátí `CANDIDATE_CHANGED`; nikdy nepodstrčit nový text za starý hash. Uložení blobu před metadaty; orphan blobs lze smazat po 24 h bez reference. Nevracet úspěšný obsah, pokud metadata write selhal.

První doplnění plného textu do prázdné/partial cache je hydration stejné revision, nikoli automaticky změna článku. Interně oddělit fingerprint zdrojových title/excerpt/feedBody/media od contentHash extrahovaného textu. Teprve změna zdrojového fingerprintu nebo rozdíl proti dříve uloženému úplnému textu vytvoří novou revision.

## Deduplikace a revize

1. URL normalizace: pouze http/https, lowercase host, odstranit fragment a default port, odstranit `utm_*`, `gclid`, `fbclid`. Zachovat ostatní query, trailing slash a case path. Řadit query parametry. Neodstraňovat parametry s významem pro identitu.
2. Relativní URL vyřešit proti zdrojovému dokumentu. Každý redirect/canonical musí projít safe-fetch pravidly. Canonical automaticky převzít pouze pro stejný hostname (www varianta povolena); cizí canonical ignorovat v MVP.
3. V transakci lookup source-scoped externalId a urlKey. Pokud oba ukazují různé kandidáty, nic neslučovat destruktivně; zapsat conflict a ponechat starší identity k explicitnímu review.
4. Identické title/excerpt/body/media po normalizaci whitespace = žádná nová revize. Změna `discoveredAt` či navigace stránky sama není změna obsahu.
5. Skutečná změna vytvoří revision+1, nová immutable metadata, případně nový blob. Staré feed entries stále ukazují na staré EditorialItems. Nová školní revize se zobrazí jako aktualizace a resetuje read=false, saved/hidden zachová; škola filtr umožňuje hidden zobrazit.
6. Stejná zpráva z různých vydavatelů není technická duplicita: editor zvolí jeden hlavní Candidate a `relatedCandidates`. Related refs zůstávají původními kandidáty; nevzniká automatické sloučení identity.

`read/saved/hidden` patří Candidate, nikoli FeedEntry. Přečtení v jednom vydání se projeví ve všech. Školní aktualizace je výslovná výjimka resetující read. Nové běžné redakční zpracování read nesmaže.

## Run a atomické publikování

`begin_run(operationId)` v transakci vrátí existující aktivní draft nebo vytvoří nový, zvýší generation a uloží cutoff, snapshot preferencí a kandidátů. TTL draftu 60 min, jeden aktivní draft/uživatel. Prodloužení není v MVP; expirovaný run lze opustit a začít nový. Žádné držení databázové transakce během práce AI.

`submit` upsertuje nejvýše 10 proposalů/batch do draftu po validaci. Celý batch buď projde, nebo vrátí seznam chyb; žádné tiché částečné přijetí. Idempotency receipt vznikne ve stejné transakci. Stejný batchId s jiným obsahem = 409.

`publish(runId, orderedCandidateIds, operationId)` nejprve připraví neměnné výstupy, v transakci znovu ověří activeRunId/generation, preferenceVersion, aktuální kandidátní revize, draft status/expiry, stávající hidden/read a limity. Při změně preferencí či revizí vrátí 409, run nepublikuje.

Transakce vytvoří EditorialItems s deterministickým ID `runId_candidateId`, pole FeedEntry v runu, aktualizuje LibraryItems a latestRunId, změní run na published a uloží receipt. Max. 50 položek; metadata+payload transakce cílit pod 2 MiB. Bloby jsou mimo transakci a publish je nekopíruje. Opakování stejné operace vrátí stejný feed; jiný payload na publikovaném runu = 409. Prázdný výběr se může publikovat jako nový run s 0 entries, starší historie se nemění.

Školní systémový item ID `system_candidateId_revision`; vytvoření a aktualizace LibraryItem je součástí idempotentního ingest zápisu. Nezávisí na existenci redakčního runu.

## Indexy a query plán

Všechny indexy jsou scoped na konkrétní uživatelskou podkolekci; collection-group používá pouze interní scheduler pro enabled due sources, nikdy uživatelské API.

| Collection | Composite index / využití |
|---|---|
| sources (collection group) | enabled ASC, nextFetchAt ASC; interní due scan |
| candidates | discoveredAt DESC, __name__ ASC; deterministický prefilter scan |
| feedRuns | status ASC, publishedAt DESC, __name__ DESC; historie |
| libraryItems | sortDate DESC, __name__ DESC; chronologie |
| libraryItems | relevance DESC, sortDate DESC, __name__ DESC; relevance |
| itemStates | saved ASC, updatedAt DESC, __name__ DESC; saved dataset |
| feedback | createdAt DESC, __name__ DESC; poslední feedback |

V implementaci dodat `firestore.indexes.json`. Single-field index exemptions: full preferences instructions, summary, excerpt, provenance, config selectors, candidateRefs, entries, audit detail a hashované credential secret. Žádné indexování velkých textů.

Kombinované filtry MVP aplikuje service nad uspořádanými stránkami LibraryItems, nikoli generováním desítek Firestore indexů. Scan max. 1000 záznamů/request, výstup ≤50. Cursor ukazuje poslední prohlédnutý záznam, i pokud stránka po filtrování zůstane prázdná; client pokračuje dokud má cursor. Stav položek načítat batch get. Query fingerprint v cursoru zabrání použití v jiném filtru/řazení.

Search snapshot je samostatný bounded export posledních 90 dní max.3000 LibraryItems plus saved max.1000 (limit ukládání v MVP). Odpověď uvádí from/to, počet, truncated a coveredSince. Historie starších vydání je dostupná samostatně i mimo search scope. MiniSearch na klientu indexuje headline, summary, topics, sourceName; žádný raw fulltext. Časové filtry a řazení pro search se aplikují jen na deklarovaný snapshot.

## Příklady a evoluce

[examples.json](contracts/examples.json) obsahuje preference, návrh redakce a feed. `schemaVersion=1`; změna wire kontraktu, která není aditivní, vyžaduje novou verzi a ADR. Zod runtime musí odmítat cizí properties u zápisů. Repository ukládá `schemaVersion` interně pro migrace. Preferovat explicitní migrace před opravami při každém read.

## Implementované mapování M2a

Firestore adaptér ukládá dokumenty jako `{schemaVersion: 1, data: ...}`. Neznámá verze vyvolá chybu vyžadující migraci. Tabulky výše popisují logický cílový model; skutečné cesty indexů musejí zahrnovat prefix `data.` a případné další vnoření. Závazná konfigurace je [firestore.indexes.json](../firestore.indexes.json).

| Dokument | Aktuální obsah `data` |
|---|---|
| preferences/current, preferenceVersions/version | PreferenceProfile |
| candidates/id, candidates/id/revisions/n | `{candidate, sourceFingerprint}` |
| sources/id | SourceMetadata z core; ještě není plný Source s lease/config |
| feedRuns/id | FeedRun |
| feedRuns/id/draftItems/candidateId | EditorialProposal |
| feedRuns/id/draftBatches/batchId | `{batchId, payloadHash}` |
| feedRuns/id/contentReads/candidateId | ContentReadReceipt z core; chunky doplní M3 |
| editorialItems/id | StoredEditorialItem, obsahující proposal a neměnný původ |
| libraryItems/candidateId | `{candidateId, editorialItemId, sortDate, relevance}`; širší projekce a stránkování přijdou později |
| itemStates/candidateId | UserItemState |
| feedback/id | `{feedback, payloadHash}` |
| operations/hash | RepositoryOperation podle druhu; hash je SHA-256 nad kind, NUL a operationId |
| system/feed | FeedPointer |
| rejections/key | RejectionRecord včetně revision/preferenceVersion/rejectedAt |
| urlKeys/hash, externalKeys/hash | `{candidateId}` |

Uživatelský profil, agent credentials, audit a retenční cleanup ještě nejsou implementované. Fulltext je gzip JSON v samostatném local/GCS ContentStore. Hydratace partial → full je povolená; druhý odlišný plný text stejné revize se odmítne. GCS zápis porovnává generaci objektu, kterou skutečně načetl. Lokální adaptér používá souborový lock a atomické přejmenování; automatické zotavení po pádu procesu s opuštěným lockem zbývá doplnit před provozem.

Repository odkládá Firestore writes do konce callbacku a umožňuje číst vlastní čekající zápisy. Run agregát načítá samostatné podkolekce s limity 80 proposals, 40 content receipts a 100 batch receipts; nadlimitní zápis se odmítne. API M3 musí tuto hranici počtu batchů vracet jako srozumitelnou chybu. List operace jsou omezené na nejvýše 3000 dokumentů; nejde o budoucí stránkované API knihovny. Emulator ověření nenahrazuje předprodukční kontrolu indexů a měření maximální velikosti transakce.
