import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { CandidateContent, UserItemState } from "@siftera/shared";
import { candidateContentSchema } from "@siftera/shared";
import type {
  CandidateRecord,
  ContentReadReceipt,
  ContentStore,
  DraftBatch,
  DraftData,
  EditorialMetadata,
  FeedPointer,
  FeedbackRecord,
  LibraryItem,
  RepositoryOperation,
  RepositoryPort,
  RepositoryRead,
  RepositoryTransaction,
  RejectionRecord,
  SourceMetadata,
  StoredEditorialItem,
} from "@siftera/core";
import { FieldPath, type Firestore, type DocumentReference, type Transaction } from "firebase-admin/firestore";
import type { Storage } from "firebase-admin/storage";

type Bucket = ReturnType<Storage["bucket"]>;

const SCHEMA_VERSION = 1;
const MAX_LIST = 3000;
const clone = <T>(value: T): T => structuredClone(value);

const bounded = (limit: number): number => {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST)
    throw new RangeError(`limit must be an integer between 1 and ${MAX_LIST}`);
  return limit;
};

/** Firebase UIDs are opaque, but may never select another document path. */
const segment = (value: string, label: string): string => {
  if (!value || value.length > 128 || value === "." || value === ".." || value.includes("/") || value.includes("\\"))
    throw new Error(`invalid ${label}`);
  return value;
};

const contentPath = (uid: string, candidateId: string, revision: number): string => {
  const safeUid = segment(uid, "uid");
  const safeCandidate = segment(candidateId, "candidateId");
  if (!Number.isInteger(revision) || revision < 1) throw new Error("invalid revision");
  return `users/${safeUid}/content/${safeCandidate}/${revision}.json.gz`;
};

interface Wrapped<T> { schemaVersion: number; data: T }
const wrapped = <T>(data: T): Wrapped<T> => ({ schemaVersion: SCHEMA_VERSION, data: clone(data) });
const unwrap = <T>(value: unknown): T | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Wrapped<T>>;
  if (candidate.schemaVersion !== SCHEMA_VERSION || candidate.data === undefined)
    throw new Error("unsupported Firestore schema version; migration is required");
  return clone(candidate.data);
};

type Pending = { ref: DocumentReference; data: unknown };

class FirebaseRead implements RepositoryRead {
  protected readonly pending = new Map<string, Pending>();

  constructor(
    protected readonly firestore: Firestore,
    protected readonly uid: string,
    protected readonly transaction: Transaction | null,
  ) {
    segment(uid, "uid");
  }

  protected user() { return this.firestore.collection("users").doc(this.uid); }
  protected collection(name: string) { return this.user().collection(name); }
  protected ref(collection: string, id: string) {
    return this.collection(collection).doc(segment(id, `${collection} id`));
  }
  protected async snapshot(ref: DocumentReference): Promise<unknown | null> {
    const staged = this.pending.get(ref.path);
    if (staged) return clone(staged.data);
    const snapshot = this.transaction ? await this.transaction.get(ref) : await ref.get();
    return snapshot.exists ? snapshot.data() : null;
  }
  protected stage(ref: DocumentReference, data: unknown) {
    this.pending.set(ref.path, { ref, data: clone(data) });
  }
  protected async query(collection: string, field: string, direction: "asc" | "desc", limit: number, documentIdAscending = false) {
    let query = this.collection(collection).orderBy(field, direction);
    if (documentIdAscending) query = query.orderBy(FieldPath.documentId(), "asc");
    query = query.limit(limit);
    const snapshot = this.transaction ? await this.transaction.get(query) : await query.get();
    const values = new Map<string, unknown>(snapshot.docs.map((doc) => [doc.ref.path, doc.data()]));
    for (const [path, pending] of this.pending)
      if (pending.ref.parent.path === this.collection(collection).path) values.set(path, pending.data);
    return [...values.entries()];
  }

