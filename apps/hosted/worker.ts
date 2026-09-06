import { EditorialService } from "../../packages/core/src/index.js";
import { D1Repository, R2ContentStore, type SqlDatabase, type ObjectBucket } from "../../packages/storage/src/cloudflare.js";
import { createPrototypeApi, type PrototypeAuxStore, type PrototypeSource } from "../../packages/prototype-api/src/index.js";
import { createDefaultConnectorRegistry, PublicArticleReader, SafeHttpClient, type ResolvedAddress } from "../../packages/connectors/src/index.js";

export interface HostedEnvironment {
  DB: SqlDatabase;
  CONTENT: ObjectBucket;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  /** Sdílené tajemství pro jediný účet prototypu. Bez něj API odmítne všechno. */
  API_TOKEN?: string;
  /** UID, pod kterým data patří vlastníkovi tokenu. */
  OWNER_UID?: string;
  /** Čárkou oddělené originy webu, který smí API volat z prohlížeče. */
  ALLOWED_ORIGINS?: string;
}

/** Porovnání tokenů v konstantním čase, aby délka odpovědi neprozradila shodu prefixu. */
function sameSecret(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}
export class D1SourceStore implements PrototypeAuxStore {
  constructor(private db: SqlDatabase) {}
  async listSources(uid: string) { const result = await this.db.prepare("SELECT data FROM siftera_sources WHERE uid=? ORDER BY id LIMIT 51").bind(uid).all<{data:string}>(); return result.results.map(row => JSON.parse(row.data) as PrototypeSource); }
  async getSource(uid: string,id: string) { const row = await this.db.prepare("SELECT data FROM siftera_sources WHERE uid=? AND id=?").bind(uid,id).first<{data:string}>(); return row ? JSON.parse(row.data) as PrototypeSource : null; }
  async putSource(uid: string,source: PrototypeSource) { await this.db.prepare("INSERT INTO siftera_sources(uid,id,data) VALUES(?,?,?) ON CONFLICT(uid,id) DO UPDATE SET data=excluded.data").bind(uid,source.id,JSON.stringify(source)).run(); }
  async deleteSource(uid: string,id: string) { await this.db.prepare("DELETE FROM siftera_sources WHERE uid=? AND id=?").bind(uid,id).run(); }
}

async function resolvePublicHost(hostname: string): Promise<ResolvedAddress[]> {
  const answers = await Promise.all(["A","AAAA"].map(async type => {
    const endpoint = new URL("https://cloudflare-dns.com/dns-query");
    endpoint.searchParams.set("name",hostname); endpoint.searchParams.set("type",type);
    const response = await fetch(endpoint,{headers:{accept:"application/dns-json"},signal:AbortSignal.timeout(5000)});
    if (!response.ok) throw new Error("DNS_LOOKUP_FAILED");
    const data = await response.json() as {Answer?: Array<{type:number;data:string}>};
    return (data.Answer ?? []).filter(answer => answer.type === 1 || answer.type === 28).map(answer => ({address:answer.data,family:answer.type === 1 ? 4 as const : 6 as const}));
  }));
  return answers.flat();
}

export default {
  async fetch(request: Request,env: HostedEnvironment): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return Response.json({status:"ok",application:"Siftera"});
    if (!url.pathname.startsWith("/api/")) {
      if (!env.ASSETS) return new Response("Static assets unavailable",{status:503});
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set("X-Content-Type-Options","nosniff");
      headers.set("Referrer-Policy","strict-origin-when-cross-origin");
      return new Response(response.body,{status:response.status,headers});
    }
    const repository = new D1Repository(env.DB);
    const contentStore = new R2ContentStore(env.CONTENT);
    const registry = createDefaultConnectorRegistry({http:new SafeHttpClient({fetch:(input,init)=>fetch(input,init),resolveHost:resolvePublicHost,maxBodyBytes:2*1024*1024,timeoutMs:12000})});
    const service = new EditorialService(repository,contentStore,{now:()=>new Date()},{next:()=>crypto.randomUUID()});
    const handler = createPrototypeApi({service,repository,contentStore,auxStore:new D1SourceStore(env.DB),
      articleReader: new PublicArticleReader(new SafeHttpClient({fetch:(input,init)=>fetch(input,init),resolveHost:resolvePublicHost,maxBodyBytes:2*1024*1024,timeoutMs:6000,maxRedirects:2})),
      allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean),
      resolvePrincipal: async req => {
        // Identita pochází ze sdíleného tajemství, ne z hlavičky, kterou si klient nastaví sám.
        const token = env.API_TOKEN;
        if (!token) return null;
        const header = req.headers.get("authorization") ?? "";
        const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
        if (!presented || !sameSecret(presented, token)) return null;
        return { principal: { uid: env.OWNER_UID ?? "owner", kind: "user", scopes: [] }, email: null };
      },
      // RSS a AI běží v lokálním procesu; Worker jen přijímá připravené dávky přes /ingest.
      // Ruční vložení odkazu zůstává, protože nestahuje nic zvenčí.
      connectors:{collect:async (pluginId,input) => {
        if (pluginId !== "manual") throw new Error("SOURCE_FETCH_IS_LOCAL");
        return registry.collect("manual",input);
      }},
    });
    return handler(request);
  },
};
