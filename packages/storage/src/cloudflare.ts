import { createHash } from "node:crypto";
import type { CandidateContent, PreferenceProfile, UserItemState } from "@siftera/shared";
import { candidateContentSchema } from "@siftera/shared";
import type { RepositoryPort, RepositoryRead, RepositoryTransaction, CandidateRecord, ContentStore, DraftData, SourceMetadata, StoredEditorialItem, FeedbackRecord, LibraryItem, RepositoryOperation, FeedPointer, RejectionRecord } from "@siftera/core";

export interface SqlResult<T = Record<string, unknown>> { results: T[]; meta: { changes?: number } }
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  run(): Promise<SqlResult>;
}
export interface SqlDatabase { prepare(sql: string): SqlStatement; batch(statements: SqlStatement[]): Promise<SqlResult[]> }
interface Row { collection: string; id: string; data: string; sort_key: string }
const copy = <T>(value: T): T => structuredClone(value);
const bounded = (limit: number) => { if (!Number.isInteger(limit) || limit < 1 || limit > 3000) throw new Error("Invalid query limit"); return limit; };
const digest = (input: string) => createHash("sha256").update(input).digest("hex");
const key = (collection: string, id: string) => `${collection}:${id}`;

class D1Read implements RepositoryRead {
  readonly pending = new Map<string, Row>();
  constructor(protected db: SqlDatabase, protected uid: string) { if (!uid) throw new Error("Missing identity"); }
  async get<T>(collection: string, id: string): Promise<T | null> {
    const row = this.pending.get(key(collection, id)) ?? await this.db.prepare("SELECT data FROM siftera_records WHERE uid=? AND collection=? AND id=?").bind(this.uid, collection, id).first<{data: string}>();
    if (!row) return null;
    const wrapped = JSON.parse(row.data) as { schemaVersion: number; value: T };
    if (wrapped.schemaVersion !== 1) throw new Error("Migration required");
    return copy(wrapped.value);
  }
  stage(collection: string, id: string, value: unknown, sort = "") {
    const data = JSON.stringify({schemaVersion: 1, value});
    if (new TextEncoder().encode(data).length > 800_000) throw new Error("Prototype record capacity exceeded");
    this.pending.set(key(collection, id), {collection, id, data, sort_key: sort});
  }
  async list<T>(collection: string, limit: number, since = ""): Promise<T[]> {
    const rows = await this.db.prepare("SELECT collection,id,data,sort_key FROM siftera_records WHERE uid=? AND collection=? AND sort_key>=? ORDER BY sort_key DESC,id ASC LIMIT ?").bind(this.uid, collection, since, bounded(limit)).all<Row>();
    const merged = new Map(rows.results.map(row => [row.id, row]));
    for (const row of this.pending.values()) if (row.collection === collection && row.sort_key >= since) merged.set(row.id, row);
    return [...merged.values()].sort((a,b) => b.sort_key.localeCompare(a.sort_key) || a.id.localeCompare(b.id)).slice(0, limit).map(row => {
      const wrapped = JSON.parse(row.data) as {schemaVersion: number; value: T};
      if (wrapped.schemaVersion !== 1) throw new Error("Migration required");
      return wrapped.value;
    });
  }
  getPreferences() { return this.get<PreferenceProfile>("preferences", "current"); }
  getCandidate(id: string) { return this.get<CandidateRecord>("candidates", id); }
  resolveIdentityKey(id: string) { return this.get<string>("identities", digest(id)); }
  getSourceMetadata(id: string) { return this.get<SourceMetadata>("sourceMetadata", id); }
  getRun(id: string) { return this.get<DraftData>("runs", id); }
  getState(id: string) { return this.get<UserItemState>("states", id); }
  getEditorialItem(id: string) { return this.get<StoredEditorialItem>("editorial", id); }
  getFeedback(id: string) { return this.get<FeedbackRecord>("feedback", id); }
  getLibraryItem(id: string) { return this.get<LibraryItem>("library", id); }
  getOperation(kind: RepositoryOperation["kind"], id: string) { return this.get<RepositoryOperation>("operations", digest(`${kind}\u0000${id}`)); }
  async getFeedPointer(): Promise<FeedPointer> { return await this.get<FeedPointer>("system", "feed") ?? {latestRunId: null, activeRunId: null, generation: 0}; }
  listCandidates(limit: number) { return this.list<CandidateRecord>("candidates", limit); }
  listLibrary(limit: number) { return this.list<LibraryItem>("library", limit); }
  listStates(limit: number) { return this.list<UserItemState>("states", limit); }
  listSourceMetadata(limit: number) { return this.list<SourceMetadata>("sourceMetadata", limit); }
  async listEditorialItems(ids: string[]) {
    if (!ids.length) return [];
    const unique = [...new Set(ids)].slice(0, 3000);
    const found: StoredEditorialItem[] = [];
    // D1 má strop na počet vazeb v jednom dotazu, takže se čte po dávkách místo po jedné položce.
    for (let index = 0; index < unique.length; index += 100) {
      const chunk = unique.slice(index, index + 100);
      const rows = await this.db
        .prepare(`SELECT data FROM siftera_records WHERE uid=? AND collection=? AND id IN (${chunk.map(() => "?").join(",")})`)
        .bind(this.uid, "editorial", ...chunk)
        .all<{ data: string }>();
      for (const row of rows.results) {
        const wrapped = JSON.parse(row.data) as { schemaVersion: number; value: StoredEditorialItem };
        if (wrapped.schemaVersion !== 1) throw new Error("Migration required");
        found.push(wrapped.value);
      }
    }
    for (const row of this.pending.values()) {
      if (row.collection !== "editorial" || !unique.includes(row.id)) continue;
      const wrapped = JSON.parse(row.data) as { schemaVersion: number; value: StoredEditorialItem };
      found.push(wrapped.value);
    }
    return found;
  }
  async listRecentEditorialMetadata(since: string, limit: number) {
    return (await this.list<StoredEditorialItem>("editorial", limit, since)).map(({candidateId,revision,producer,createdAt})=>({candidateId,revision,producer,createdAt}));
  }
  listRecentRejections(since: string, limit: number) { return this.list<RejectionRecord>("rejections", limit, since); }
}
class D1Transaction extends D1Read implements RepositoryTransaction {
  async putPreferences(value: PreferenceProfile) { this.stage("preferences", "current", value); this.stage("preferenceVersions", String(value.version), value); }
  async putCandidate(value: CandidateRecord) {
    this.stage("candidates", value.candidate.id, value, value.candidate.discoveredAt);
    const id = `${value.candidate.id}:${value.candidate.revision}`;
    if (!await this.get("revisions", id)) this.stage("revisions", id, value);
  }
  async putIdentityKey(id: string, value: string) { this.stage("identities", digest(id), value); }
  async putSourceMetadata(value: SourceMetadata) { this.stage("sourceMetadata", value.sourceId, value); }
  async putRun(value: DraftData) {
    if (value.proposals.length > 80 || value.contentReads.length > 40 || value.batches.length > 100) throw new Error("Run capacity exceeded");
    const current = await this.getRun(value.run.id);
    if (current?.run.status === "published" && JSON.stringify(current) !== JSON.stringify(value)) throw new Error("Published run is immutable");
    this.stage("runs", value.run.id, value, value.run.startedAt);
  }
  async putState(value: UserItemState) { this.stage("states", value.candidateId, value, value.updatedAt); }
  async putEditorialItem(value: StoredEditorialItem) {
    const previous = await this.getEditorialItem(value.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error("Editorial item is immutable");
    this.stage("editorial", value.id, value, value.createdAt);
  }
  async putLibraryItem(value: LibraryItem) { this.stage("library", value.candidateId, value, (await this.getEditorialItem(value.editorialItemId))?.createdAt ?? ""); }
  async putOperation(id: string, value: RepositoryOperation) { this.stage("operations", digest(`${value.kind}\u0000${id}`), value); }
  async putFeedPointer(value: FeedPointer) { this.stage("system", "feed", value); }
  async putFeedback(value: FeedbackRecord) { this.stage("feedback", value.feedback.id, value, value.feedback.createdAt); }
  async putRejections(values: RejectionRecord[]) { for (const value of values) this.stage("rejections", digest(JSON.stringify(value)), value, value.rejectedAt); }
}

/** Optimistic tenant epoch: every queued statement and the epoch increment share one atomic D1 batch. */
export class D1Repository implements RepositoryPort {
  constructor(private db: SqlDatabase) {}
  async read<T>(uid: string, work: (tx: RepositoryRead) => T | Promise<T>): Promise<T> { return copy(await work(new D1Read(this.db, uid))); }
  async transaction<T>(uid: string, work: (tx: RepositoryTransaction) => T | Promise<T>): Promise<T> {
    if (!uid) throw new Error("Missing identity");
    await this.db.prepare("INSERT OR IGNORE INTO siftera_epochs(uid,version) VALUES(?,0)").bind(uid).run();
    for (let attempt = 0; attempt < 5; attempt++) {
      const version = (await this.db.prepare("SELECT version FROM siftera_epochs WHERE uid=?").bind(uid).first<{version: number}>())!.version;
      const tx = new D1Transaction(this.db, uid);
      const result = await work(tx);
      const statements = [...tx.pending.values()].map(row => this.db.prepare("INSERT INTO siftera_records(uid,collection,id,data,sort_key) SELECT ?,?,?,?,? WHERE (SELECT version FROM siftera_epochs WHERE uid=?)=? ON CONFLICT(uid,collection,id) DO UPDATE SET data=excluded.data,sort_key=excluded.sort_key").bind(uid,row.collection,row.id,row.data,row.sort_key,uid,version));
      statements.push(this.db.prepare("UPDATE siftera_epochs SET version=version+1 WHERE uid=? AND version=?").bind(uid,version));
      const outcomes = await this.db.batch(statements);
      if (outcomes.at(-1)?.meta.changes === 1) return copy(result);
    }
    throw new Error("Concurrent update; please retry");
  }
}

export interface ObjectResult { etag: string; text(): Promise<string> }
export interface ObjectBucket {
  get(key: string): Promise<ObjectResult | null>;
  put(key: string, value: string, options?: {onlyIf?: {etagMatches?: string; etagDoesNotMatch?: string}; httpMetadata?: {contentType: string}}): Promise<unknown | null>;
}
/** Conditional writes preserve full text while allowing the first hydration of a revision. */
export class R2ContentStore implements ContentStore {
  constructor(private bucket: ObjectBucket) {}
  private key(uid: string,id: string,revision: number) { return `users/${digest(uid)}/content/${digest(id)}/${revision}`; }
  async get(uid: string,id: string,revision: number) { const value = await this.bucket.get(this.key(uid,id,revision)); return value ? candidateContentSchema.parse(JSON.parse(await value.text())) : null; }
  async put(uid: string,content: CandidateContent) {
    const parsed = candidateContentSchema.parse(content);
    const key = this.key(uid,parsed.candidateId,parsed.revision);
    for (let attempt=0; attempt<4; attempt++) {
      const object = await this.bucket.get(key);
      if (object) {
        const prior = candidateContentSchema.parse(JSON.parse(await object.text()));
        if (prior.contentHash === parsed.contentHash && prior.access === parsed.access && prior.truncated === parsed.truncated) return;
        if (prior.access === "full" || parsed.access !== "full") throw new Error("Content revision conflict");
      }
      const result = await this.bucket.put(key,JSON.stringify(parsed),{onlyIf:object ? {etagMatches:object.etag} : {etagDoesNotMatch:"*"},httpMetadata:{contentType:"application/json"}});
      if (result !== null) return;
    }
    throw new Error("Concurrent content update; please retry");
  }
}