  async getPreferences() {
    return unwrap<import("@siftera/shared").PreferenceProfile>(
      await this.snapshot(this.collection("preferences").doc("current")),
    );
  }
  async getCandidate(candidateId: string) {
    const stored = unwrap<{ candidate: CandidateRecord["candidate"]; sourceFingerprint: string }>(
      await this.snapshot(this.ref("candidates", candidateId)),
    );
    return stored ? { candidate: stored.candidate, sourcePayload: stored.sourceFingerprint } : null;
  }
  async resolveIdentityKey(key: string) {
    const stored = unwrap<{ candidateId: string }>(
      await this.snapshot(this.ref(key.startsWith("url:") ? "urlKeys" : "externalKeys", key.slice(key.indexOf(":") + 1))),
    );
    return stored?.candidateId ?? null;
  }
  async getSourceMetadata(sourceId: string) {
    return unwrap<SourceMetadata>(await this.snapshot(this.ref("sources", sourceId)));
  }
  async getRun(runId: string): Promise<DraftData | null> {
    const run = unwrap<import("@siftera/shared").FeedRun>(await this.snapshot(this.ref("feedRuns", runId)));
    if (!run) return null;
    const preference = unwrap<import("@siftera/shared").PreferenceProfile>(
      await this.snapshot(this.ref("preferenceVersions", String(run.preferenceVersion))),
    );
    if (!preference) return null;
    const draftItems = await this.querySub(runId, "draftItems", 80);
    const batches = await this.querySub(runId, "draftBatches", 100);
    const contentReads = await this.querySub(runId, "contentReads", 40);
    return {
      run,
      preference,
      proposals: draftItems.map((value) => unwrap<import("@siftera/shared").EditorialProposal>(value)).filter((value): value is import("@siftera/shared").EditorialProposal => value !== null),
      batches: batches.map((value) => unwrap<DraftBatch>(value)).filter((value): value is DraftBatch => value !== null),
      contentReads: contentReads.map((value) => unwrap<ContentReadReceipt>(value)).filter((value): value is ContentReadReceipt => value !== null),
    };
  }
  private async querySub(runId: string, name: string, maximum: number): Promise<unknown[]> {
    const parent = this.ref("feedRuns", runId).collection(name);
    const query = parent.limit(maximum + 1);
    const snapshot = this.transaction ? await this.transaction.get(query) : await query.get();
    const values = new Map<string, unknown>(snapshot.docs.map((doc) => [doc.ref.path, doc.data()]));
    for (const [path, pending] of this.pending)
      if (pending.ref.parent.path === parent.path) values.set(path, pending.data);
    if (values.size > maximum) throw new Error(`${name} exceeds its bounded repository limit`);
    return [...values.values()];
  }
  async getState(candidateId: string) { return unwrap<import("@siftera/shared").UserItemState>(await this.snapshot(this.ref("itemStates", candidateId))); }
  async getEditorialItem(itemId: string) { return unwrap<StoredEditorialItem>(await this.snapshot(this.ref("editorialItems", itemId))); }
  async getFeedback(id: string) { return unwrap<FeedbackRecord>(await this.snapshot(this.ref("feedback", id))); }
  async getLibraryItem(candidateId: string) { return unwrap<LibraryItem>(await this.snapshot(this.ref("libraryItems", candidateId))); }
  async getOperation(kind: RepositoryOperation["kind"], operationId: string) {
    return unwrap<RepositoryOperation>(await this.snapshot(this.ref("operations", operationDocumentId(kind, operationId))));
  }
  async getFeedPointer() {
    return unwrap<FeedPointer>(await this.snapshot(this.collection("system").doc("feed"))) ?? { latestRunId: null, activeRunId: null, generation: 0 };
  }
  async listCandidates(limit: number) {
    const values = await this.query("candidates", "data.candidate.discoveredAt", "desc", bounded(limit), true);
    return values
      .map(([, value]) => unwrap<{ candidate: CandidateRecord["candidate"]; sourceFingerprint: string }>(value))
      .filter((value): value is { candidate: CandidateRecord["candidate"]; sourceFingerprint: string } => value !== null)
      .map((value) => ({ candidate: value.candidate, sourcePayload: value.sourceFingerprint }))
      .sort((a, b) => b.candidate.discoveredAt.localeCompare(a.candidate.discoveredAt) || a.candidate.id.localeCompare(b.candidate.id))
      .slice(0, limit);
  }
  async listLibrary(limit: number) {
    const values = await this.query("libraryItems", "data.sortDate", "desc", bounded(limit));
    return values
      .map(([, value]) => unwrap<LibraryItem & { sortDate: string }>(value))
      .filter((value): value is LibraryItem & { sortDate: string } => value !== null)
      .sort((left, right) => right.sortDate.localeCompare(left.sortDate) || left.candidateId.localeCompare(right.candidateId))
      .slice(0, limit)
      .map(({ candidateId, editorialItemId }) => ({ candidateId, editorialItemId }));
  }
  async listStates(limit: number) {
    const values = await this.query("states", "data.updatedAt", "desc", bounded(limit));
    return values.map(([, value]) => unwrap<UserItemState>(value)).filter((value): value is UserItemState => value !== null);
  }
  async listSourceMetadata(limit: number) {
    const values = await this.query("sourceMetadata", "data.sourceId", "asc", bounded(limit));
    return values.map(([, value]) => unwrap<SourceMetadata>(value)).filter((value): value is SourceMetadata => value !== null);
  }
  async listEditorialItems(ids: string[]) {
    const found = await Promise.all([...new Set(ids)].map((id) => this.getEditorialItem(id)));
    return found.filter((value): value is StoredEditorialItem => value !== null);
  }
  async listRecentEditorialMetadata(since: string, limit: number) {
    const values = await this.query("editorialItems", "data.createdAt", "desc", bounded(limit));
    return values
      .map(([, value]) => unwrap<StoredEditorialItem>(value))
      .filter((value): value is StoredEditorialItem => value !== null && value.createdAt >= since)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((item): EditorialMetadata => ({ candidateId: item.candidateId, revision: item.revision, producer: item.producer, createdAt: item.createdAt }));
  }
  async listRecentRejections(since: string, limit: number) {
    const values = await this.query("rejections", "data.rejectedAt", "desc", bounded(limit));
    return values
      .map(([, value]) => unwrap<RejectionRecord>(value))
      .filter((value): value is RejectionRecord => value !== null && value.rejectedAt >= since)
      .sort((a, b) => b.rejectedAt.localeCompare(a.rejectedAt) || a.candidateId.localeCompare(b.candidateId))
      .slice(0, limit);
  }
}

