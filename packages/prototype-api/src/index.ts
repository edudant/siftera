import {
  EditorialService,
  SifteraError,
  canonicalizeUrl,
  type ContentStore,
  type ArticleReader,
  type ArticleRead,
  type IngestInput,
  type RepositoryPort,
} from "@siftera/core";
import {
  editorialSubmissionSchema,
  idSchema,
  mediaMetaSchema,
  mediumSchema,
  preferenceSchema,
  type Candidate,
  type CandidateContent,
  type EditorialSubmission,
  type FeedRun,
  type PreferenceProfile,
  type Principal,
  type UserItemState,
} from "@siftera/shared";
import { z, type ZodType } from "zod";
import { editorInstructions, EDITOR_PROMPT_VERSION } from "./editor-prompt.js";
import { editorialSubmissionJsonSchema } from "./editorial-schema.js";

const MAX_JSON_BYTES = 1_048_576;
const MAX_EDITOR_TEXT = 1_000_000;
const MAX_SOURCES = 50;
const MAX_REFRESH_INPUTS = 25;
const sourceIdSchema = idSchema;
const groupSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const sourceSchema = z
  .object({
    id: sourceIdSchema,
    name: z.string().min(1).max(200),
    url: z.string().url().max(2048),
    pluginId: z.literal("rss"),
    groups: z.array(groupSchema).max(10),
    deliveryMode: z.enum(["curated", "all"]),
    imageMode: z.enum(["auto", "large", "small", "none"]).default("auto"),
    enabled: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    lastFetchedAt: z.string().datetime({ offset: true }).nullable(),
    lastError: z.string().max(500).nullable(),
  })
  .strict();
export type PrototypeSource = z.infer<typeof sourceSchema>;

/** Owner-scoped source configs stay out of core's portable SourceMetadata. */
export interface PrototypeAuxStore {
  listSources(uid: string): Promise<PrototypeSource[]>;
  getSource(uid: string, sourceId: string): Promise<PrototypeSource | null>;
  putSource(uid: string, source: PrototypeSource): Promise<void>;
  deleteSource(uid: string, sourceId: string): Promise<void>;
}

export interface ResolvedPrincipal {
  principal: Principal;
  email: string | null;
}

export interface PrototypeConnectorResult {
  inputs: IngestInput[];
  complete?: boolean;
  errors?: string[];
}

/** A deliberately small boundary; connectors own fetching and normalization. */
export interface PrototypeConnectorRegistry {
  collect(
    pluginId: "rss" | "manual",
    request: {
      sourceId: string;
      sourceName: string;
      groups?: string[];
      deliveryMode?: "curated" | "all";
      imageMode?: "auto" | "large" | "small" | "none";
      url: string;
      title?: string;
      text?: string;
      access?: Candidate["access"];
    },
  ): Promise<PrototypeConnectorResult>;
}

export interface PrototypeApiDependencies {
  service: EditorialService;
  repository: RepositoryPort;
  contentStore: ContentStore;
  auxStore: PrototypeAuxStore;
  resolvePrincipal(request: Request): Promise<ResolvedPrincipal | null>;
  connectors?: PrototypeConnectorRegistry;
  articleReader?: ArticleReader;
  createId?: () => string;
  /** Originy webu, který smí API volat z prohlížeče. Bez nich API funguje jen ze stejné domény. */
  allowedOrigins?: string[];
}

const now = () => new Date().toISOString();
const publicSource = ({ id, name, url, pluginId, groups, deliveryMode, imageMode, enabled, createdAt, lastFetchedAt, lastError }: PrototypeSource) =>
  ({ id, name, url, pluginId, groups, deliveryMode, imageMode, enabled, createdAt, lastFetchedAt, lastError });
