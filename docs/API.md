# REST API v1

## Konvence

Prefix `/api/v1`, JSON UTF-8. DTO v [domain.ts](contracts/domain.ts). Přihlášený PWA klient posílá `Authorization: Bearer <Firebase ID token>`. Všechny ID se validují jako neprázdný opaque string≤128, `[A-Za-z0-9_-]+`; UUID pro nové serverové identity. HTTP URL≤2048. Zápisové objekty strict, žádná neznámá pole. Odpovědi neobsahují hashes tokenů, GCS paths, cookies nebo server config.

Error: `{error:{code,message,requestId,retryable,details?:[{field,reason}]}}`. 400 syntaktický vstup, 401 chybějící/neplatný token, 403 scope, 404 neexistující i cizí objekt, 409 conflict/idempotency, 422 semantická validace, 429 quota s Retry-After, 503 dočasný upstream/storage. Chyby nejsou stack traces.

Mutace přijímají `Idempotency-Key` UUID kromě verzovaných PUT/PATCH (ty mají operationId v těle). Stejný klíč, cesta a kanonický payload vrátí uložený výsledek; jiný payload=409. Receipt TTL30d, publish klíč/hash zůstává v runu navždy. Finanční či infrastrukturní provisioning endpoint neexistuje.

## Uživatelské endpointy (Firebase identity)

| Metoda a cesta | Vstup | Úspěšná odpověď |
|---|---|---|
| GET /me | — | 200 User; první ověřený login založí vlastní User+default profile |
| PATCH /me | `{displayName?,locale?,timezone?}` | 200 User |
| GET /preferences | — | 200 PreferenceProfile |
| PUT /preferences | celý profile bez updatedAt, version=očekávaná současná | 200 nová version; konflikt409 |
| GET /sources | `includeArchived=false` | 200 `{items:Source[]}` max.50 active |
| POST /sources | `{name,config,groups,deliveryMode,pollIntervalMinutes,includeKeywords,excludeKeywords}` | 201 Source; enabled=true, due now |
| PATCH /sources/:id | editable subset stejných polí + enabled | 200 Source; URL změna je nový zdroj, config URL patch odmítnout |
| DELETE /sources/:id | — | 204; archive/disable, zachovat historii |
| POST /sources/:id/refresh | — | 200 `{sourceId,ingested,updated,deduped,status}`; bounded, min.60s cooldown |
| POST /sources/discover | `{url}` | 200 `{suggestions:[{name,config,reason}],warnings:string[]}`; pouze safe HTTP, nic automaticky nesubscribe |
| POST /sources/import-opml | `{xml,dryRun:boolean}` max.256KiB | 200 `{added,skipped,invalid:[{label,reason}],sources:Source[]}`; dryRun nepíše |
| GET /sources/export-opml | — | 200 application/xml; jen RSS a RSSHub URL, žádné tokeny |
| GET /feed/latest | — | 200 `{run:FeedRun|null,items:FeedItem[],schoolUnreadCount,stale:boolean}` |
| GET /feed/runs | `cursor?,limit=20` (≤50) | Page<FeedRun summary: id,publishedAt,count> |
| GET /feed/runs/:id | — | 200 `{run:FeedRun,items:FeedItem[]}`; published runs only |
| GET /items/:candidateId | — | 200 FeedItem (latest editorial) |
| GET /items/:candidateId/content | `revision,offset=0` | 200 CandidateContent chunk≤24k chars; vlastní kandidát,expired text410; read state beze změny |
| GET /editorial-items/:id | — | 200 FeedItem pro historický immutable editorial |
| GET /library | filtry níže | 200 Page<FeedItem> |
| GET /search-snapshot | `cursor?` | 200 `{items:SearchDocument[],nextCursor,scope}`; stejné cutoff ve všech stránkách |
| PATCH /items/:id/state | `{operationId,baseVersion,read?,saved?,hidden?}` nejméně1 pole | 200 UserItemState; stale version409 s currentState v separátním conflict DTO |
| POST /feed/runs/:id/mark-read | `{operationId}` | 200 `{updated:number,states:UserItemState[]}`; jen položky daného published runu |
| POST /feedback | `{id,candidateId,editorialItemId,action,target,comment}` viz Feedback | 201 Feedback se serverovým createdAt; max.comment500 |
| GET /agent-credentials | — | 200 `{items:AgentCredential[]}` |
| POST /agent-credentials | `{label,scopes,expiresInDays}` (1–90, default90) | 201 `{credential:AgentCredential,token:string}` token pouze jednou |
| DELETE /agent-credentials/:id | — | 204 revoke (idempotent) |
| POST /agent-credentials/:id/rotate | `{expiresInDays}` | 201 nový token; starý revokován atomicky |
| GET /editor/status | — | 200 `{activeRun,lastPublishedAt,lastFailure:{code,at}|null}` |