class FirebaseTransaction extends FirebaseRead implements RepositoryTransaction {
  async putPreferences(value: import("@siftera/shared").PreferenceProfile) {
    this.stage(this.collection("preferences").doc("current"), wrapped(value));
    this.stage(this.ref("preferenceVersions", String(value.version)), wrapped(value));
  }
  async putCandidate(value: CandidateRecord) {
    const record = { candidate: value.candidate, sourceFingerprint: value.sourcePayload };
    this.stage(this.ref("candidates", value.candidate.id), wrapped(record));
    const revision = this.ref("candidates", value.candidate.id).collection("revisions").doc(String(value.candidate.revision));
    // Current candidate metadata may be hydrated, but a numbered source revision is append-only.
    if ((await this.snapshot(revision)) === null) this.stage(revision, wrapped(record));
  }
  async putIdentityKey(key: string, candidateId: string) {
    const separator = key.indexOf(":");
    const collection = key.slice(0, separator) === "url" ? "urlKeys" : key.slice(0, separator) === "external" ? "externalKeys" : null;
    if (!collection || separator < 1) throw new Error("invalid identity key");
    this.stage(this.ref(collection, key.slice(separator + 1)), wrapped({ candidateId }));
  }
  async putSourceMetadata(value: SourceMetadata) { this.stage(this.ref("sources", value.sourceId), wrapped(value)); }
  async putRun(value: DraftData) {
    if (value.proposals.length > 80 || value.contentReads.length > 40 || value.batches.length > 100)
      throw new Error("run exceeds bounded Firestore subcollection limits");
    const current = await this.getRun(value.run.id);
    if (current?.run.status === "published" && JSON.stringify(current.run) !== JSON.stringify(value.run))
      throw new Error("published feed runs are immutable");
    this.stage(this.ref("feedRuns", value.run.id), wrapped(value.run));
    for (const proposal of value.proposals)
      this.stage(this.ref("feedRuns", value.run.id).collection("draftItems").doc(proposal.candidate.candidateId), wrapped(proposal));
    for (const batch of value.batches)
      this.stage(this.ref("feedRuns", value.run.id).collection("draftBatches").doc(batch.batchId), wrapped(batch));
    for (const receipt of value.contentReads)
      this.stage(this.ref("feedRuns", value.run.id).collection("contentReads").doc(receipt.candidateId), wrapped(receipt));
  }
  async putState(value: import("@siftera/shared").UserItemState) { this.stage(this.ref("itemStates", value.candidateId), wrapped(value)); }
  async putEditorialItem(value: StoredEditorialItem) {
    const current = await this.getEditorialItem(value.id);
    if (current && JSON.stringify(current) !== JSON.stringify(value)) throw new Error("editorial items are immutable");
    if (!current) this.stage(this.ref("editorialItems", value.id), wrapped(value));
  }
  async putLibraryItem(value: LibraryItem) {
    const editorial = await this.getEditorialItem(value.editorialItemId);
    this.stage(this.ref("libraryItems", value.candidateId), wrapped({ ...value, sortDate: editorial?.createdAt ?? "1970-01-01T00:00:00.000Z", relevance: editorial?.proposal.assessment.relevance ?? 0 }));
  }
  async putOperation(operationId: string, value: RepositoryOperation) { this.stage(this.ref("operations", operationDocumentId(value.kind, operationId)), wrapped(value)); }
  async putFeedPointer(value: FeedPointer) { this.stage(this.collection("system").doc("feed"), wrapped(value)); }
  async putFeedback(value: FeedbackRecord) { this.stage(this.ref("feedback", value.feedback.id), wrapped(value)); }
  async putRejections(values: RejectionRecord[]) {
    for (const value of values)
      this.stage(this.ref("rejections", `${value.candidateId}_${value.revision}_${value.preferenceVersion}_${value.rejectedAt.replace(/[^A-Za-z0-9]/g, "")}`), wrapped(value));
  }
  commit(): void {
    const transaction = this.transaction;
    if (!transaction) throw new Error("transaction is required");
    for (const { ref, data } of this.pending.values()) transaction.set(ref, data);
  }
}

