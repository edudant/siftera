# MCP fasáda

## Transport a identita

Hosted `/mcp` Streamable HTTP přes oficiální TypeScript SDK, stateless request handling, JSON odpovědi, bez nezbytné dlouhé SSE session. Implementovat initialization, tools/list, tools/call přes SDK. HTTP POST; nepodporovaný GET streaming=405, DELETE session v stateless režimu=405. Verzovací hlavičky/protokol handshakes podle vybrané kompatibilní SDK verze, nevymýšlet vlastní JSON-RPC implementaci.

Remote autentizace: `Authorization: Bearer sf_<credentialId>.<secret>`. Ověřována při každém requestu, i tools/list a initialization. Neznámý/expirující/revokovaný credential=401 bez úniku existence. Žádné userId v tool schemas. Identity je součást kontextu volání, ne parametr LLM. Přístup na cizí run/candidate/item=404.

První lokální stdio transport je **HTTP proxy klient** týchž služeb: spustí se na počítači, čte SIFTERA_API_URL a SIFTERA_AGENT_TOKEN z env a přeposílá konkrétní tool requesty na agentní REST endpointy. Nemá Firebase Admin, DB URL ani privilegované UID. Toto zjednodušuje lokální onboarding při zachování stejného credential modelu. Budoucí plně lokální server může znovupoužít service layer.

## Tools v1

Strojově čitelné input schemas a required scopes: [mcp-tools.json](contracts/mcp-tools.json). `requiredScopes` je interní metadata Siftery, nepředává se jako neznámé pole registraci SDK. JSON soubor je normativní návrh; implementace jej nesmí nepozorovaně rozcházet s runtime schématy.

Všechna input schemas mají additionalProperties=false. Nástroje vracejí text JSON a structuredContent podle SDK. Nevracet pretty-printed tisíce znaků whitespace. Chyba tool call = isError=true a strukturovaný code/message/retryable; transportní auth chyby zůstávají HTTP401/403.

| Tool | Input | Output | Potřebné scopes |
|---|---|---|---|
| begin_run | `{operationId:ID}` | `{runId,status,generation,expiresAt,preferenceVersion,candidateCount,budgets:{candidateLimit,contentReadLimit,remainingCharacters},schemaVersion:1}` | editorial:write, candidates:read, preferences:read |
| get_editor_context | `{runId:ID}` | `{preferences,feedbackSummary,recentHistory,knownTopics}` | preferences:read, feedback:read, history:read |
| list_candidates | `{runId,cursor?:string,limit?:integer1..20}` | `{items:CandidatePreview[],nextCursor}` | candidates:read |
| get_candidate_content | `{runId,candidateId,revision:integer>=1,offset?:integer>=0}` | `{candidateId,revision,access,contentHash,text,offset,nextOffset,totalCharacters,truncated,fullServed}` | candidates:read |
| submit_editorial_results | EditorialSubmission v1 | `{acceptedCandidateIds:ID[],rejectedCount,batchId}` | editorial:write |
| publish_feed | `{runId,operationId,orderedCandidateIds:ID[]}` | `{runId,status:'published',publishedAt,count,shortfalls:string[]}` | feed:publish |
| abort_run | `{runId,operationId,reason:'cancelled'|'upstream_failure'}` | `{runId,status:'aborted'}` | editorial:write |

CandidatePreview = candidateId,revision,title≤180,excerpt≤240,sourceId,sourceName,sourceGroups,publishedAt,discoveredAt,medium,access,categories,max10,deliveryMode. Server nevkládá fulltext do preview. Všechny tool outputs uživatelský obsah zřetelně popisují jako untrusted data, ale nevkládají do něj nové autoritativní instrukce.

RecentHistory = poslední 3 published runy max.60 unikátních položek za14d, každá headline/topics/candidateRef/summary≤160; bez textů článků. get_editor_context≤24KiB, jedna stránka candidates≤16KiB, content≤24k znaků. `get_candidate_content` je idempotentní read; retry stejného chunku znovu neodečte budget. Offset musí být známá hranice chunku. Záznam contentReads serveru ověřuje vydané chunky, nikoli lidské přečtení.

`fullServed=true` jen pokud dostal všechny chunky dostupného úplného textu a access=full,truncated=false. Metadata-only či neúplný text nesmí splnit distilled_fact precondition. Není-li budget na další text, vrátit `RUN_BUDGET_EXCEEDED`, již publikovaný feed nesmazat.

Resources a prompts nemusí být registrovány v MVP; workflow nabízí UI a soubor [AI_EDITOR](AI_EDITOR.md). Tool annotations: read-only u context/list/content, ostatní mutační; anotace není auth ochrana. Žádný obecný HTTP fetch, shell, „set user“ ani libovolný databázový query tool.

## Agent credential

- credentialId UUID, secret32 náhodných bytes base64url, generovat CSPRNG. Prefix sf_. V DB pouze SHA-256 secretu s doménovou značkou `siftera-agent-v1:`; vysoká entropie nevyžaduje password KDF. Porovnat constant-time. UID a scopes číst pouze z credential recordu.
- Veřejné metadata label/scopes/createdAt/expiresAt/revokedAt/lastUsedAt/rotatedFrom. Hash ani celé credential nikdy nevracet po vytvoření. Token v env nebo osobním secret souboru0600, nikdy v URL/log/promptu/OPML.
- Default90d, max90d. Rotation vytvoří nový a revokuje starý v jedné transakci. No grace period v MVP. Revokace účinná nejpozději dalším requestem, žádná pozitivní auth cache déle než request.
- Poslední použití zapisovat nejvýše1×/15min, ale revokaci kontrolovat vždy. Audit vytvoření/revoke/rotate a publish eviduje credentialId, uid a timestamp; ne raw IP/obsah.
- Default token obsahuje všech6 scope pro editora. UI může zvolit read-only s prvními4 scopes. Scope feed:publish nedává právo sources:write ani preferences:write.

## Onboarding

PWA → Nastavení → AI editor: vytvořit token, zobrazit endpoint, snippet konfigurace a prompt, pak tlačítko „Zkontrolovat poslední běh“. UI nekopíruje subscription login. Uživatel ručně nakonfiguruje svůj agentní klient; nejprve jeden ruční run, teprve pak cron.

Codex může použít přímo remote endpoint a bearer token z env:

```toml
[mcp_servers.siftera]
url = "https://YOUR_HOST/mcp"
bearer_token_env_var = "SIFTERA_AGENT_TOKEN"
required = true
```

Přesná konfigurace a CLI flags musí být otestovány s nainstalovanou verzí při M3, viz [OPERATIONS](OPERATIONS.md). Držet oddělené osobní agentní prostředí pouze s nástroji Siftery. Nevkládat aktuální token do ukázkové konfigurace v repozitáři.

Provider-neutral je backend kontrakt, ne záruka podpory v každém klientovi. Claude/cloud scheduler/OAuth flow není v MVP ověřený slib. Budoucí OAuth bude mapovat na stejný Principal a scopes.
