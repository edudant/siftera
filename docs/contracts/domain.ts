/** Normativní návrh DTO v1; runtime validace žije později v packages/shared.
 * ISO = UTC RFC3339 timestamp, ID = neprázdné opaque ID bez lomítek.
 * Firebase Timestamp, DocumentReference ani Date nepatří do wire DTO.
 */
export type ID = string;
export type ISO = string;
export type Scope = 'preferences:read' | 'candidates:read' | 'history:read' | 'feedback:read' | 'editorial:write' | 'feed:publish';
export interface Principal { uid: ID; kind: 'user' | 'agent' | 'system'; scopes: Scope[]; credentialId?: ID }
export interface User { id: ID; displayName: string; locale: string; timezone: string; createdAt: ISO; updatedAt: ISO }
export type SourceAdapterConfig =
  | { kind: 'rss'; url: string }
  | { kind: 'web_page'; url: string; itemSelector: string; linkSelector: string; titleSelector?: string; dateSelector?: string; contentSelector?: string; dateFormat: 'iso' | 'cs_date' | 'none'; maxPages: 1 };
export interface Source {
  id: ID; name: string; config: SourceAdapterConfig; groups: string[];
  deliveryMode: 'curated' | 'all'; enabled: boolean; archivedAt: ISO | null;
  pollIntervalMinutes: number; includeKeywords: string[]; excludeKeywords: string[];
  createdAt: ISO; updatedAt: ISO; nextFetchAt: ISO; lastSuccessAt: ISO | null;
  consecutiveFailures: number; lastErrorCode: string | null;
  etag: string | null; lastModified: string | null;
}
export type Medium = 'text' | 'video' | 'audio' | 'image';
export type Presentation = 'article' | 'long_read' | 'distilled_fact' | 'school_notice' | 'video' | 'audio' | 'discovery' | 'learning' | 'recommendation' | 'short_fun';
export type ContentAccess = 'full' | 'partial' | 'unavailable';
export interface CandidateRef { candidateId: ID; revision: number }
export interface ImageMeta { url: string; width: number | null; height: number | null; alt: string }
export interface MediaMeta { provider: 'youtube' | 'spotify' | 'external'; externalId: string | null; url: string; durationSeconds: number | null }
export interface Candidate {
  id: ID; sourceId: ID; sourceIds: ID[]; revision: number;
  url: string; canonicalUrl: string; title: string; author: string | null;
  publishedAt: ISO | null; discoveredAt: ISO; updatedAt: ISO;
  excerpt: string; medium: Medium; categories: string[];
  image: ImageMeta | null; media: MediaMeta | null; access: ContentAccess;
  contentHash: string | null; contentRef: string | null; externalId: string | null;
  expiresAt: ISO | null;
}
export interface CandidateContent {
  candidateId: ID; revision: number; access: ContentAccess;
  text: string; contentHash: string; extractedAt: ISO; extractorVersion: string;
  truncated: boolean; originalCharacterCount: number;
}
export interface PreferenceProfile {
  version: number; instructions: string; language: string; timezone: string;
  preferredTopics: string[]; avoidTopics: string[];
  desiredTopicMix: { topic: string; weight: number }[];
  maxPerTopic: number; maxPerSource: number; discoveryFraction: number;
  longReadTarget: number; entertainmentFraction: number;
  targetItems: number; candidateLimit: number; contentReadLimit: number;
  maxCandidateAgeDays: number; includeRead: boolean;
  behaviorEnabled: boolean; updatedAt: ISO;
}
export interface EditorialAssessment {
  relevance: number; quality: 'useful' | 'thin' | 'unknown';
  novelty: 'new' | 'update' | 'repeat';
  basis: 'full_text' | 'excerpt' | 'metadata';
}
export interface SchoolDetail {
  kind: 'homework' | 'test' | 'learning_topic' | 'teacher_link' | 'announcement';
  text: string; dueDate: string | null; subject: string | null;
  origin: 'teacher' | 'ai_suggestion';
}
/** Externí agent nikdy nevytváří source URL, UID, media embed nebo vlastní ID. */
export interface EditorialProposal {
  candidate: CandidateRef; relatedCandidates: CandidateRef[];
  presentation: Presentation; headline: string; summary: string; topics: string[];
  assessment: EditorialAssessment; whyIncluded: string; openOriginal: boolean;
  distilledText: string | null; evidenceQuote: string | null;
  schoolDetails: SchoolDetail[];
}
export interface EditorialSubmission {
  schemaVersion: 1; runId: ID; batchId: ID;
  editor: { client: string; model: string | null; promptVersion: string };
  items: EditorialProposal[];
  rejected: { candidate: CandidateRef; reason: 'irrelevant' | 'low_value' | 'duplicate_story' | 'already_seen' | 'insufficient_content' }[];
}
export interface Provenance {
  candidateId: ID; revision: number; sourceId: ID; sourceName: string;
  canonicalUrl: string; title: string; publishedAt: ISO | null;
  access: ContentAccess; contentHash: string | null;
}
export interface EditorialItem extends EditorialProposal {
  id: ID; runId: ID | null; producer: 'agent' | 'system';
  provenance: Provenance[]; medium: Medium;
  image: ImageMeta | null; media: MediaMeta | null;
  readingMinutes: number | null; createdAt: ISO;
}
export interface FeedEntry { editorialItemId: ID; candidateId: ID; rank: number }
export interface FeedRun {
  id: ID; status: 'draft' | 'published' | 'aborted' | 'expired';
  generation: number; startedAt: ISO; expiresAt: ISO; publishedAt: ISO | null;
  preferenceVersion: number; candidateRefs: CandidateRef[];
  entries: FeedEntry[]; editor: EditorialSubmission['editor'] | null;
  publishedRequestKey: ID | null; publishedPayloadHash: string | null;
}
export interface UserItemState {
  candidateId: ID; read: boolean; saved: boolean; hidden: boolean;
  version: number; updatedAt: ISO;
}
export interface Feedback {
  id: ID; candidateId: ID; editorialItemId: ID;
  action: 'more' | 'good' | 'less' | 'discovery';
  target: { kind: 'item' } | { kind: 'topic'; value: string } | { kind: 'source'; sourceId: ID };
  comment: string | null; createdAt: ISO;
}
export interface AgentCredential {
  id: ID; label: string; scopes: Scope[]; createdAt: ISO; expiresAt: ISO;
  revokedAt: ISO | null; lastUsedAt: ISO | null; rotatedFrom: ID | null;
  // Internal-only record also has uid and secretHash; public API MUST omit them.
}
export interface FeedItem { entry: FeedEntry | null; item: EditorialItem; state: UserItemState; groups: string[] }
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface ApiError { error: { code: string; message: string; requestId: ID; retryable: boolean; details?: { field: string; reason: string }[] } }