const operationDocumentId = (kind: RepositoryOperation["kind"], operationId: string): string =>
  createHash("sha256").update(`${kind}\u0000${segment(operationId, "operationId")}`).digest("hex");

/** Firestore Admin adapter. All documents remain below users/{verified uid}; it never scans tenants. */
export class FirestoreRepository implements RepositoryPort {
  constructor(private readonly firestore: Firestore) {}
  async transaction<T>(uid: string, work: (transaction: RepositoryTransaction) => T | Promise<T>): Promise<T> {
    return this.firestore.runTransaction(async (providerTransaction) => {
      const transaction = new FirebaseTransaction(this.firestore, uid, providerTransaction);
      const result = await work(transaction);
      transaction.commit();
      return clone(result);
    });
  }
  async read<T>(uid: string, work: (transaction: RepositoryRead) => T | Promise<T>): Promise<T> {
    return clone(await work(new FirebaseRead(this.firestore, uid, null)));
  }
}

const encode = (content: CandidateContent): Buffer => Buffer.from(gzipSync(JSON.stringify(candidateContentSchema.parse(content))));
const decode = (bytes: Buffer): CandidateContent => candidateContentSchema.parse(JSON.parse(gunzipSync(bytes).toString("utf8")));
/** Extraction timestamps may differ on retry; access/truncation changes are hydration. */
const sameStoredContent = (left: CandidateContent, right: CandidateContent) =>
  left.contentHash === right.contentHash && left.access === right.access && left.truncated === right.truncated;