const systemFor = (principal: Principal): Principal => ({
  uid: principal.uid,
  kind: "system",
  scopes: [],
});
/** Doplněk instrukcí, když si uživatel zapnul behaviorEnabled (ADR-015). Signál je slabý a nesmí přebít preference. */
const behaviorNote = `Pole recentlyIgnored obsahuje nedávno vydané položky, které uživateli prošly před očima a nechal je být. Je to slabý a zašuměný signál, ne rozhodnutí uživatele: mohl jen scrollovat kolem. Používej ho na úhel a opakování — když už podobná zpráva prošla bez zájmu, dej přednost jinému úhlu nebo jinému tématu. Nevyřazuj kvůli němu celé téma ani zdroj, nikdy jím nepřebíjej výslovné preference a nikdy z něj nevyvozuj trvalý nezájem.`;


function generatedId(): string {
  const candidate = globalThis.crypto?.randomUUID?.().replace(/-/gu, "_");
  if (!candidate || !idSchema.safeParse(candidate).success)
    throw new Error("A runtime-safe createId dependency is required");
  return candidate;
}
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
      : entry,
  );
}
async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stable(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function response(value: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: {
      ...(status === 204 ? {} : { "content-type": "application/json; charset=utf-8" }),
      "cache-control": "private, no-store",
    },
  });
}
type ValidationDetail = { field: string; reason: string };

function apiError(code: string, message: string, status: number, details?: ValidationDetail[]): Response {
  return response({ error: { code, message, ...(details?.length ? { details } : {}) } }, status);
}
function errorStatus(code: string): number {
  if (code === "UNAUTHENTICATED") return 401;
  if (code === "FORBIDDEN") return 403;
  if (code === "NOT_FOUND") return 404;
  if (code === "CSRF_REJECTED") return 403;
  if (code === "UNSUPPORTED_MEDIA_TYPE") return 415;
  if (code === "PAYLOAD_TOO_LARGE") return 413;
  if (code.startsWith("STALE_") || code === "IDEMPOTENCY_CONFLICT") return 409;
  return 400;
}
function validationDetails(error: z.ZodError): ValidationDetail[] {
  return error.issues.slice(0, 10).map((issue) => {
    const field = issue.path.map(String).join(".") || "body";
    if (field === "url") return { field, reason: "Zadejte platnou adresu RSS nebo Atom zdroje včetně https://." };
    if (field === "name") return { field, reason: "Zadejte název zdroje." };
    if (field === "groups" || field.startsWith("groups.")) return { field, reason: "Skupina musí po úpravě obsahovat písmena nebo čísla." };
    return { field, reason: "Zkontrolujte hodnotu tohoto pole." };
  });
}
function requestError(error: unknown): Response {
  if (error instanceof z.ZodError) {
    const details = validationDetails(error);
    return apiError("INVALID_REQUEST", details[0]?.reason ?? "Zkontrolujte zadané údaje.", 400, details);
  }
  if (error instanceof SifteraError)
    return apiError(error.code, error.message, errorStatus(error.code));
  return apiError("INTERNAL", "The request could not be completed.", 500);
}
/**
 * Origin musí sedět buď na samotné API (klasické same-origin nasazení), nebo na výslovně povolený web.
 * Chybějící Origin je server-to-server volání (lokální ingest), které prohlížeč neposílá.
 */
