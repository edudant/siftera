import { createHash } from "node:crypto";
import {
  candidateContentSchema,
  candidateSchema,
  editorialItemSchema,
  editorialSubmissionSchema,
  feedbackInputSchema,
  feedbackSchema,
  feedItemSchema,
  idSchema,
  itemStateSchema,
  preferenceSchema,
  type Candidate,
  type CandidateContent,
  type EditorialProposal,
  type Feedback,
  type FeedbackInput,
  type FeedEntry,
  type FeedRun,
  type PreferenceProfile,
  type Principal,
  type UserItemState,
} from "@siftera/shared";
import type {
  ArticleRead,
  ArticleReader,
  Clock,
  ContentStore,
  DraftData,
  IdGenerator,
  RepositoryPort,
  RepositoryRead,
  RepositoryTransaction,
  StoredEditorialItem,
} from "./ports.js";

export * from "./ports.js";

export class SifteraError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "SifteraError";
  }
}
const iso = (date: Date) => date.toISOString();
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const normalizedWhitespace = (value: string) =>
  value.replace(/\s+/gu, " ").trim();
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : entry,
  );
const contentKey = (candidateId: string, revision: number) =>
  `${candidateId}:${revision}`;

/** URL identity rules deliberately retain meaningful query parameters and path case. */
export function canonicalizeUrl(input: string, base?: string): string {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw new SifteraError("INVALID_URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new SifteraError("INVALID_URL");
  if (url.username || url.password) throw new SifteraError("INVALID_URL");
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  )
    url.port = "";
  const params = [...url.searchParams.entries()]
    .filter(
      ([key]) =>
        !/^utm_/iu.test(key) &&
        !["gclid", "fbclid"].includes(key.toLowerCase()),
    )
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  url.search = "";
  for (const [key, value] of params) url.searchParams.append(key, value);
  return url.toString();
}

export function defaultPreferences(now: Date): PreferenceProfile {
  return preferenceSchema.parse({
    version: 1,
    instructions: "",
    language: "cs",
    timezone: "Europe/Prague",
    preferredTopics: [],
    avoidTopics: [],
    desiredTopicMix: [],
    maxPerTopic: 8,
    maxPerSource: 5,
    discoveryFraction: 0.2,
    longReadTarget: 2,
    entertainmentFraction: 0.15,
    targetItems: 25,
    candidateLimit: 80,
    contentReadLimit: 40,
    maxCandidateAgeDays: 7,
    includeRead: false,
    behaviorEnabled: false,
    categories: [],
    updatedAt: iso(now),
  });
}

export interface IngestInput {
  sourceId: string;
  sourceName: string;
  groups?: string[];
  deliveryMode?: "curated" | "all";
  enabled?: boolean;
  archivedAt?: string | null;
  includeKeywords?: string[];
  excludeKeywords?: string[];
  url: string;
  externalId?: string | null;
  title: string;
  excerpt?: string;
  body?: string | null;
  publishedAt?: string | null;
  categories?: string[];
  medium?: Candidate["medium"];
  image?: Candidate["image"];
  media?: Candidate["media"];
  access?: Candidate["access"];
}
export interface IngestResult {
  candidate: Candidate;
  created: boolean;
  revised: boolean;
  deduped: boolean;
  systemItemId: string | null;
}
/** Renderer-neutral public projection. Full text and storage references never leave core. */
export interface EditorialItem extends EditorialProposal {
  id: string;
  runId: string | null;
  producer: "agent" | "system";
  provenance: Array<{
    candidateId: string;
    revision: number;
    sourceId: string;
    sourceName: string;
    canonicalUrl: string;
    title: string;
    publishedAt: string | null;
    access: Candidate["access"];
    contentHash: string | null;
  }>;
  medium: Candidate["medium"];
  image: Candidate["image"];
  media: Candidate["media"];
  readingMinutes: number | null;
  createdAt: string;
}
export interface FeedItem {
  entry: FeedEntry | null;
  item: EditorialItem;
  state: UserItemState;
  groups: string[];
}