Read operations nezakládají read=true. Samotné přihlášení `/me` bootstrapuje uživatele v transakci idempotentně. Mutace preferences nesmí změnit version přímo, server ji zvýší. Scope root není parametr PWA.

## Filtry a hledání

`GET /library`: `sourceId?`, `group?`, `topic?`, `presentation?`, `from?`, `to?`, `read=all|read|unread`, `saved=true|false|all`, `hidden=false|true|all`, `sort=chronological|relevance`, `cursor?`, `limit=20` max50. Default hidden=false, ostatní all. AND mezi dimenzemi, v MVP po jedné hodnotě/dimenzi. Datum `from` inkluzivně, `to` exkluzivně. Filtry uložit v URL webu. `Škola` = group=school; skupiny source groups string slug≤40 max10/zdroj.

Chronologie `sortDate DESC, ID DESC`, relevance `relevance DESC, sortDate DESC, ID DESC`. Cursor base64url JSON s version, uid-bound query hash, cutoff, poslední prohlédnuté sort keys; server podpis HMAC, nelze změnit UID či query. Změna query invaliduje cursor. Případná prázdná stránka s nextCursor není konec výsledků.

SearchDocument: `{candidateId,editorialItemId,headline,summary,topics,sourceNames,sourceIds,groups,presentation,sortDate,relevance,state}`. Snapshot scope `{from,to,coveredSince,maxRecent:3000,maxSaved:1000,truncated,complete}`. Stránky≤200. Seznam vytvořit z cutoff a aktuálních LibraryItems; při lokální synchronizaci celý index nahradit po dokončení, během stahování zachovat starý. Nové zveřejnění v průběhu snapshotu přijde příštím refresh. Žádné tiché označení incomplete indexu za kompletní historii.

## Agentní REST protějšek

Stejné services jako MCP, bearer agent credential, nikoli Firebase token. Prefix `/api/v1/editor`. Uživatelské UI nemůže agent tokenem upravovat zdroje či preference.

| Metoda | Tělo/query | MCP ekvivalent |
|---|---|---|
| POST /editor/runs | `{operationId}` | begin_run |
| GET /editor/runs/:id/context | — | get_editor_context |
| GET /editor/runs/:id/candidates | `cursor?,limit?` | list_candidates |
| GET /editor/runs/:id/content/:candidateId | `revision,offset=0` | get_candidate_content |
| POST /editor/runs/:id/results | EditorialSubmission, path/body runId musí souhlasit | submit_editorial_results |
| POST /editor/runs/:id/publish | `{operationId,orderedCandidateIds}` | publish_feed |
| POST /editor/runs/:id/abort | `{operationId,reason}` reason enum cancelled/upstream_failure | abort_run |

## Interní endpointy

`POST /internal/ingest/tick` přijímá jen ověřený Google OIDC token konkrétní scheduler service account s přesným audience=Cloud Run URL. PWA ani agent credential nestačí. Stejný proces může route hostovat, auth je jiná. `GET /healthz` vrátí `{status:'ok'}`, `/readyz` pouze dostupnost služeb. `/mcp` specifikuje [MCP](MCP.md).

## Limity

JSON request max.256KiB (redakční batch≤10, každé summary≤800). Per UID read120/min, write60/min, refresh6/min; per credential MCP120/min a celkem40 distinct content reads/run. In-memory IP limit pouze ochrana instance, nesmí být prezentován jako globální kvóta. Trvalé user/credential budgety v repository; při více instancích použít transakční okna. Max.50 active sources,1000 saved items. Limity konfigurovat serverem, ne libovolným agent inputem.