function originAllowed(request: Request, allowed: Set<string>): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return allowed.size > 0;
  try {
    const value = new URL(origin).origin;
    return value === new URL(request.url).origin || allowed.has(value);
  } catch { return false; }
}
function corsHeaders(request: Request, allowed: Set<string>): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !allowed.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization,content-type,accept",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
async function jsonBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const type = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!type.includes("application/json")) throw new SifteraError("UNSUPPORTED_MEDIA_TYPE");
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/u.test(length) || Number(length) > MAX_JSON_BYTES))
    throw new SifteraError("PAYLOAD_TOO_LARGE");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES)
    throw new SifteraError("PAYLOAD_TOO_LARGE");
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new SifteraError("INVALID_JSON"); }
  return schema.parse(parsed);
}
function assertMutation(request: Request, allowed: Set<string>): void {
  if (!originAllowed(request, allowed)) throw new SifteraError("CSRF_REJECTED");
}
function route(pathname: string): string[] | null {
  const prefix = "/api/v1/";
  if (!pathname.startsWith(prefix)) return null;
  return pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
}
const articleRequest = z.object({ url: z.string().url().max(2048), title: z.string().min(1).max(500).optional(), text: z.string().max(200_000).optional(), fullText: z.boolean().optional().default(false) }).strict().refine((value) => !value.fullText || value.text !== undefined, { message: "fullText requires text", path: ["text"] });
/** Groups are filter identifiers in storage, but the form accepts Czech free text. */
function normalizeGroup(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("cs-CZ")
    .trim()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug === "skola" ? "school" : slug;
}
const sourceGroupInputSchema = z.string().max(200).transform(normalizeGroup).pipe(groupSchema);
const sourceCreateRequest = z.object({ name: z.string().trim().min(1).max(200), url: z.string().trim().url().max(2048), pluginId: z.literal("rss"), groups: z.array(sourceGroupInputSchema).max(10).optional(), deliveryMode: z.enum(["curated", "all"]).optional(), imageMode: z.enum(["auto", "large", "small", "none"]).optional() }).strict();
const sourcePatchRequest = z.object({ enabled: z.boolean().optional(), name: z.string().trim().min(1).max(200).optional(), groups: z.array(sourceGroupInputSchema).max(10).optional(), imageMode: z.enum(["auto", "large", "small", "none"]).optional() }).strict().refine((value) => Object.keys(value).length > 0);
const preferenceRequest = z.object({ preferences: preferenceSchema, expectedVersion: z.number().int().min(1) }).strict();
const stateRequest = z.object({ patch: z.object({ read: z.boolean().optional(), saved: z.boolean().optional(), hidden: z.boolean().optional() }).strict().refine((value) => Object.keys(value).length > 0), expectedVersion: z.number().int().nonnegative(), operationId: idSchema }).strict();
const ingestRequest = z.object({
  sourceId: idSchema,
  sourceName: z.string().min(1).max(200),
  groups: z.array(groupSchema).max(10).optional(),
  deliveryMode: z.enum(["curated", "all"]).optional(),
  items: z.array(z.object({
    url: z.string().url().max(2048),
    title: z.string().min(1).max(500),
    excerpt: z.string().max(10_000).optional(),
    body: z.string().max(200_000).nullable().optional(),
    publishedAt: z.string().datetime().nullable().optional(),
    categories: z.array(z.string().max(80)).max(30).optional(),
    image: z.object({ url: z.string().url().max(2048), width: z.number().int().positive().nullable(), height: z.number().int().positive().nullable(), alt: z.string().max(500) }).strict().nullable().optional(),
    externalId: z.string().max(500).nullable().optional(),
    medium: mediumSchema.optional(),
    media: mediaMetaSchema.nullable().optional(),
  }).strict()).min(1).max(100),
}).strict();
const seenRequest = z.object({ candidateIds: z.array(idSchema).min(1).max(200) }).strict();
const editorExportRequest = z.object({ operationId: idSchema }).strict();
const editorEnrichRequest = z.object({ runId: idSchema, candidateIds: z.array(idSchema).min(1).max(4).refine(ids => new Set(ids).size === ids.length) }).strict();
const editorImportRequest = z.object({
  submission: editorialSubmissionSchema.optional(),
  submissions: z.array(editorialSubmissionSchema).min(1).max(8).optional(),
  orderedCandidateIds: z.array(idSchema).max(50).refine(items => new Set(items).size === items.length),
  operationId: idSchema,
}).strict().superRefine((value, ctx) => {
  const batches = value.submissions ?? (value.submission ? [value.submission] : []);
  const selected = batches.flatMap(batch => batch.items.map(item => item.candidate.candidateId));
  const rejected = batches.flatMap(batch => batch.rejected.map(item => item.candidate.candidateId));
  if (Boolean(value.submission) === Boolean(value.submissions) || !batches.length
    || new Set(batches.map(batch => batch.runId)).size !== 1
    || new Set(batches.map(batch => batch.batchId)).size !== batches.length
    || new Set(batches.map(batch => JSON.stringify(batch.editor))).size !== 1
    || selected.length > 50 || new Set([...selected, ...rejected]).size !== selected.length + rejected.length
    || value.orderedCandidateIds.some(id => !selected.includes(id))) {
    ctx.addIssue({code: z.ZodIssueCode.custom, message: "Invalid editorial batch set"});
  }
});
const editorAbortRequest = z.object({ runId: idSchema }).strict();

