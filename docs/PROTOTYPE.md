# První online prototyp – 6. 9. 2026

Uživatel upřednostnil funkční prototyp na internetu a mobilu před dokončením všech původních milníků. Zachovat core a provider ports. Příjem článků je plugin registry nad normalizovaným IngestInput: ruční URL/text, RSS/Atom, později share target a další konektory. Žádné LLM v ingestu. Samostatný editor pracuje podle explicitních preferencí. UI používá pouze HTTP API.

Prototyp může použít Sites hosting s D1/R2 a platformovou identitou jako další adaptéry; původní Firebase adaptéry zůstávají. GitHub Pages je možný statický host UI s externím API. Nejde o závazek provozovat celou aplikaci bez backendu.

## Kompaktní HTTP kontrakt prototypu

Prefix `/api/v1`, JSON, errors `{error:{code,message}}`. Identitu určuje server. Žádná UID pole ve vstupech. Mutace vyžadují JSON a same-origin kontrolu, UI API credentials same-origin.

- `GET /bootstrap` → `{user:{id,email}, preferences:PreferenceProfile, feed:{run:FeedRun|null,items:FeedItem[]}, library:FeedItem[], inbox:Array<{candidate:Candidate,state:UserItemState}>, sources:PrototypeSource[], plugins:Array<{id,label}>}`.
- `POST /articles` `{url,title?,text?}` → `{candidate}`. Ruční plugin, uloží inbox bez předstírání AI.
- `POST /sources` `{name,url,pluginId:'rss',groups?:string[],deliveryMode?:'curated'|'all'}` → Source.
- `PATCH /sources/:id` `{enabled?:boolean,name?:string}` → Source; `DELETE /sources/:id` → 204.
- `POST /sources/:id/refresh` `{}` → `{ingested:number,errors:string[]}`. Bounded fetch bez LLM.
- `PUT /preferences` `{preferences:PreferenceProfile,expectedVersion:number}` → PreferenceProfile; server určí version/updatedAt.
- `PATCH /items/:candidateId/state` `{patch:{read?,saved?,hidden?},expectedVersion:number,operationId:string}` → UserItemState.
- `POST /editor/export` `{operationId:string}` → `{run:FeedRun,preferences:PreferenceProfile,candidates:Array<{candidate:Candidate,content:CandidateContent|null}>,instructions:string,schema:object}`. Načtení textu vytvoří receipt; nemusí přenášet plný limit80 článků.
- `POST /editor/import` `{submission:EditorialSubmission,orderedCandidateIds:string[],operationId:string}` → publikovaný feed. Server provede validaci core, nikoli prostý JSON zápis.
- `POST /editor/abort` `{runId:string}` → FeedRun.

PrototypeSource: `{id,name,url,pluginId,groups,deliveryMode,enabled,createdAt,lastFetchedAt,lastError}`. Datum a error nullable. Source config oddělené od core SourceMetadata.

Úložiště je trvalé a oddělené podle identity. PWA ukládá shell; globální service-worker cache nesmí obsahovat autentizované API odpovědi. Offline úpravy/synchronizace, plný MCP, automatický cron a pilotní hodnocení nejsou předstírány jako hotové. Export/import redakčního jobu je použitelná mezivrstva pro externí AI; dokud skutečný runner neprojde smoke, není označen za automatický.

## Redakce v2 (ADR-017)

`POST /editor/export` navíc vrací promptVersion, history, knownTopics, recommendedShortlistCandidateIds a budgets. Kandidát nese ageDays, state, source, fullTextReceipt a articleRead. `POST /editor/enrich {runId,candidateIds}` načte nejvýše4 originály/dávku, maximálně20/run, pouze URL ze snapshotu. Export se poté obnoví. `POST /editor/import` přijímá buď původní submission, nebo submissions (pole dávek), a společné orderedCandidateIds a operationId. Pole emphasis a imageTreatment jsou volitelná, staré odpovědi zůstávají platné. Podrobná pravidla dostupnosti textu a validačních hranic viz AI_EDITOR.