export class EditorialService {
  constructor(
    private readonly repository: RepositoryPort,
    private readonly contentStore: ContentStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async ingest(
    principal: Principal,
    input: IngestInput,
  ): Promise<IngestResult> {
    this.assertUserOrSystem(principal);
    const now = this.clock.now();
    const at = iso(now);
    const canonicalUrl = canonicalizeUrl(input.url);
    const body = input.body ?? null;
    const payload = stable({
      title: normalizedWhitespace(input.title),
      excerpt: normalizedWhitespace(input.excerpt ?? ""),
      medium: input.medium ?? "text",
      categories: input.categories ?? [],
    });
    const urlKey = hash(canonicalUrl);
    const externalKey = input.externalId
      ? hash(`${input.sourceId}:${input.externalId}`)
      : null;
    const preparedContent =
      body === null
        ? null
        : candidateContentSchema.parse({
            candidateId: "pending",
            revision: 1,
            access: input.access ?? "full",
            text: body,
            contentHash: hash(normalizedWhitespace(body)),
            extractedAt: at,
            extractorVersion: "fixture-v1",
            truncated: false,
            originalCharacterCount: body.length,
          });
    return this.repository.transaction(principal.uid, async (tx) => {
      const fromUrl = await tx.resolveIdentityKey(`url:${urlKey}`);
      const fromExternal = externalKey
        ? await tx.resolveIdentityKey(`external:${externalKey}`)
        : null;
      if (fromUrl && fromExternal && fromUrl !== fromExternal)
        throw new SifteraError("IDENTITY_CONFLICT");
      const existingId = fromUrl ?? fromExternal;
      await tx.putSourceMetadata({
        sourceId: input.sourceId,
        sourceName: input.sourceName,
        groups: input.groups ?? [],
        deliveryMode: input.deliveryMode ?? "curated",
        enabled: input.enabled ?? true,
        archivedAt: input.archivedAt ?? null,
        includeKeywords: input.includeKeywords ?? [],
        excludeKeywords: input.excludeKeywords ?? [],
      });
      if (!existingId) {
        const id = this.ids.next();
        const contentHash = preparedContent?.contentHash ?? null;
        const candidate = candidateSchema.parse({
          id,
          sourceId: input.sourceId,
          sourceIds: [input.sourceId],
          revision: 1,
          url: input.url,
          canonicalUrl,
          title: input.title,
          author: null,
          publishedAt: input.publishedAt ?? null,
          discoveredAt: at,
          updatedAt: at,
          excerpt: input.excerpt ?? "",
          medium: input.medium ?? "text",
          categories: input.categories ?? [],
          image: input.image ?? null,
          media: input.media ?? null,
          access: input.access ?? (body ? "full" : "unavailable"),
          contentHash,
          contentRef: contentHash ? contentKey(id, 1) : null,
          externalId: input.externalId ?? null,
          expiresAt: null,
        });
        if (preparedContent) {
          const content = { ...preparedContent, candidateId: id };
          await this.contentStore.put(principal.uid, content);
        }
        await tx.putCandidate({ candidate, sourcePayload: payload });
        await tx.putIdentityKey(`url:${urlKey}`, id);
        if (externalKey) await tx.putIdentityKey(`external:${externalKey}`, id);
        const systemItemId =
          input.deliveryMode === "all"
            ? await this.publishSystemSchool(tx, candidate, input, at)
            : null;
        return {
          candidate,
          created: true,
          revised: false,
          deduped: false,
          systemItemId,
        };
      }
      const currentRecord = await tx.getCandidate(existingId);
      if (!currentRecord) throw new SifteraError("INTEGRITY_ERROR");
      const current = currentRecord.candidate;
      let sourceAssociationChanged = false;
      if (!current.sourceIds.includes(input.sourceId))
        { current.sourceIds.push(input.sourceId); sourceAssociationChanged = true; }
      if (externalKey)
        await tx.putIdentityKey(`external:${externalKey}`, existingId);
      await tx.putIdentityKey(`url:${urlKey}`, existingId);
      const oldPayload = currentRecord.sourcePayload;
      // Hydrating a missing/partial content record is not a source revision.
      const existingContent = await this.contentStore.get(
        principal.uid,
        existingId,
        current.revision,
      );
      const shouldRevise =
        oldPayload !== payload ||
        Boolean(
          preparedContent &&
          existingContent?.access === "full" &&
          existingContent.contentHash !== preparedContent.contentHash,
        );
      if (!shouldRevise) {
        if (
          preparedContent &&
          (!existingContent || existingContent.access !== "full")
        ) {
          const content = {
            ...preparedContent,
            candidateId: existingId,
            revision: current.revision,
          };
          await this.contentStore.put(principal.uid, content);
          current.contentHash = content.contentHash;
          current.contentRef = contentKey(existingId, current.revision);
          current.access = input.access ?? "full";
          await tx.putCandidate({ candidate: current, sourcePayload: oldPayload });
        }
        // Chybějící obrázek doplníme i bez revize; jde o metadata, ne o změnu obsahu, a zápis skončí, jakmile obrázek je.
        else if (sourceAssociationChanged || (!current.image && input.image)) {
          if (!current.image && input.image) current.image = input.image;
          await tx.putCandidate({ candidate: current, sourcePayload: oldPayload });
        }
        return {
          candidate: current,
          created: false,
          revised: false,
          deduped: true,
          systemItemId: null,
        };
      }
      const revision = current.revision + 1;
      const content = preparedContent
        ? { ...preparedContent, candidateId: existingId, revision }
        : null;
      if (content) {
        await this.contentStore.put(principal.uid, content);
      }
      const updated = candidateSchema.parse({
        ...current,
        sourceIds: [...new Set(current.sourceIds)],
        revision,
        title: input.title,
        excerpt: input.excerpt ?? "",
        publishedAt: input.publishedAt ?? null,
        categories: input.categories ?? [],
        medium: input.medium ?? "text",
        image: input.image ?? current.image,
        media: input.media ?? current.media,
        access: input.access ?? (body ? "full" : "unavailable"),
        contentHash: content?.contentHash ?? null,
        contentRef: content ? contentKey(existingId, revision) : null,
        updatedAt: at,
      });
      await tx.putCandidate({ candidate: updated, sourcePayload: payload });
      if (input.deliveryMode === "all") {
        const oldState = await tx.getState(existingId);
        if (oldState)
          await tx.putState({
            ...oldState,
            read: false,
            version: oldState.version + 1,
            updatedAt: at,
          });
      }
      const systemItemId =
        input.deliveryMode === "all"
          ? await this.publishSystemSchool(tx, updated, input, at)
          : null;
      return {
        candidate: updated,
        created: false,
        revised: true,
        deduped: false,
        systemItemId,
      };
    });
  }

  async beginRun(principal: Principal, operationId: string): Promise<FeedRun> {
    this.assertScopes(principal, [
      "preferences:read",
      "candidates:read",
      "editorial:write",
    ]);
    const now = this.clock.now();
    const at = iso(now);
    return this.repository.transaction(principal.uid, async (tx) => {
      const receiptOperation = await tx.getOperation("begin", operationId);
      if (receiptOperation) {
        if (receiptOperation.kind !== "begin") throw new SifteraError("INTEGRITY_ERROR");
        const receipt = await tx.getRun(receiptOperation.runId);
        if (receipt) return receipt.run;
        throw new SifteraError("INTEGRITY_ERROR");
      }
      const pointer = await tx.getFeedPointer();
      const active = pointer.activeRunId
        ? await tx.getRun(pointer.activeRunId)
        : null;
      if (active && new Date(active.run.expiresAt) > now) {
        await tx.putOperation(operationId, {
          kind: "begin",
          runId: active.run.id,
        });
        return active.run;
      }
      if (active) {
        active.run.status = "expired";
        await tx.putRun(active);
        pointer.activeRunId = null;
      }
      const preference = (await tx.getPreferences()) ?? defaultPreferences(now);
      if (!(await tx.getPreferences())) await tx.putPreferences(preference);
      const refs = (await this.prefilter(tx, preference, now)).map((candidate) => ({
        candidateId: candidate.id,
        revision: candidate.revision,
      }));
      const run: FeedRun = {
        id: this.ids.next(),
        status: "draft",
        generation: pointer.generation + 1,
        startedAt: at,
        expiresAt: iso(new Date(now.getTime() + 60 * 60_000)),
        publishedAt: null,
        preferenceVersion: preference.version,
        candidateRefs: refs,
        entries: [],
        editor: null,
        publishedRequestKey: null,
        publishedPayloadHash: null,
      };
      const draft: DraftData = {
        run,
        preference: structuredClone(preference),
        proposals: [],
        batches: [],
        contentReads: [],
      };
      pointer.generation = run.generation;
      pointer.activeRunId = run.id;
      await tx.putRun(draft);
      await tx.putFeedPointer(pointer);
      await tx.putOperation(operationId, { kind: "begin", runId: run.id });
      return run;
    });
  }
  async editorSnapshot(principal: Principal, runId: string): Promise<DraftData> {
    this.assertScope(principal, "candidates:read");
    return this.repository.read(principal.uid, async tx => {
      const draft = this.draft(await tx.getRun(runId));
      this.assertLiveDraft(draft);
      if ((await tx.getFeedPointer()).activeRunId !== runId) throw new SifteraError("RUN_NOT_ACTIVE");
      if ((await tx.getPreferences())?.version !== draft.preference.version) throw new SifteraError("STALE_PREFERENCES");
      return draft;
    });
  }

  async submit(
    principal: Principal,
    submissionInput: unknown,
  ): Promise<{ acceptedCandidateIds: string[] }> {
    this.assertScope(principal, "editorial:write");
    const submission = editorialSubmissionSchema.parse(submissionInput);
    return this.repository.transaction(principal.uid, async (tx) => {
      const draft = this.draft(await tx.getRun(submission.runId));
      this.assertLiveDraft(draft);
      const payloadHash = hash(stable(submission));
      const prior = draft.batches.find(
        (batch) => batch.batchId === submission.batchId,
      )?.payloadHash;
      if (prior) {
        if (prior !== payloadHash)
          throw new SifteraError("IDEMPOTENCY_CONFLICT");
        return {
          acceptedCandidateIds: submission.items.map(
            (item) => item.candidate.candidateId,
          ),
        };
      }
      const errors: string[] = [];
      const known = new Set(
        draft.run.candidateRefs.map(
          (ref) => `${ref.candidateId}:${ref.revision}`,
        ),
      );
      const proposalIds = new Set<string>();
      for (const item of submission.items) {
        const candidate = await tx.getCandidate(item.candidate.candidateId);
        const ref = `${item.candidate.candidateId}:${item.candidate.revision}`;
        if (!known.has(ref))
          errors.push(
            `candidate ${item.candidate.candidateId} is not in run snapshot`,
          );
        if (proposalIds.has(item.candidate.candidateId))
          errors.push(`candidate ${item.candidate.candidateId} appears twice`);
        proposalIds.add(item.candidate.candidateId);
        for (const related of item.relatedCandidates)
          if (!known.has(`${related.candidateId}:${related.revision}`))
            errors.push(
              `related candidate ${related.candidateId} is not in run snapshot`,
            );
        if (
          item.assessment.basis === "full_text" ||
          item.presentation === "long_read"
        ) {
          if (
            !draft.contentReads.some(
              (receipt) =>
                `${receipt.candidateId}:${receipt.revision}` === ref,
            )
          )
            errors.push(
              `candidate ${item.candidate.candidateId} lacks a full-text read receipt`,
            );
        }
        if (item.presentation === "distilled_fact") {
          const content = candidate
            ? await this.contentStore.get(
                principal.uid,
                candidate.candidate.id,
                candidate.candidate.revision,
              )
            : null;
          if (
            item.assessment.basis !== "full_text" ||
            !item.distilledText ||
            !item.evidenceQuote ||
            !content ||
            content.truncated ||
            !normalizedWhitespace(content.text).includes(
              normalizedWhitespace(item.evidenceQuote),
            )
          )
            errors.push(
              `distilled_fact ${item.candidate.candidateId} lacks verified full-text evidence`,
            );
        }
      }
      const rejectedIds = new Set<string>();
      for (const rejected of submission.rejected) {
        const ref = `${rejected.candidate.candidateId}:${rejected.candidate.revision}`;
        if (!known.has(ref))
          errors.push(
            `rejected candidate ${rejected.candidate.candidateId} is not in run snapshot`,
          );
        if (rejectedIds.has(rejected.candidate.candidateId))
          errors.push(`rejected candidate ${rejected.candidate.candidateId} appears twice`);
        if (proposalIds.has(rejected.candidate.candidateId))
          errors.push(`candidate ${rejected.candidate.candidateId} is both accepted and rejected`);
        rejectedIds.add(rejected.candidate.candidateId);
      }
      if (errors.length)
        throw new SifteraError("INVALID_SUBMISSION", errors.join("; "));
      for (const item of submission.items) {
        const index = draft.proposals.findIndex(
          (proposal) =>
            proposal.candidate.candidateId === item.candidate.candidateId,
        );
        if (index >= 0) draft.proposals[index] = item;
        else draft.proposals.push(item);
      }
      draft.batches.push({ batchId: submission.batchId, payloadHash });
      draft.run.editor = submission.editor;
      if (submission.rejected.length)
        await tx.putRejections(
          submission.rejected.map((rejected) => ({
            candidateId: rejected.candidate.candidateId,
            revision: rejected.candidate.revision,
            preferenceVersion: draft.preference.version,
            rejectedAt: iso(this.clock.now()),
          })),
        );
      await tx.putRun(draft);
      return {
        acceptedCandidateIds: submission.items.map(
          (item) => item.candidate.candidateId,
        ),
      };
    });
  }

  async publish(
    principal: Principal,
    runId: string,
    operationId: string,
    orderedCandidateIds: string[],
  ): Promise<{ run: FeedRun; items: FeedItem[] }> {
    this.assertScope(principal, "feed:publish");
    if (
      orderedCandidateIds.length > 50 ||
      new Set(orderedCandidateIds).size !== orderedCandidateIds.length
    )
      throw new SifteraError("INVALID_PUBLISH");
    return this.repository.transaction(principal.uid, async (tx) => {
      const draft = this.draft(await tx.getRun(runId));
      const payloadHash = hash(stable({ orderedCandidateIds }));
      if (draft.run.status === "published") {
        if (
          draft.run.publishedRequestKey === operationId &&
          draft.run.publishedPayloadHash === payloadHash
        )
          return { run: draft.run, items: await this.itemsForRun(tx, draft.run) };
        throw new SifteraError("IDEMPOTENCY_CONFLICT");
      }
      this.assertLiveDraft(draft);
      if (
        (await tx.getFeedPointer()).activeRunId !== runId ||
        ((await tx.getPreferences())?.version ?? 1) !== draft.run.preferenceVersion
      )
        throw new SifteraError("STALE_PREFERENCES");
      const proposals = orderedCandidateIds.map((candidateId) =>
        draft.proposals.find(
          (proposal) => proposal.candidate.candidateId === candidateId,
        ),
      );
      if (proposals.some((proposal) => !proposal))
        throw new SifteraError("MISSING_PROPOSAL");
      const sourceCounts = new Map<string, number>();
      const topicCounts = new Map<string, number>();
      for (const candidateId of orderedCandidateIds) {
        const candidate = await tx.getCandidate(candidateId);
        const proposal = draft.proposals.find(
          (item) => item.candidate.candidateId === candidateId,
        )!;
        if (
          !candidate ||
          !draft.run.candidateRefs.some(
            (ref) =>
              ref.candidateId === candidateId &&
              ref.revision === candidate.candidate.revision,
          )
        )
          throw new SifteraError("CANDIDATE_CHANGED");
        const state = await tx.getState(candidateId);
        if (state?.hidden || (state?.read && !draft.preference.includeRead))
          throw new SifteraError("ITEM_NOT_ELIGIBLE");
        if (
          proposal.topics.some((topic) =>
            draft.preference.avoidTopics.includes(topic),
          )
        )
          throw new SifteraError("AVOIDED_TOPIC");
        for (const related of proposal.relatedCandidates) {
          const relatedCandidate = await tx.getCandidate(related.candidateId);
          if (
            !relatedCandidate ||
            relatedCandidate.candidate.revision !== related.revision ||
            !draft.run.candidateRefs.some(
              (ref) =>
                ref.candidateId === related.candidateId &&
                ref.revision === related.revision,
            )
          )
            throw new SifteraError("CANDIDATE_CHANGED");
        }
        const sourceTotal =
          (sourceCounts.get(candidate.candidate.sourceId) ?? 0) + 1;
        if (sourceTotal > draft.preference.maxPerSource)
          throw new SifteraError("SOURCE_QUOTA");
        sourceCounts.set(candidate.candidate.sourceId, sourceTotal);
        for (const topic of proposal.topics) {
          const total = (topicCounts.get(topic) ?? 0) + 1;
          if (total > draft.preference.maxPerTopic)
            throw new SifteraError("TOPIC_QUOTA");
          topicCounts.set(topic, total);
        }
      }
      const at = iso(this.clock.now());
      draft.run.entries = orderedCandidateIds.map((candidateId, rank) => ({
        editorialItemId: `${runId}_${candidateId}`,
        candidateId,
        rank,
      }));
      for (const candidateId of orderedCandidateIds) {
        const candidate = (await tx.getCandidate(candidateId))!.candidate;
        const proposal = draft.proposals.find(
          (item) => item.candidate.candidateId === candidateId,
        )!;
        const source = await tx.getSourceMetadata(candidate.sourceId);
        const relatedProvenance = await Promise.all(
          proposal.relatedCandidates.map(async (related) => {
            const relatedCandidate = await tx.getCandidate(related.candidateId);
            if (!relatedCandidate) throw new SifteraError("CANDIDATE_CHANGED");
            return this.provenance(
              relatedCandidate.candidate,
              await tx.getSourceMetadata(relatedCandidate.candidate.sourceId),
            );
          }),
        );
        const content = candidate.contentHash
          ? await this.contentStore.get(
              principal.uid,
              candidate.id,
              candidate.revision,
            )
          : null;
        const item: StoredEditorialItem = {
          id: `${runId}_${candidateId}`,
          runId,
          producer: "agent",
          proposal,
          candidateId,
          revision: candidate.revision,
          createdAt: at,
          groups: source?.groups ?? [],
          medium: candidate.medium,
          image: candidate.image,
          media: candidate.media,
          provenance: [this.provenance(candidate, source), ...relatedProvenance],
          readingMinutes: content
            ? Math.max(
                1,
                Math.ceil(
                  content.text.split(/\s+/u).filter(Boolean).length / 220,
                ),
              )
            : null,
        };
        await tx.putEditorialItem(item);
        await tx.putLibraryItem({ candidateId, editorialItemId: item.id });
      }
      draft.run.status = "published";
      draft.run.publishedAt = at;
      draft.run.publishedRequestKey = operationId;
      draft.run.publishedPayloadHash = payloadHash;
      const pointer = await tx.getFeedPointer();
      pointer.latestRunId = runId;
      pointer.activeRunId = null;
      await tx.putRun(draft);
      await tx.putFeedPointer(pointer);
      return { run: draft.run, items: await this.itemsForRun(tx, draft.run) };
    });
  }

  async abort(principal: Principal, runId: string): Promise<FeedRun> {
    this.assertScope(principal, "editorial:write");
    return this.repository.transaction(principal.uid, async (tx) => {
      const draft = this.draft(await tx.getRun(runId));
      if (draft.run.status === "published")
        throw new SifteraError("RUN_ALREADY_PUBLISHED");
      draft.run.status = "aborted";
      const pointer = await tx.getFeedPointer();
      if (pointer.activeRunId === runId) pointer.activeRunId = null;
      await tx.putRun(draft);
      await tx.putFeedPointer(pointer);
      return draft.run;
    });
  }
  async latestFeed(
    principal: Principal,
  ): Promise<{ run: FeedRun | null; items: FeedItem[] }> {
    this.assertHistoryAccess(principal);
    return this.repository.read(principal.uid, async (tx) => {
      const pointer = await tx.getFeedPointer();
      const draft = pointer.latestRunId
        ? await tx.getRun(pointer.latestRunId)
        : null;
      return {
        run: draft?.run ?? null,
        items: draft ? await this.itemsForRun(tx, draft.run) : [],
      };
    });
  }
  /**
   * Proud podle ADR-015: publikované položky napříč vydáními, které uživatel nepřečetl ani neskryl a které
   * nejsou starší než `unreadWindowDays`. Řadí se relevancí od editora s útlumem podle stáří, takže stará
   * vysoko hodnocená položka neuvízne navrchu. Už viděné klesají pod ty, které uživatel nikdy neměl před očima.
   */
  async unreadStream(principal: Principal, windowDays = 14): Promise<FeedItem[]> {
    this.assertHistoryAccess(principal);
    return this.repository.read(principal.uid, async (tx) => {
      const now = this.clock.now();
      const cutoff = now.getTime() - windowDays * 86_400_000;
      const items = await this.libraryItems(tx);
      const fresh = items.filter((entry) => {
        if (entry.state.read || entry.state.hidden) return false;
        const at = entry.item.provenance[0]?.publishedAt ?? entry.item.createdAt;
        const stamp = new Date(at).getTime();
        return Number.isFinite(stamp) && stamp >= cutoff;
      });
      const score = (entry: FeedItem): number => {
        const at = entry.item.provenance[0]?.publishedAt ?? entry.item.createdAt;
        const ageDays = Math.max(0, (now.getTime() - new Date(at).getTime()) / 86_400_000);
        // Poločas tři dny: po třech dnech má položka poloviční váhu, po šesti čtvrtinovou.
        const decay = Math.pow(0.5, ageDays / 3);
        const seenPenalty = entry.state.seenAt ? 0.45 : 1;
        return (entry.item.assessment?.relevance ?? 50) * decay * seenPenalty;
      };
      return fresh.sort((left, right) => score(right) - score(left));
    });
  }
  /** Candidates still eligible for the next editorial run. */
  async pendingCandidates(principal: Principal): Promise<Candidate[]> {
    this.assertHistoryAccess(principal);
    return this.repository.read(principal.uid, async (tx) => {
      const now = this.clock.now();
      const preference = (await tx.getPreferences()) ?? defaultPreferences(now);
      return this.prefilter(tx, preference, now);
    });
  }
  async libraryFeed(principal: Principal): Promise<FeedItem[]> {
    this.assertHistoryAccess(principal);
    return this.repository.read(principal.uid, async (tx) =>
      this.libraryItems(tx),
    );
  }
  async getPreferences(principal: Principal): Promise<PreferenceProfile> {
    this.assertUserOrSystem(principal);
    return this.repository.read(
      principal.uid,
      async (tx) => (await tx.getPreferences()) ?? defaultPreferences(this.clock.now()),
    );
  }
  async getContent(
    principal: Principal,
    candidateId: string,
    revision: number,
  ): Promise<CandidateContent> {
    this.assertUserOrSystem(principal);
    return this.repository.read(principal.uid, async (tx) => {
      const candidate = await tx.getCandidate(candidateId);
      if (!candidate || candidate.candidate.revision < revision)
        throw new SifteraError("NOT_FOUND");
      const content = await this.contentStore.get(
        principal.uid,
        candidateId,
        revision,
      );
      if (!content) throw new SifteraError("CONTENT_EXPIRED");
      return content;
    });
  }
  /** Reserve a bounded read before network I/O; only a snapshot-owned URL can be fetched. */
  async readOriginal(principal: Principal, runId: string, candidateId: string, reader: ArticleReader): Promise<ArticleRead> {
    this.assertScope(principal, "candidates:read");
    const reservation = await this.repository.transaction(principal.uid, async tx => {
      const draft = this.draft(await tx.getRun(runId));
      this.assertLiveDraft(draft);
      if ((await tx.getFeedPointer()).activeRunId !== runId) throw new SifteraError("RUN_NOT_ACTIVE");
      if ((await tx.getPreferences())?.version !== draft.preference.version) throw new SifteraError("STALE_PREFERENCES");
      const ref = draft.run.candidateRefs.find(ref => ref.candidateId === candidateId);
      const record = await tx.getCandidate(candidateId);
      if (!ref || !record) throw new SifteraError("NOT_FOUND");
      if (record.candidate.revision !== ref.revision) throw new SifteraError("CANDIDATE_CHANGED");
      const existing = draft.articleReads?.find(read => read.candidateId === candidateId);
      if (existing) return { existing, url: null };
      if ((draft.articleReads?.length ?? 0) >= Math.min(20, draft.preference.contentReadLimit)) throw new SifteraError("CONTENT_READ_LIMIT");
      const read: ArticleRead = { candidateId, revision: ref.revision, status: "pending", fetchedAt: iso(this.clock.now()), text: "", title: null, access: "unavailable", paywall: false, truncated: false };
      draft.articleReads = [...(draft.articleReads ?? []), read];
      await tx.putRun(draft);
      return { existing: read, url: record.candidate.canonicalUrl };
    });
    if (!reservation.url) return reservation.existing;
    let read: ArticleRead;
    try {
      const page = await reader.read(reservation.url);
      const truncated = page.truncated || page.text.length > 24_000;
      read = { ...reservation.existing, ...page, text: page.text.slice(0, 24_000), truncated, access: page.paywall || truncated ? "partial" : page.access, status: "ready" };
    } catch {
      read = { ...reservation.existing, status: "failed" };
    }
    return this.repository.transaction(principal.uid, async tx => {
      const draft = this.draft(await tx.getRun(runId));
      this.assertLiveDraft(draft);
      if ((await tx.getFeedPointer()).activeRunId !== runId) throw new SifteraError("RUN_NOT_ACTIVE");
      if ((await tx.getPreferences())?.version !== draft.preference.version) throw new SifteraError("STALE_PREFERENCES");
      const record = await tx.getCandidate(candidateId);
      if (!record || record.candidate.revision !== read.revision) throw new SifteraError("CANDIDATE_CHANGED");
      // Hydration preserves the source revision and identity. Partial page text stays in the draft.
      if (read.access === "full" && read.text) {
        const previous = await this.contentStore.get(principal.uid, candidateId, read.revision);
        const content = previous?.access === "full" ? previous : candidateContentSchema.parse({
          candidateId, revision: read.revision, text: read.text, access: "full", contentHash: hash(normalizedWhitespace(read.text)),
          extractedAt: read.fetchedAt, extractorVersion: "readability-v1", truncated: false, originalCharacterCount: read.text.length,
        });
        if (previous?.access !== "full") await this.contentStore.put(principal.uid, content);
        record.candidate.contentHash = content.contentHash;
        record.candidate.contentRef = contentKey(candidateId, read.revision);
        record.candidate.access = "full";
        await tx.putCandidate(record);
      }
      draft.articleReads = (draft.articleReads ?? []).map(entry => entry.candidateId === candidateId ? read : entry);
      await tx.putRun(draft);
      return read;
    });
  }
  async readRunContent(
    principal: Principal,
    runId: string,
    candidateId: string,
    revision: number,
  ): Promise<CandidateContent> {
    this.assertScope(principal, "candidates:read");
    return this.repository.transaction(principal.uid, async (tx) => {
      const draft = this.draft(await tx.getRun(runId));
      this.assertLiveDraft(draft);
      if ((await tx.getFeedPointer()).activeRunId !== runId)
        throw new SifteraError("RUN_NOT_ACTIVE");
      if (
        !draft.run.candidateRefs.some(
          (ref) => ref.candidateId === candidateId && ref.revision === revision,
        )
      )
        throw new SifteraError("NOT_FOUND");
      const candidate = await tx.getCandidate(candidateId);
      if (!candidate || candidate.candidate.revision !== revision)
        throw new SifteraError("CANDIDATE_CHANGED");
      const content = await this.contentStore.get(
        principal.uid,
        candidateId,
        revision,
      );
      if (
        !content ||
        content.truncated ||
        content.access !== "full" ||
        content.contentHash !== candidate.candidate.contentHash
      )
        throw new SifteraError("CONTENT_UNAVAILABLE");
      if (
        !draft.contentReads.some(
          (receipt) =>
            receipt.candidateId === candidateId && receipt.revision === revision,
        ) &&
        draft.contentReads.length >= draft.preference.contentReadLimit
      )
        throw new SifteraError("CONTENT_READ_LIMIT");
      if (
        !draft.contentReads.some(
          (receipt) =>
            receipt.candidateId === candidateId && receipt.revision === revision,
        )
      )
        draft.contentReads.push({
          candidateId,
          revision,
          contentHash: content.contentHash,
        });
      await tx.putRun(draft);
      return content;
    });
  }
  /**
   * Zapíše, že uživatel položky viděl (ADR-015). Jde o slabý signál, ne o uživatelovu volbu: první značka
   * platí, další se ignorují, a nikdy nepřepisuje read/saved/hidden ani nezvedá konflikt verzí — proto
   * nejde přes `patchState`. Položky bez stavu se založí, existující jen doplní `seenAt`.
   */
  async markSeen(principal: Principal, candidateIds: string[], at?: Date): Promise<number> {
    this.assertUserOrSystem(principal);
    const unique = [...new Set(candidateIds)].slice(0, 200);
    if (!unique.length) return 0;
    const stamp = iso(at ?? this.clock.now());
    return this.repository.transaction(principal.uid, async (tx) => {
      let written = 0;
      for (const candidateId of unique) {
        const candidate = await tx.getCandidate(candidateId);
        if (!candidate) continue;
        const current = await tx.getState(candidateId);
        if (current?.seenAt) continue;
        const next = current
          ? { ...current, seenAt: stamp }
          : itemStateSchema.parse({ candidateId, read: false, saved: false, hidden: false, seenAt: stamp, version: 0, updatedAt: stamp });
        await tx.putState(next);
        written += 1;
      }
      return written;
    });
  }
  async patchState(
    principal: Principal,
    candidateId: string,
    baseVersion: number,
    patch: Partial<Pick<UserItemState, "read" | "saved" | "hidden">>,
    operationId?: string,
  ): Promise<UserItemState> {
    this.assertUserOrSystem(principal);
    const keys = Object.keys(patch);
    if (
      !keys.length ||
      keys.some((key) => !["read", "saved", "hidden"].includes(key))
    )
      throw new SifteraError("INVALID_STATE");
    if (operationId && !idSchema.safeParse(operationId).success)
      throw new SifteraError("INVALID_STATE");
    return this.repository.transaction(principal.uid, async (tx) => {
      const payloadHash = hash(stable({ candidateId, baseVersion, patch }));
      if (operationId) {
        const receipt = await tx.getOperation("patch-state", operationId);
        if (receipt) {
          if (
            receipt.kind !== "patch-state" ||
            receipt.candidateId !== candidateId ||
            receipt.payloadHash !== payloadHash
          )
            throw new SifteraError("IDEMPOTENCY_CONFLICT");
          return receipt.state;
        }
      }
      if (!(await tx.getCandidate(candidateId)))
        throw new SifteraError("NOT_FOUND");
      const current =
        (await tx.getState(candidateId)) ??
        itemStateSchema.parse({
          candidateId,
          read: false,
          saved: false,
          hidden: false,
          version: 0,
          updatedAt: iso(this.clock.now()),
        });
      if (current.version !== baseVersion)
        throw new SifteraError("STALE_STATE");
      const next = itemStateSchema.parse({
        ...current,
        ...patch,
        candidateId,
        version: current.version + 1,
        updatedAt: iso(this.clock.now()),
      });
      await tx.putState(next);
      if (operationId)
        await tx.putOperation(operationId, {
          kind: "patch-state",
          candidateId,
          payloadHash,
          state: next,
        });
      return next;
    });
  }

  async markRunRead(
    principal: Principal,
    runId: string,
    operationId: string,
  ): Promise<{ updated: number; states: UserItemState[] }> {
    this.assertUserOrSystem(principal);
    return this.repository.transaction(principal.uid, async (tx) => {
      const previous = await tx.getOperation("mark-read", operationId);
      if (previous) {
        if (previous.kind !== "mark-read") throw new SifteraError("INTEGRITY_ERROR");
        if (previous.runId !== runId)
          throw new SifteraError("IDEMPOTENCY_CONFLICT");
        return { updated: previous.updated, states: previous.states };
      }
      const draft = this.draft(await tx.getRun(runId));
      if (draft.run.status !== "published")
        throw new SifteraError("RUN_NOT_PUBLISHED");
      const now = iso(this.clock.now());
      let updated = 0;
      const states: UserItemState[] = [];
      for (const entry of draft.run.entries) {
        const current =
          (await tx.getState(entry.candidateId)) ??
          itemStateSchema.parse({
            candidateId: entry.candidateId,
            read: false,
            saved: false,
            hidden: false,
            version: 0,
            updatedAt: now,
          });
        if (current.read) {
          states.push(current);
          continue;
        }
        const next = itemStateSchema.parse({
          ...current,
          read: true,
          version: current.version + 1,
          updatedAt: now,
        });
        await tx.putState(next);
        updated += 1;
        states.push(next);
      }
      const receipt = { runId, updated, states };
      await tx.putOperation(operationId, { kind: "mark-read", ...receipt });
      return { updated, states };
    });
  }
  async feedback(
    principal: Principal,
    input: FeedbackInput,
  ): Promise<Feedback>;
  async feedback(
    principal: Principal,
    candidateId: string,
    editorialItemId: string,
    action: "more" | "good" | "less" | "discovery",
  ): Promise<Feedback>;
  async feedback(
    principal: Principal,
    inputOrCandidateId: FeedbackInput | string,
    editorialItemId?: string,
    action?: "more" | "good" | "less" | "discovery",
  ): Promise<Feedback> {
    this.assertUserOrSystem(principal);
    const input =
      typeof inputOrCandidateId === "string"
        ? {
            id: this.ids.next(),
            candidateId: inputOrCandidateId,
            editorialItemId: editorialItemId!,
            action: action!,
            target: { kind: "item" as const },
            comment: null,
          }
        : inputOrCandidateId;
    const parsed = feedbackInputSchema.parse(input);
    const payloadHash = hash(stable(parsed));
    return this.repository.transaction(principal.uid, async (tx) => {
      const existing = await tx.getFeedback(parsed.id);
      if (existing) {
        if (existing.payloadHash !== payloadHash)
          throw new SifteraError("IDEMPOTENCY_CONFLICT");
        return existing.feedback;
      }
      const item = await tx.getEditorialItem(parsed.editorialItemId);
      if (
        !(await tx.getCandidate(parsed.candidateId)) ||
        !item ||
        item.candidateId !== parsed.candidateId
      )
        throw new SifteraError("NOT_FOUND");
      const target = parsed.target;
      if (target.kind === "topic" && !item.proposal.topics.includes(target.value))
        throw new SifteraError("INVALID_FEEDBACK_TARGET");
      if (
        target.kind === "source"
      )
        {
          const sourceId = target.sourceId;
          if (!item.provenance.some((provenance) => provenance.sourceId === sourceId))
            throw new SifteraError("INVALID_FEEDBACK_TARGET");
        }
      const feedback = feedbackSchema.parse({
        ...parsed,
        createdAt: iso(this.clock.now()),
      });
      await tx.putFeedback({
        feedback,
        payloadHash,
      });
      return feedback;
    });
  }
  async savePreferences(
    principal: Principal,
    expectedVersion: number,
    value: Omit<PreferenceProfile, "version" | "updatedAt">,
  ): Promise<PreferenceProfile> {
    this.assertUserOrSystem(principal);
    return this.repository.transaction(principal.uid, async (tx) => {
      const current = (await tx.getPreferences()) ?? defaultPreferences(this.clock.now());
      if (current.version !== expectedVersion)
        throw new SifteraError("STALE_PREFERENCES");
      const next = preferenceSchema.parse({
        ...value,
        version: current.version + 1,
        updatedAt: iso(this.clock.now()),
      });
      await tx.putPreferences(next);
      return next;
    });
  }

  private async prefilter(
    tx: RepositoryRead,
    preference: PreferenceProfile,
    now: Date,
  ): Promise<Candidate[]> {
    const maxAge = preference.maxCandidateAgeDays * 86_400_000;
    const records = await tx.listCandidates(3000);
    const recent = await tx.listRecentEditorialMetadata(
      iso(new Date(now.getTime() - 30 * 86_400_000)),
      3000,
    );
    const effectiveDate = (candidate: Candidate): Date => {
      const discovered = new Date(candidate.discoveredAt);
      const published = candidate.publishedAt ? new Date(candidate.publishedAt) : discovered;
      return Number.isNaN(published.getTime()) || published.getTime() > now.getTime() + 24 * 60 * 60_000
        ? discovered
        : published;
    };
    const sevenDaysAgo = now.getTime() - 7 * 86_400_000;
    const publicationCount = new Map<string, number>();
    for (const { candidate } of records)
      if (effectiveDate(candidate).getTime() >= sevenDaysAgo)
        publicationCount.set(
          candidate.sourceId,
          (publicationCount.get(candidate.sourceId) ?? 0) + 1,
        );
    const rejected = await tx.listRecentRejections(
      iso(new Date(now.getTime() - 7 * 86_400_000)),
      3000,
    );
    const [allStates, allSources] = await Promise.all([tx.listStates(3000), tx.listSourceMetadata(3000)]);
    const stateByCandidate = new Map(allStates.map((entry) => [entry.candidateId, entry]));
    const sourceById = new Map(allSources.map((entry) => [entry.sourceId, entry]));
    const descriptors = (
      await Promise.all(
        records.map(async ({ candidate }) => {
          const state = stateByCandidate.get(candidate.id) ?? null;
          const source = sourceById.get(candidate.sourceId) ?? null;
          const date = effectiveDate(candidate);
          const words = `${candidate.title} ${candidate.excerpt} ${candidate.categories.join(" ")}`.toLowerCase();
          const topics = candidate.categories.map((topic) => topic.toLowerCase());
          const include = source?.includeKeywords ?? [];
          const exclude = source?.excludeKeywords ?? [];
          const matchingPreferred = preference.preferredTopics.some((topic) => words.includes(topic));
          const alreadyPublished = recent.some(
            (item) =>
              item.candidateId === candidate.id &&
              item.revision === candidate.revision &&
              item.producer === "agent",
          );
          const inCooldown = rejected.some(
            (item) =>
              item.candidateId === candidate.id &&
              item.revision === candidate.revision &&
              item.preferenceVersion === preference.version,
          );
          const enabled = source?.enabled ?? true;
          const archived = source?.archivedAt !== null && source?.archivedAt !== undefined;
          const keywordMatch = include.length === 0 || include.some((keyword) => words.includes(keyword.toLowerCase()));
          const excludedKeyword = exclude.some((keyword) => words.includes(keyword.toLowerCase()));
          const freshness = 40 * Math.max(0, 1 - Math.max(0, now.getTime() - date.getTime()) / maxAge);
          const rareSource = (publicationCount.get(candidate.sourceId) ?? 0) <= 2 ? 10 : 0;
          return {
            candidate,
            date,
            sourceId: candidate.sourceId,
            allDelivery: source?.deliveryMode === "all",
            discovery: !matchingPreferred,
            score: freshness + 30 * Number(matchingPreferred) + rareSource,
            eligible:
              now.getTime() - date.getTime() <= maxAge &&
              enabled &&
              !archived &&
              keywordMatch &&
              !excludedKeyword &&
              !state?.hidden &&
              (preference.includeRead || !state?.read) &&
              !alreadyPublished &&
              !inCooldown &&
              !preference.avoidTopics.some((topic) => topics.includes(topic)),
          };
        }),
      )
    )
      .filter((item) => item.eligible)
      .sort((a, b) => b.score - a.score || b.date.getTime() - a.date.getTime() || a.candidate.id.localeCompare(b.candidate.id));
    const school = descriptors.filter((item) => item.allDelivery).slice(0, 10);
    const curated = descriptors.filter((item) => !item.allDelivery);
    const result = school.map((item) => item.candidate);
    const included = new Set(result.map((candidate) => candidate.id));
    const sourceCount = new Map<string, number>();
    for (const candidate of result)
      sourceCount.set(candidate.sourceId, (sourceCount.get(candidate.sourceId) ?? 0) + 1);
    const append = (candidate: Candidate): boolean => {
      if (result.length >= preference.candidateLimit || included.has(candidate.id) || (sourceCount.get(candidate.sourceId) ?? 0) >= 20)
        return false;
      result.push(candidate);
      included.add(candidate.id);
      sourceCount.set(candidate.sourceId, (sourceCount.get(candidate.sourceId) ?? 0) + 1);
      return true;
    };
    const sourceQueues = (items: typeof curated) => {
      const queues = new Map<string, typeof curated>();
      for (const item of items) {
        const queue = queues.get(item.sourceId) ?? [];
        queue.push(item);
        queues.set(item.sourceId, queue);
      }
      return queues;
    };
    const roundRobin = (
      queues: Map<string, typeof curated>,
      target: number,
    ) => {
      while (result.length < target) {
        let consumed = false;
        const queueHeads = [...queues.entries()]
          .filter(([, queue]) => queue.length > 0)
          .sort(([, left], [, right]) => {
            const leftHead = left[0]!;
            const rightHead = right[0]!;
            const leftScore =
              leftHead.score + 20 * Number(!sourceCount.has(leftHead.sourceId));
            const rightScore =
              rightHead.score +
              20 * Number(!sourceCount.has(rightHead.sourceId));
            return (
              rightScore - leftScore ||
              rightHead.date.getTime() - leftHead.date.getTime() ||
              leftHead.candidate.id.localeCompare(rightHead.candidate.id)
            );
          });
        for (const [, queue] of queueHeads) {
          const descriptor = queue.shift();
          if (descriptor) {
            consumed = true;
            append(descriptor.candidate);
          }
          if (result.length >= target) break;
        }
        if (!consumed) break;
      }
    };
    const reserve = Math.min(
      preference.candidateLimit - result.length,
      Math.ceil(preference.candidateLimit * preference.discoveryFraction),
    );
    roundRobin(sourceQueues(curated.filter((item) => item.discovery)), result.length + reserve);
    roundRobin(sourceQueues(curated), preference.candidateLimit);
    return result;
  }
  private draft(draft: DraftData | null): DraftData {
    if (!draft) throw new SifteraError("NOT_FOUND");
    return draft;
  }
  private assertLiveDraft(draft: DraftData): void {
    if (draft.run.status !== "draft") throw new SifteraError("RUN_NOT_DRAFT");
    if (new Date(draft.run.expiresAt) <= this.clock.now())
      throw new SifteraError("RUN_EXPIRED");
  }
  private async itemsForRun(
    tx: RepositoryRead,
    run: FeedRun,
  ): Promise<FeedItem[]> {
    return Promise.all(
      run.entries.map(async (entry) =>
        this.toFeedItem(
          await tx.getEditorialItem(entry.editorialItemId),
          await tx.getState(entry.candidateId),
          entry,
        ),
      ),
    );
  }
  private async libraryItems(tx: RepositoryRead): Promise<FeedItem[]> {
    const library = await tx.listLibrary(3000);
    if (!library.length) return [];
    // Dávkově, ne po položce: dřív to byly dva dotazy na každý článek v knihovně.
    const [items, states] = await Promise.all([
      tx.listEditorialItems(library.map((entry) => entry.editorialItemId)),
      tx.listStates(3000),
    ]);
    const byItemId = new Map(items.map((item) => [item.id, item]));
    const byCandidate = new Map(states.map((state) => [state.candidateId, state]));
    return library.map((libraryItem) =>
      this.toFeedItem(
        byItemId.get(libraryItem.editorialItemId) ?? null,
        byCandidate.get(libraryItem.candidateId) ?? null,
        null,
      ),
    );
  }
  private toFeedItem(
    stored: StoredEditorialItem | null,
    state: UserItemState | null,
    entry: FeedEntry | null,
  ): FeedItem {
    if (!stored) throw new SifteraError("INTEGRITY_ERROR");
    const item: EditorialItem = editorialItemSchema.parse({
      ...stored.proposal,
      id: stored.id,
      runId: stored.runId,
      producer: stored.producer,
      provenance: stored.provenance,
      medium: stored.medium,
      image: stored.image,
      media: stored.media,
      readingMinutes: stored.readingMinutes,
      createdAt: stored.createdAt,
    });
    return feedItemSchema.parse({
      entry,
      item,
      state: state ?? {
        candidateId: stored.candidateId,
        read: false,
        saved: false,
        hidden: false,
        seenAt: null,
        version: 0,
        updatedAt: stored.createdAt,
      },
      groups: stored.groups,
    });
  }
  private async publishSystemSchool(
    tx: RepositoryTransaction,
    candidate: Candidate,
    input: IngestInput,
    at: string,
  ): Promise<string> {
    const id = `system_${candidate.id}_${candidate.revision}`;
    const headline = candidate.title.slice(0, 180) || "Školní oznámení";
    const summary = candidate.excerpt.slice(0, 800);
    const proposal: EditorialProposal = {
      candidate: { candidateId: candidate.id, revision: candidate.revision },
      relatedCandidates: [],
      presentation: "school_notice",
      headline,
      summary,
      topics: ["school"],
      assessment: {
        relevance: 100,
        quality: "unknown",
        novelty: candidate.revision === 1 ? "new" : "update",
        basis: candidate.access === "full" ? "full_text" : "metadata",
      },
      whyIncluded: "Systémové školní oznámení.",
      openOriginal: true,
      distilledText: null,
      evidenceQuote: null,
      schoolDetails: [],
    };
    const source = await tx.getSourceMetadata(candidate.sourceId);
    await tx.putEditorialItem({
      id,
      runId: null,
      producer: "system",
      proposal,
      candidateId: candidate.id,
      revision: candidate.revision,
      createdAt: at,
      groups: input.groups ?? [],
      medium: candidate.medium,
      image: candidate.image,
      media: candidate.media,
      readingMinutes: null,
      provenance: [this.provenance(candidate, source)],
    });
    await tx.putLibraryItem({ candidateId: candidate.id, editorialItemId: id });
    return id;
  }
  private provenance(
    candidate: Candidate,
    source: { sourceName: string } | null,
  ): StoredEditorialItem["provenance"][number] {
    return {
      candidateId: candidate.id,
      revision: candidate.revision,
      sourceId: candidate.sourceId,
      sourceName: source?.sourceName ?? candidate.sourceId,
      canonicalUrl: candidate.canonicalUrl,
      title: candidate.title,
      publishedAt: candidate.publishedAt,
      access: candidate.access,
      contentHash: candidate.contentHash,
    };
  }
  private assertPrincipal(principal: Principal): void {
    if (!principal.uid) throw new SifteraError("UNAUTHENTICATED");
  }
  private assertUserOrSystem(principal: Principal): void {
    this.assertPrincipal(principal);
    if (principal.kind === "agent") throw new SifteraError("FORBIDDEN");
  }
  private assertHistoryAccess(principal: Principal): void {
    this.assertPrincipal(principal);
    if (
      principal.kind === "agent" &&
      !principal.scopes.includes("history:read")
    )
      throw new SifteraError("FORBIDDEN");
  }
  private assertScopes(
    principal: Principal,
    scopes: Array<"preferences:read" | "candidates:read" | "editorial:write">,
  ): void {
    this.assertPrincipal(principal);
    if (
      principal.kind !== "system" &&
      !scopes.every((scope) => principal.scopes.includes(scope))
    )
      throw new SifteraError("FORBIDDEN");
  }
  private assertScope(
    principal: Principal,
    scope:
      | "preferences:read"
      | "candidates:read"
      | "history:read"
      | "feedback:read"
      | "editorial:write"
      | "feed:publish",
  ): void {
    this.assertPrincipal(principal);
    if (principal.kind !== "system" && !principal.scopes.includes(scope))
      throw new SifteraError("FORBIDDEN");
  }
}