export function createPrototypeApi(dependencies: PrototypeApiDependencies) {
  const { service, repository, contentStore, auxStore, resolvePrincipal, connectors } = dependencies;
  // Povolené originy UI. Prázdný seznam = API běží na stejné doméně jako klient (lokální vývoj).
  const allowedOrigins = new Set(dependencies.allowedOrigins ?? []);
  // Keep the explicit contentStore dependency visible at the API boundary: storage
  // is injected with repository/service, never reached through a global provider.
  void contentStore;
  const createId = dependencies.createId ?? generatedId;
  const syncSourceMetadata = async (uid: string, source: PrototypeSource, archivedAt: string | null = null) => {
    await repository.transaction(uid, (tx) => tx.putSourceMetadata({
      sourceId: source.id,
      sourceName: source.name,
      groups: source.groups,
      deliveryMode: source.deliveryMode,
      enabled: source.enabled,
      archivedAt,
      includeKeywords: [],
      excludeKeywords: [],
    }));
  };

  return async function prototypeApi(request: Request): Promise<Response> {
    const cors = corsHeaders(request, allowedOrigins);
    // Preflight musí projít dřív než autentizace: prohlížeč na něj hlavičku s tokenem neposílá.
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const withCors = (response: Response): Response => {
      if (!Object.keys(cors).length) return response;
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) headers.set(key, value);
      return new Response(response.body, { status: response.status, headers });
    };
    const segments = route(new URL(request.url).pathname);
    if (!segments) return withCors(apiError("NOT_FOUND", "Unknown endpoint.", 404));
    let resolved: ResolvedPrincipal | null;
    try { resolved = await resolvePrincipal(request); }
    catch { return withCors(apiError("UNAUTHENTICATED", "Authentication failed.", 401)); }
    if (!resolved || !resolved.principal.uid) return withCors(apiError("UNAUTHENTICATED", "Authentication is required.", 401));
    if (resolved.principal.kind === "agent") return withCors(apiError("FORBIDDEN", "This prototype API accepts user sessions only.", 403));
    const principal = resolved.principal;

    try {
      if (request.method === "GET" && segments.join("/") === "bootstrap") {
        const [preferences, feed, stream, library, sources] = await Promise.all([
          service.getPreferences(principal),
          service.latestFeed(principal),
          service.unreadStream(principal),
          service.libraryFeed(principal),
          auxStore.listSources(principal.uid),
        ]);
        return withCors(response({
          user: { id: principal.uid, email: resolved.email },
          preferences, feed, stream, library,
          sources: sources.map(publicSource),
          plugins: [{ id: "rss", label: "RSS / Atom" }, { id: "manual", label: "Manual article" }],
        }));
      }

      if (request.method === "GET" && segments.join("/") === "pending") {
        const pending = await service.pendingCandidates(principal);
        const [inbox, hidden] = await repository.read(principal.uid, async (tx) => {
          const [records, states] = await Promise.all([tx.listCandidates(300), tx.listStates(3000)]);
          const byCandidate = new Map(states.map((entry) => [entry.candidateId, entry]));
          const withState = (candidate: Candidate) => ({ candidate, state: byCandidate.get(candidate.id) ?? initialState(candidate) });
          const hiddenEntries = records
            .map(({ candidate }) => {
              const state = byCandidate.get(candidate.id);
              return state?.hidden ? { candidate, state } : null;
            })
            .filter((entry) => entry !== null);
          return [pending.map(withState), hiddenEntries] as const;
        });
        return withCors(response({ inbox, hidden }));
      }

      if (request.method === "POST" && segments.join("/") === "ingest") {
        assertMutation(request, allowedOrigins);
        const body = await jsonBody(request, ingestRequest);
        let created = 0;
        let revised = 0;
        const errors: string[] = [];
        for (const entry of body.items) {
          try {
            const result = await service.ingest(principal, {
              sourceId: body.sourceId,
              sourceName: body.sourceName,
              groups: body.groups ?? [],
              deliveryMode: body.deliveryMode ?? "curated",
              url: entry.url,
              title: entry.title,
              excerpt: entry.excerpt ?? "",
              body: entry.body ?? null,
              publishedAt: entry.publishedAt ?? null,
              categories: entry.categories ?? [],
              image: entry.image ?? null,
              media: entry.media ?? null,
              medium: entry.medium ?? "text",
              externalId: entry.externalId ?? null,
              access: entry.body ? "partial" : "unavailable",
            });
            if (result.created) created += 1;
            else if (result.revised) revised += 1;
          } catch (error) {
            errors.push(error instanceof Error ? error.message.slice(0, 200) : "Ingest failed");
          }
        }
        return withCors(response({ received: body.items.length, created, revised, errors: errors.slice(0, 10) }));
      }

      if (request.method === "POST" && segments.join("/") === "items/seen") {
        assertMutation(request, allowedOrigins);
        const body = await jsonBody(request, seenRequest);
        return withCors(response({ marked: await service.markSeen(principal, body.candidateIds) }));
      }

      if (request.method === "POST" && segments.join("/") === "articles") {
        assertMutation(request, allowedOrigins);
        const body = await jsonBody(request, articleRequest);
        const normalizedUrl = canonicalizeUrl(body.url);
        const title = body.title ?? new URL(normalizedUrl).hostname;
        const source = { sourceId: "manual", sourceName: "Manual", groups: [], deliveryMode: "curated" as const };
        const access: Candidate["access"] = body.fullText ? "full" : "partial";
        const collected = connectors
          ? await connectors.collect("manual", { ...source, url: normalizedUrl, ...(body.title ? { title: body.title } : {}), ...(body.text !== undefined ? { text: body.text } : {}), access })
          : { inputs: [{ sourceId: source.sourceId, sourceName: source.sourceName, url: normalizedUrl, title, body: body.text ?? null, access }] };
        const input = collected.inputs[0];
        if (!input) throw new SifteraError("INVALID_ARTICLE");
        const result = await service.ingest(principal, { ...input, sourceId: source.sourceId, sourceName: source.sourceName, groups: [], deliveryMode: "curated", url: normalizedUrl, title });
        return withCors(response({ candidate: result.candidate }, 201));
      }

      if (segments[0] === "sources") {
        if (request.method === "POST" && segments.length === 1) {
          assertMutation(request, allowedOrigins);
          const body = await jsonBody(request, sourceCreateRequest);
          if ((await auxStore.listSources(principal.uid)).length >= MAX_SOURCES)
            throw new SifteraError("SOURCE_LIMIT");
          const stamp = now();
          const source = sourceSchema.parse({ id: createId(), name: body.name, url: canonicalizeUrl(body.url), pluginId: body.pluginId, groups: body.groups ?? [], deliveryMode: body.deliveryMode ?? "curated", imageMode: body.imageMode ?? "auto", enabled: true, createdAt: stamp, lastFetchedAt: null, lastError: null });
          await auxStore.putSource(principal.uid, source);
          await syncSourceMetadata(principal.uid, source);
          return withCors(response(publicSource(source), 201));
        }
        const sourceId = segments[1];
        if (!sourceId || !idSchema.safeParse(sourceId).success) throw new SifteraError("NOT_FOUND");
        if (request.method === "PATCH" && segments.length === 2) {
          assertMutation(request, allowedOrigins);
          const body = await jsonBody(request, sourcePatchRequest);
          const current = await auxStore.getSource(principal.uid, sourceId);
          if (!current) throw new SifteraError("NOT_FOUND");
          const next = sourceSchema.parse({ ...current, ...body });
          await auxStore.putSource(principal.uid, next);
          await syncSourceMetadata(principal.uid, next);
          return withCors(response(publicSource(next)));
        }
        if (request.method === "DELETE" && segments.length === 2) {
          assertMutation(request, allowedOrigins);
          const source = await auxStore.getSource(principal.uid, sourceId);
          if (!source) throw new SifteraError("NOT_FOUND");
          await auxStore.deleteSource(principal.uid, sourceId);
          await syncSourceMetadata(principal.uid, { ...source, enabled: false }, now());
          return withCors(response(null, 204));
        }
        if (request.method === "POST" && segments[2] === "refresh" && segments.length === 3) {
          assertMutation(request, allowedOrigins);
          await jsonBody(request, z.object({}).strict());
          const source = await auxStore.getSource(principal.uid, sourceId);
          if (!source) throw new SifteraError("NOT_FOUND");
          if (!source.enabled) throw new SifteraError("SOURCE_DISABLED");
          if (!connectors) throw new SifteraError("CONNECTOR_UNAVAILABLE");
          let collected: PrototypeConnectorResult;
          try {
            collected = await connectors.collect("rss", { sourceId: source.id, sourceName: source.name, groups: source.groups, deliveryMode: source.deliveryMode, url: source.url });
          } catch {
            await auxStore.putSource(principal.uid, sourceSchema.parse({ ...source, lastFetchedAt: now(), lastError: "REFRESH_UNAVAILABLE" }));
            return withCors(response({ ingested: 0, errors: ["Načítání zdrojů běží v lokálním procesu, ne na serveru. Spusťte lokální ingest."] }));
          }
          let ingested = 0;
          const errors = [...(collected.errors ?? [])];
          // Useknutí na MAX_REFRESH_INPUTS je vlastnost prototypu, ne chyba zdroje: nese ho `complete`, do lastError nepatří.
          const truncated = !collected.complete || collected.inputs.length > MAX_REFRESH_INPUTS;
          for (const input of collected.inputs.slice(0, MAX_REFRESH_INPUTS)) {
            try {
              await service.ingest(principal, { ...input, sourceId: source.id, sourceName: source.name, groups: source.groups, deliveryMode: source.deliveryMode });
              ingested += 1;
            } catch (error) { errors.push(error instanceof Error ? error.message.slice(0, 500) : "Ingest failed"); }
          }
          const next = sourceSchema.parse({ ...source, lastFetchedAt: now(), lastError: errors[0] ?? null });
          await auxStore.putSource(principal.uid, next);
          return withCors(response({ ingested, errors, complete: !truncated }));
        }
      }

      if (request.method === "PUT" && segments.join("/") === "preferences") {
        assertMutation(request, allowedOrigins);
        const body = await jsonBody(request, preferenceRequest);
        const value = Object.fromEntries(
          Object.entries(body.preferences).filter(([key]) => key !== "version" && key !== "updatedAt"),
        ) as Omit<PreferenceProfile, "version" | "updatedAt">;
        const preferences = await service.savePreferences(principal, body.expectedVersion, value);
        return withCors(response(preferences));
      }

      if (request.method === "PATCH" && segments[0] === "items" && segments[2] === "state" && segments.length === 3) {
        assertMutation(request, allowedOrigins);
        const candidateId = segments[1];
        if (!candidateId || !idSchema.safeParse(candidateId).success) throw new SifteraError("NOT_FOUND");
        const body = await jsonBody(request, stateRequest);
        const patch = Object.fromEntries(
          Object.entries(body.patch).filter(([, value]) => value !== undefined),
        ) as Partial<Pick<UserItemState, "read" | "saved" | "hidden">>;
        return withCors(response(await service.patchState(principal, candidateId, body.expectedVersion, patch, body.operationId)));
      }

      if (segments[0] === "editor") {
        const editorPrincipal = systemFor(principal);
        if (request.method === "POST" && segments[1] === "export" && segments.length === 2) {
          assertMutation(request, allowedOrigins);
          const body = await jsonBody(request, editorExportRequest);
          const run = await service.beginRun(editorPrincipal, body.operationId);
          const draft = await service.editorSnapshot(editorPrincipal, run.id);
          const preference = draft.preference;
          if ((await service.getPreferences(principal)).version !== preference.version) throw new SifteraError("STALE_PREFERENCES");
          let characters = 0;
          let contentReads = 0;
          const sources = await auxStore.listSources(principal.uid);
          const candidates = [];
          for (const ref of run.candidateRefs) {
            const record = await repository.read(principal.uid, tx => tx.getCandidate(ref.candidateId));
            if (!record || record.candidate.revision !== ref.revision) throw new SifteraError("CANDIDATE_CHANGED");
            const state = await repository.read(principal.uid, tx => tx.getState(ref.candidateId)) ?? initialState(record.candidate);
            let content: CandidateContent | null = null;
            let fullTextReceipt = false;
            if (record.candidate.contentHash && contentReads < preference.contentReadLimit) {
              const stored = await contentStore.get(principal.uid, ref.candidateId, ref.revision);
              if (stored && characters + stored.text.length <= MAX_EDITOR_TEXT) {
                if (!stored.truncated && stored.access === "full") {
                  content = await service.readRunContent(editorPrincipal, run.id, ref.candidateId, ref.revision);
                  fullTextReceipt = true;
                } else content = { ...stored, text: stored.text.slice(0, 12_000), truncated: stored.truncated || stored.text.length > 12_000 };
                characters += content.text.length;
                contentReads += 1;
              }
            }
            const source = sources.find(source => source.id === record.candidate.sourceId);
            const published = Date.parse(record.candidate.publishedAt ?? record.candidate.discoveredAt);
            const cutoff = Date.parse(run.startedAt);
            const effective = published > cutoff + 86_400_000 ? Date.parse(record.candidate.discoveredAt) : published;
            const articleRead = draft.articleReads?.find(read => read.candidateId === ref.candidateId) ?? null;
            candidates.push({ candidate: record.candidate, state, ageDays: Math.max(0, (cutoff - effective) / 86_400_000),
              source: { name: source?.name ?? record.candidate.sourceId, imageMode: source?.imageMode ?? "auto" },
              content, fullTextReceipt, articleRead: articleRead && fullTextReceipt ? { ...articleRead, text: "" } : articleRead });
          }
          const history = (await service.libraryFeed(principal))
            .sort((a,b) => b.item.createdAt.localeCompare(a.item.createdAt))
            .slice(0, 40).map(entry => ({ candidateId: entry.item.candidate.candidateId, headline: entry.item.headline,
              summary: entry.item.summary.slice(0, 400), topics: entry.item.topics, sourceName: entry.item.provenance[0]?.sourceName,
              createdAt: entry.item.createdAt, state: entry.state }));
          // Signál podle ADR-015 patří k tomu, co už bylo vydáno: kandidát v jobu uživateli ještě před očima být nemohl.
          const ignored = preference.behaviorEnabled
            ? (await service.unreadStream(principal, 14))
                .filter((entry) => entry.state.seenAt && !entry.state.saved)
                .slice(0, 30)
                .map((entry) => ({ headline: entry.item.headline, topics: entry.item.topics, sourceName: entry.item.provenance[0]?.sourceName ?? null, publishedAt: entry.item.provenance[0]?.publishedAt ?? null }))
            : [];
          return withCors(response({
            run,
            preferences: preference,
            candidates,
            promptVersion: EDITOR_PROMPT_VERSION,
            history,
            knownTopics: [...new Set([...preference.preferredTopics, ...history.flatMap(entry => entry.topics)])].slice(0, 60),
            recommendedShortlistCandidateIds: candidates.filter(entry => !entry.fullTextReceipt && !entry.articleRead && !entry.state.hidden).slice(0, Math.min(12, preference.contentReadLimit)).map(entry => entry.candidate.id),
            budgets: { maxSelected: Math.min(50, preference.targetItems), originalReadLimit: Math.min(20, preference.contentReadLimit), originalReadsUsed: draft.articleReads?.length ?? 0, batchSize: 10 },
            ...(preference.behaviorEnabled ? { recentlyIgnored: ignored } : {}),
            instructions: preference.behaviorEnabled ? `${editorInstructions}\n\n${behaviorNote}` : editorInstructions,
            schema: editorialSubmissionJsonSchema,
          }));
        }
        if (request.method === "POST" && segments[1] === "enrich" && segments.length === 2) {
          assertMutation(request, allowedOrigins);
          const body = await jsonBody(request, editorEnrichRequest);
          if (!dependencies.articleReader) throw new SifteraError("CONNECTOR_UNAVAILABLE");
          const reads: ArticleRead[] = [];
          // Sequential DB reservations avoid concurrent tenant epoch conflicts.
          for (const id of body.candidateIds) reads.push(await service.readOriginal(editorPrincipal, body.runId, id, dependencies.articleReader));
          return withCors(response({ reads }));
        }
        if (request.method === "POST" && segments[1] === "import" && segments.length === 2) {
          assertMutation(request, allowedOrigins);
          const body = await jsonBody(request, editorImportRequest);
          const batches = body.submissions ?? [body.submission!];
          const runId = batches[0]!.runId;
          const existing = await repository.read(principal.uid, tx => tx.getRun(runId));
          for (const batch of batches) {
            if (existing?.run.status === "published") {
              const prior = existing.batches.find(item => item.batchId === batch.batchId);
              if (!prior || prior.payloadHash !== await hash(batch)) throw new SifteraError("IDEMPOTENCY_CONFLICT");
            } else await service.submit(editorPrincipal, batch);
          }
          return withCors(response(await service.publish(editorPrincipal, runId, body.operationId, body.orderedCandidateIds)));
        }
        if (request.method === "POST" && segments[1] === "abort" && segments.length === 2) {
          assertMutation(request, allowedOrigins);
          const body = await jsonBody(request, editorAbortRequest);
          return withCors(response(await service.abort(editorPrincipal, body.runId)));
        }
      }
      return withCors(apiError("NOT_FOUND", "Unknown endpoint.", 404));
    } catch (error) { return withCors(requestError(error)); }
  };
}

function initialState(candidate: Candidate): UserItemState {
  return { candidateId: candidate.id, read: false, saved: false, hidden: false, seenAt: null, version: 0, updatedAt: candidate.discoveredAt };
}

/** A test-only, process-local adapter. Production wiring must use durable storage. */
export class MemoryPrototypeAuxStore implements PrototypeAuxStore {
  private readonly users = new Map<string, Map<string, PrototypeSource>>();
  async listSources(uid: string): Promise<PrototypeSource[]> { return structuredClone([...this.forUser(uid).values()]); }
  async getSource(uid: string, sourceId: string): Promise<PrototypeSource | null> { return structuredClone(this.forUser(uid).get(sourceId) ?? null); }
  async putSource(uid: string, source: PrototypeSource): Promise<void> { this.forUser(uid).set(source.id, structuredClone(source)); }
  async deleteSource(uid: string, sourceId: string): Promise<void> { this.forUser(uid).delete(sourceId); }
  private forUser(uid: string): Map<string, PrototypeSource> { let sources = this.users.get(uid); if (!sources) { sources = new Map(); this.users.set(uid, sources); } return sources; }
}

export type { EditorialSubmission, FeedRun, PreferenceProfile };