const canHydrate = (existing: CandidateContent, next: CandidateContent) => existing.access !== "full" && next.access === "full";
const pause = (milliseconds: number) => new Promise<void>((resolvePause) => setTimeout(resolvePause, milliseconds));

/** Local persistent ContentStore for development/tests. Each blob is atomically created once. */
export class LocalContentStore implements ContentStore {
  private readonly root: string;
  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("content store root must be absolute");
    this.root = resolve(root);
  }
  private path(uid: string, candidateId: string, revision: number) { return resolve(this.root, contentPath(uid, candidateId, revision)); }
  async put(uid: string, content: CandidateContent): Promise<void> {
    const parsed = candidateContentSchema.parse(content);
    const path = this.path(uid, parsed.candidateId, parsed.revision);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lockPath = `${path}.lock`;
    let lock: Awaited<ReturnType<typeof open>> | null = null;
    for (let attempt = 0; attempt < 100 && !lock; attempt += 1) {
      try { lock = await open(lockPath, "wx", 0o600); }
      catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await pause(10);
      }
    }
    if (!lock) throw new Error("content store lock timeout");
    try {
      const existing = await this.get(uid, parsed.candidateId, parsed.revision);
      if (existing && !sameStoredContent(existing, parsed) && !canHydrate(existing, parsed))
        throw new Error("content revision conflict");
      if (existing && sameStoredContent(existing, parsed)) return;
      const tempPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const handle = await open(tempPath, "wx", 0o600);
      try { await handle.writeFile(encode(parsed)); } finally { await handle.close(); }
      await rename(tempPath, path);
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }
  async get(uid: string, candidateId: string, revision: number): Promise<CandidateContent | null> {
    try { return decode(await readFile(this.path(uid, candidateId, revision))); }
    catch (error: unknown) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

/** Private Cloud Storage adapter. It only stores gzip JSON under the tenant-owned content prefix. */
export class FirebaseContentStore implements ContentStore {
  constructor(private readonly bucket: Bucket) {}
  async put(uid: string, content: CandidateContent): Promise<void> {
    const parsed = candidateContentSchema.parse(content);
    const path = contentPath(uid, parsed.candidateId, parsed.revision);
    const file = this.bucket.file(path);
    const inspected = await this.inspect(path);
    if (inspected) {
      if (sameStoredContent(inspected.content, parsed)) return;
      if (!canHydrate(inspected.content, parsed)) throw new Error("content revision conflict");
      try {
        await file.save(encode(parsed), { resumable: false, preconditionOpts: { ifGenerationMatch: inspected.generation }, metadata: { contentType: "application/gzip" } });
      } catch (hydrateError) {
        const current = await this.inspect(path);
        if (current && sameStoredContent(current.content, parsed)) return;
        throw hydrateError;
      }
      return;
    }
    try {
      await file.save(encode(parsed), { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: "application/gzip" } });
      return;
    } catch (error: unknown) {
      const current = await this.inspect(path);
      if (current && sameStoredContent(current.content, parsed)) return;
      throw error;
    }
  }
  /** Reads one specific GCS generation, so a CAS decision never classifies a newer object using stale bytes. */
  private async inspect(path: string): Promise<{ content: CandidateContent; generation: number } | null> {
    const file = this.bucket.file(path);
    try {
      const [metadata] = await file.getMetadata();
      const generation = Number(metadata.generation);
      if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("storage object has no generation");
      const [bytes] = await this.bucket.file(path, { generation }).download();
      return { content: decode(bytes), generation };
    } catch (error: unknown) {
      if ((error as { code?: number }).code === 404) return null;
      throw error;
    }
  }
  async get(uid: string, candidateId: string, revision: number): Promise<CandidateContent | null> {
    const file = this.bucket.file(contentPath(uid, candidateId, revision));
    try { const [bytes] = await file.download(); return decode(bytes); }
    catch (error: unknown) {
      const code = (error as { code?: number }).code;
      if (code === 404) return null;
      throw error;
    }
  }
}
