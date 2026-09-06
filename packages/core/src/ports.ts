import type {
  Candidate,
  CandidateContent,
  EditorialProposal,
  Feedback,
  FeedRun,
  PreferenceProfile,
  UserItemState,
} from "@siftera/shared";

export interface Clock {
  now(): Date;
}
export interface IdGenerator {
  next(): string;
}
export interface CandidateRecord {
  candidate: Candidate;
  sourcePayload: string;
}
export interface SourceMetadata {
  sourceId: string;
  sourceName: string;
  groups: string[];
  deliveryMode: "curated" | "all";
  enabled: boolean;
  archivedAt: string | null;
  includeKeywords: string[];
  excludeKeywords: string[];
}
export interface StoredProvenance {
  candidateId: string;
  revision: number;
  sourceId: string;
  sourceName: string;
  canonicalUrl: string;
  title: string;
  publishedAt: string | null;
  access: Candidate["access"];
  contentHash: string | null;
}
/** Immutable presentation snapshot. It must never be rebuilt from a mutable Candidate. */
export interface StoredEditorialItem {
  id: string;
  runId: string | null;
  producer: "agent" | "system";
  proposal: EditorialProposal;
  candidateId: string;
  revision: number;
  createdAt: string;
  groups: string[];
  medium: Candidate["medium"];
  image: Candidate["image"];
  media: Candidate["media"];
  readingMinutes: number | null;
  provenance: StoredProvenance[];
}
export interface DraftBatch {
  batchId: string;
  payloadHash: string;
}
export interface ContentReadReceipt {
  candidateId: string;
  revision: number;
  contentHash: string;
}
export interface DraftData {
  run: FeedRun;
  preference: PreferenceProfile;
  proposals: EditorialProposal[];
  batches: DraftBatch[];
  contentReads: ContentReadReceipt[];
  articleReads?: ArticleRead[];
}
export interface ArticlePage {
  text: string;
  title: string | null;
  access: "full" | "partial" | "unavailable";
  paywall: boolean;
  truncated: boolean;
}
export interface ArticleRead extends ArticlePage {
  candidateId: string;
  revision: number;
  status: "pending" | "ready" | "failed";
  fetchedAt: string;
}
export interface ArticleReader { read(url: string): Promise<ArticlePage>; }
export interface FeedPointer {
  latestRunId: string | null;
  activeRunId: string | null;
  generation: number;
}
export interface LibraryItem {
  candidateId: string;
  editorialItemId: string;
}
export interface BeginOperation {
  kind: "begin";
  runId: string;
}
export interface MarkReadOperation {
  kind: "mark-read";
  runId: string;
  updated: number;
  states: UserItemState[];
}
export interface PatchStateOperation {
  kind: "patch-state";
  candidateId: string;
  payloadHash: string;
  state: UserItemState;
}
export type RepositoryOperation = BeginOperation | MarkReadOperation | PatchStateOperation;
export interface FeedbackRecord {
  feedback: Feedback;
  payloadHash: string;
}
export interface RejectionRecord {
  candidateId: string;
  revision: number;
  preferenceVersion: number;
  rejectedAt: string;
}
export interface EditorialMetadata {
  candidateId: string;
  revision: number;
  producer: "agent" | "system";
  createdAt: string;
}

/**
 * Domain-shaped reads deliberately map to bounded Firestore queries and point reads.
 * Adapters must queue writes until the callback succeeds and make callback reads see
 * those pending writes, without exposing provider transaction mechanics to core.
 */
export interface RepositoryRead {
  getPreferences(): Promise<PreferenceProfile | null>;
  getCandidate(candidateId: string): Promise<CandidateRecord | null>;
  resolveIdentityKey(key: string): Promise<string | null>;
  getSourceMetadata(sourceId: string): Promise<SourceMetadata | null>;
  getRun(runId: string): Promise<DraftData | null>;
  getState(candidateId: string): Promise<UserItemState | null>;
  getEditorialItem(itemId: string): Promise<StoredEditorialItem | null>;
  getFeedback(id: string): Promise<FeedbackRecord | null>;
  getLibraryItem(candidateId: string): Promise<LibraryItem | null>;
  getOperation(
    kind: RepositoryOperation["kind"],
    operationId: string,
  ): Promise<RepositoryOperation | null>;
  getFeedPointer(): Promise<FeedPointer>;
  /** Newest discovery first; ties use the candidate ID ascending; limit is 1..3000. */
  listCandidates(limit: number): Promise<CandidateRecord[]>;
  listLibrary(limit: number): Promise<LibraryItem[]>;
  /**
   * Dávkové čtení pro pohledy nad celým účtem. Bez nich vzniká N+1: jeden bootstrap dělal 661 dotazů do D1
   * a rostlo to lineárně s počtem kandidátů, což naráží na limit dotazů na request i na latenci.
   */
  listStates(limit: number): Promise<UserItemState[]>;
  listSourceMetadata(limit: number): Promise<SourceMetadata[]>;
  listEditorialItems(ids: string[]): Promise<StoredEditorialItem[]>;
  /** Newest creation first; limit is 1..3000. */
  listRecentEditorialMetadata(
    since: string,
    limit: number,
  ): Promise<EditorialMetadata[]>;
  /** Newest rejection first, bounded to the cooldown window. */
  listRecentRejections(since: string, limit: number): Promise<RejectionRecord[]>;
}
export interface RepositoryTransaction extends RepositoryRead {
  putPreferences(value: PreferenceProfile): Promise<void>;
  putCandidate(value: CandidateRecord): Promise<void>;
  putIdentityKey(key: string, candidateId: string): Promise<void>;
  putSourceMetadata(value: SourceMetadata): Promise<void>;
  putRun(value: DraftData): Promise<void>;
  putState(value: UserItemState): Promise<void>;
  putEditorialItem(value: StoredEditorialItem): Promise<void>;
  putLibraryItem(value: LibraryItem): Promise<void>;
  putOperation(operationId: string, value: RepositoryOperation): Promise<void>;
  putFeedPointer(value: FeedPointer): Promise<void>;
  putFeedback(value: FeedbackRecord): Promise<void>;
  putRejections(values: RejectionRecord[]): Promise<void>;
}
export interface RepositoryPort {
  transaction<T>(
    uid: string,
    work: (transaction: RepositoryTransaction) => T | Promise<T>,
  ): Promise<T>;
  read<T>(
    uid: string,
    work: (transaction: RepositoryRead) => T | Promise<T>,
  ): Promise<T>;
}
export interface ContentStore {
  put(uid: string, content: CandidateContent): Promise<void>;
  get(
    uid: string,
    candidateId: string,
    revision: number,
  ): Promise<CandidateContent | null>;
}
