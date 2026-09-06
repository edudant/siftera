import type { CandidateContent, PreferenceProfile, UserItemState } from "@siftera/shared";
import type {
  CandidateRecord,
  ContentStore,
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

interface TenantData {
  preferences: PreferenceProfile | null;
  candidates: Map<string, CandidateRecord>;
  identityKeys: Map<string, string>;
  sourceMetadata: Map<string, SourceMetadata>;
  states: Map<string, UserItemState>;
  runs: Map<string, DraftData>;
  feedPointer: FeedPointer;
  editorialItems: Map<string, StoredEditorialItem>;
  library: Map<string, LibraryItem>;
  operations: Map<string, RepositoryOperation>;
  feedback: FeedbackRecord[];
  rejections: RejectionRecord[];
}

const tenant = (): TenantData => ({
  preferences: null,
  candidates: new Map(),
  identityKeys: new Map(),
  sourceMetadata: new Map(),
  states: new Map(),
  runs: new Map(),
  feedPointer: { latestRunId: null, activeRunId: null, generation: 0 },
  editorialItems: new Map(),
  library: new Map(),
  operations: new Map(),
  feedback: [],
  rejections: [],
});

const copy = <T>(value: T): T => structuredClone(value);
const bounded = (limit: number, maximum: number): number => {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum)
    throw new RangeError(`limit must be an integer between 1 and ${maximum}`);
  return limit;
};

class MemoryRead implements RepositoryRead {
  constructor(protected readonly data: TenantData) {}
  async getPreferences() { return this.data.preferences === null ? null : copy(this.data.preferences); }
  async getCandidate(candidateId: string) { const value = this.data.candidates.get(candidateId); return value ? copy(value) : null; }
  async resolveIdentityKey(key: string) { return this.data.identityKeys.get(key) ?? null; }
  async getSourceMetadata(sourceId: string) { const value = this.data.sourceMetadata.get(sourceId); return value ? copy(value) : null; }
  async getRun(runId: string) { const value = this.data.runs.get(runId); return value ? copy(value) : null; }
  async getState(candidateId: string) { const value = this.data.states.get(candidateId); return value ? copy(value) : null; }
  async getEditorialItem(itemId: string) { const value = this.data.editorialItems.get(itemId); return value ? copy(value) : null; }
  async getFeedback(id: string) { const value = this.data.feedback.find((record) => record.feedback.id === id); return value ? copy(value) : null; }
  async getLibraryItem(candidateId: string) { const value = this.data.library.get(candidateId); return value ? copy(value) : null; }
  async getOperation(kind: RepositoryOperation["kind"], operationId: string) { const value = this.data.operations.get(`${kind}:${operationId}`); return value ? copy(value) : null; }
  async getFeedPointer() { return copy(this.data.feedPointer); }
  async listCandidates(limit: number) {
    return copy(
      [...this.data.candidates.values()]
        .sort(
          (a, b) =>
            b.candidate.discoveredAt.localeCompare(a.candidate.discoveredAt) ||
            a.candidate.id.localeCompare(b.candidate.id),
        )
        .slice(0, bounded(limit, 3000)),
    );
  }
  async listLibrary(limit: number) { return copy([...this.data.library.values()].slice(0, bounded(limit, 3000))); }
  async listRecentEditorialMetadata(since: string, limit: number) {
    const take = bounded(limit, 3000);
    return copy(
      [...this.data.editorialItems.values()]
        .filter((item) => item.createdAt >= since)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
        .slice(0, take)
        .map(
          (item): EditorialMetadata => ({
            candidateId: item.candidateId,
            revision: item.revision,
            producer: item.producer,
            createdAt: item.createdAt,
          }),
        ),
    );
  }
  async listRecentRejections(since: string, limit: number) {
    const take = bounded(limit, 3000);
    return copy(
      this.data.rejections
        .filter((rejection) => rejection.rejectedAt >= since)
        .sort((a, b) => b.rejectedAt.localeCompare(a.rejectedAt) || a.candidateId.localeCompare(b.candidateId))
        .slice(0, take),
    );
  }
}

class MemoryTransaction extends MemoryRead implements RepositoryTransaction {
  async putPreferences(value: PreferenceProfile) { this.data.preferences = copy(value); }
  async putCandidate(value: CandidateRecord) { this.data.candidates.set(value.candidate.id, copy(value)); }
  async putIdentityKey(key: string, candidateId: string) { this.data.identityKeys.set(key, candidateId); }
  async putSourceMetadata(value: SourceMetadata) { this.data.sourceMetadata.set(value.sourceId, copy(value)); }
  async putRun(value: DraftData) { this.data.runs.set(value.run.id, copy(value)); }
  async putState(value: UserItemState) { this.data.states.set(value.candidateId, copy(value)); }
  async putEditorialItem(value: StoredEditorialItem) { this.data.editorialItems.set(value.id, copy(value)); }
  async putLibraryItem(value: LibraryItem) { this.data.library.set(value.candidateId, copy(value)); }
  async putOperation(operationId: string, value: RepositoryOperation) { this.data.operations.set(`${value.kind}:${operationId}`, copy(value)); }
  async putFeedPointer(value: FeedPointer) { this.data.feedPointer = copy(value); }
  async putFeedback(value: FeedbackRecord) { this.data.feedback.push(copy(value)); }
  async putRejections(values: RejectionRecord[]) { this.data.rejections.push(...copy(values)); }
}

/** Test/dev adapter only. It deliberately has no server bootstrap integration. */
export class MemoryRepository implements RepositoryPort {
  private readonly users = new Map<string, TenantData>();
  private readonly locks = new Map<string, Promise<void>>();
  async transaction<T>(uid: string, work: (transaction: RepositoryTransaction) => T | Promise<T>): Promise<T> {
    const previous = this.locks.get(uid) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.locks.set(uid, queued);
    await previous;
    try {
      const draft = copy(this.forUser(uid));
      const result = await work(new MemoryTransaction(draft));
      this.users.set(uid, draft);
      return copy(result);
    } finally {
      release();
      if (this.locks.get(uid) === queued) this.locks.delete(uid);
    }
  }
  async read<T>(uid: string, work: (transaction: RepositoryRead) => T | Promise<T>): Promise<T> {
    return copy(await work(new MemoryRead(copy(this.forUser(uid)))));
  }
  private forUser(uid: string): TenantData {
    let data = this.users.get(uid);
    if (!data) { data = tenant(); this.users.set(uid, data); }
    return data;
  }
}
export class MemoryContentStore implements ContentStore {
  private readonly values = new Map<string, CandidateContent>();
  async put(uid: string, content: CandidateContent): Promise<void> { this.values.set(`${uid}/${content.candidateId}/${content.revision}`, structuredClone(content)); }
  async get(uid: string, candidateId: string, revision: number): Promise<CandidateContent | null> {
    const value = this.values.get(`${uid}/${candidateId}/${revision}`);
    return value ? structuredClone(value) : null;
  }
}
