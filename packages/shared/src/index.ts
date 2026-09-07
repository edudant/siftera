import { z } from "zod";

export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const isoSchema = z.string().datetime({ offset: true });
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  }, "must be a calendar date");
export const scopeSchema = z.enum([
  "preferences:read",
  "candidates:read",
  "history:read",
  "feedback:read",
  "editorial:write",
  "feed:publish",
]);
export const principalSchema = z
  .object({
    uid: idSchema,
    kind: z.enum(["user", "agent", "system"]),
    scopes: z.array(scopeSchema),
    credentialId: idSchema.optional(),
  })
  .strict();
export const mediumSchema = z.enum(["text", "video", "audio", "image"]);
export const presentationSchema = z.enum([
  "article",
  "long_read",
  "distilled_fact",
  "school_notice",
  "video",
  "audio",
  "discovery",
  "learning",
  "recommendation",
  "short_fun",
]);
export const accessSchema = z.enum(["full", "partial", "unavailable"]);
/** Jak výrazně se položka ukáže ve feedu. Rozhoduje editor, protože zná obsah i to, zda obraz něco přidává. */
export const emphasisSchema = z.enum(["lead", "standard", "compact", "text"]);
export const candidateRefSchema = z
  .object({ candidateId: idSchema, revision: z.number().int().min(1) })
  .strict();
export const imageMetaSchema = z
  .object({
    url: z.string().url().max(2048),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    alt: z.string().max(500),
  })
  .strict();
export const mediaMetaSchema = z
  .object({
    provider: z.enum(["youtube", "spotify", "external"]),
    externalId: z.string().max(300).nullable(),
    url: z.string().url().max(2048),
    durationSeconds: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const candidateSchema = z
  .object({
    id: idSchema,
    sourceId: idSchema,
    sourceIds: z.array(idSchema).min(1).max(50),
    revision: z.number().int().min(1),
    url: z.string().url().max(2048),
    canonicalUrl: z.string().url().max(2048),
    title: z.string().max(500),
    author: z.string().max(300).nullable(),
    publishedAt: isoSchema.nullable(),
    discoveredAt: isoSchema,
    updatedAt: isoSchema,
    excerpt: z.string().max(10_000),
    medium: mediumSchema,
    categories: z.array(z.string().max(80)).max(30),
    image: imageMetaSchema.nullable(),
    media: mediaMetaSchema.nullable(),
    access: accessSchema,
    contentHash: z.string().max(128).nullable(),
    contentRef: z.string().max(500).nullable(),
    externalId: z.string().max(500).nullable(),
    expiresAt: isoSchema.nullable(),
  })
  .strict();
export const candidateContentSchema = z
  .object({
    candidateId: idSchema,
    revision: z.number().int().min(1),
    access: accessSchema,
    text: z.string().max(200_000),
    contentHash: z.string().min(1).max(128),
    extractedAt: isoSchema,
    extractorVersion: z.string().min(1).max(100),
    truncated: z.boolean(),
    originalCharacterCount: z.number().int().nonnegative(),
  })
  .strict();
export const sourceAdapterConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rss"), url: z.string().url().max(2048) }).strict(),
  z
    .object({
      kind: z.literal("web_page"),
      url: z.string().url().max(2048),
      itemSelector: z.string().min(1).max(200),
      linkSelector: z.string().min(1).max(200),
      titleSelector: z.string().min(1).max(200).optional(),
      dateSelector: z.string().min(1).max(200).optional(),
      contentSelector: z.string().min(1).max(200).optional(),
      dateFormat: z.enum(["iso", "cs_date", "none"]),
      maxPages: z.literal(1),
    })
    .strict(),
]);
export const sourceSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(200),
    config: sourceAdapterConfigSchema,
    groups: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)).max(10),
    deliveryMode: z.enum(["curated", "all"]),
    enabled: z.boolean(),
    archivedAt: isoSchema.nullable(),
    pollIntervalMinutes: z.number().int().min(15).max(1_440),
    includeKeywords: z.array(z.string().min(1).max(80)).max(30),
    excludeKeywords: z.array(z.string().min(1).max(80)).max(30),
    createdAt: isoSchema,
    updatedAt: isoSchema,
    nextFetchAt: isoSchema,
    lastSuccessAt: isoSchema.nullable(),
    consecutiveFailures: z.number().int().nonnegative(),
    lastErrorCode: z.string().max(100).nullable(),
    etag: z.string().max(500).nullable(),
    lastModified: z.string().max(500).nullable(),
  })
  .strict();
/** Uživatelská kategorie je pojmenovaný filtr nad tématy a zdroji, ne škatulka pro AI editora (ADR-016). */
/** Ikona kanálu. Uzavřený seznam, aby UI nemuselo kreslit cokoli, co přijde z dat. */
export const channelIconSchema = z.enum(["news", "tech", "podcast", "video", "science", "work", "star", "world"]);
export const feedCategorySchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).max(40),
    icon: channelIconSchema.optional(),
    topics: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)).max(20),
    sourceIds: z.array(idSchema).max(40),
  })
  .strict()
  .refine((value) => value.topics.length + value.sourceIds.length > 0, {
    message: "category must match at least one topic or source",
  });
export const preferenceSchema = z
  .object({
    version: z.number().int().min(1),
    instructions: z.string().max(6000),
    language: z.string().min(2).max(16),
    timezone: z.string().min(1).max(100),
    preferredTopics: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/))
      .max(30),
    avoidTopics: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)).max(30),
    desiredTopicMix: z
      .array(
        z
          .object({
            topic: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
            weight: z.number().positive(),
          })
          .strict(),
      )
      .max(10),
    maxPerTopic: z.number().int().min(1).max(50),
    maxPerSource: z.number().int().min(1).max(50),
    discoveryFraction: z.number().min(0).max(0.5),
    longReadTarget: z.number().int().min(0).max(10),
    entertainmentFraction: z.number().min(0).max(1),
    targetItems: z.number().int().min(1).max(50),
    candidateLimit: z.number().int().min(10).max(80),
    contentReadLimit: z.number().int().min(1).max(40),
    maxCandidateAgeDays: z.number().int().min(1).max(30),
    includeRead: z.boolean(),
    behaviorEnabled: z.boolean(),
    categories: z.array(feedCategorySchema).max(12).default([]),
    updatedAt: isoSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.targetItems > value.candidateLimit)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetItems"],
        message: "must not exceed candidateLimit",
      });
    if (value.longReadTarget > value.targetItems)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["longReadTarget"],
        message: "must not exceed targetItems",
      });
  });
export const assessmentSchema = z
  .object({
    relevance: z.number().int().min(0).max(100),
    quality: z.enum(["useful", "thin", "unknown"]),
    novelty: z.enum(["new", "update", "repeat"]),
    basis: z.enum(["full_text", "excerpt", "metadata"]),
  })
  .strict();
export const schoolDetailSchema = z
  .object({
    kind: z.enum([
      "homework",
      "test",
      "learning_topic",
      "teacher_link",
      "announcement",
    ]),
    text: z.string().min(1).max(500),
    dueDate: dateSchema.nullable(),
    subject: z.string().min(1).max(80).nullable(),
    origin: z.enum(["teacher", "ai_suggestion"]),
  })
  .strict();
const editorialProposalObject = z
  .object({
    candidate: candidateRefSchema,
    relatedCandidates: z.array(candidateRefSchema).max(5),
    presentation: presentationSchema,
    headline: z.string().min(1).max(180),
    summary: z.string().max(800),
    topics: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/))
      .min(1)
      .max(5)
      .refine((xs) => new Set(xs).size === xs.length, "must be unique"),
    assessment: assessmentSchema,
    whyIncluded: z.string().min(1).max(240),
    emphasis: emphasisSchema.optional(),
    imageTreatment: z.enum(["auto", "show", "hide"]).optional(),
    openOriginal: z.boolean(),
    distilledText: z.string().min(1).max(500).nullable(),
    evidenceQuote: z.string().min(1).max(500).nullable(),
    schoolDetails: z.array(schoolDetailSchema).max(20),
  })
  .strict();
type EditorialProposalFields = z.infer<typeof editorialProposalObject>;
const validateEditorialProposal = (
  value: EditorialProposalFields,
  ctx: z.RefinementCtx,
) => {
    const distilled = value.presentation === "distilled_fact";
    if (
      distilled &&
      (!value.distilledText ||
        !value.evidenceQuote ||
        value.assessment.basis !== "full_text" ||
        value.openOriginal)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "distilled_fact requires full-text evidence and openOriginal=false",
      });
    if (
      !distilled &&
      (value.distilledText !== null || value.evidenceQuote !== null)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "only distilled_fact may supply distilled fields",
      });
    if (
      value.presentation !== "school_notice" &&
      value.schoolDetails.length !== 0
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "schoolDetails belong only to school_notice",
      });
  };
export const editorialProposalSchema = editorialProposalObject.superRefine(
  validateEditorialProposal,
);
export const editorialSubmissionSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: idSchema,
    batchId: idSchema,
    editor: z
      .object({
        client: z.string().min(1).max(80),
        model: z.string().min(1).max(100).nullable(),
        promptVersion: z.string().min(1).max(40),
      })
      .strict(),
    items: z.array(editorialProposalSchema).max(10),
    rejected: z
      .array(
        z
          .object({
            candidate: candidateRefSchema,
            reason: z.enum([
              "irrelevant",
              "low_value",
              "duplicate_story",
              "already_seen",
              "insufficient_content",
            ]),
          })
          .strict(),
      )
      .max(80),
  })
  .strict();
export const itemStateSchema = z
  .object({
    candidateId: idSchema,
    read: z.boolean(),
    saved: z.boolean(),
    hidden: z.boolean(),
    /** Kdy měl uživatel položku poprvé před očima (ADR-015). Slabší signál než `read`; nikdy ji neskrývá. */
    seenAt: isoSchema.nullable().default(null),
    version: z.number().int().nonnegative(),
    updatedAt: isoSchema,
  })
  .strict();
export const feedbackTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("item") }).strict(),
  z
    .object({
      kind: z.literal("topic"),
      value: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
    })
    .strict(),
  z.object({ kind: z.literal("source"), sourceId: idSchema }).strict(),
]);
export const feedbackInputSchema = z
  .object({
    id: idSchema,
    candidateId: idSchema,
    editorialItemId: idSchema,
    action: z.enum(["more", "good", "less", "discovery"]),
    target: feedbackTargetSchema,
    comment: z.string().max(500).nullable(),
  })
  .strict();
export const feedbackSchema = feedbackInputSchema.extend({ createdAt: isoSchema }).strict();
export const provenanceSchema = z
  .object({
    candidateId: idSchema,
    revision: z.number().int().min(1),
    sourceId: idSchema,
    sourceName: z.string().min(1).max(200),
    canonicalUrl: z.string().url().max(2048),
    title: z.string().max(500),
    publishedAt: isoSchema.nullable(),
    access: accessSchema,
    contentHash: z.string().max(128).nullable(),
  })
  .strict();
export const editorialItemSchema = editorialProposalObject
  .extend({
    id: idSchema,
    runId: idSchema.nullable(),
    producer: z.enum(["agent", "system"]),
    provenance: z.array(provenanceSchema).min(1).max(6),
    medium: mediumSchema,
    image: imageMetaSchema.nullable(),
    media: mediaMetaSchema.nullable(),
    readingMinutes: z.number().int().positive().nullable(),
    createdAt: isoSchema,
  })
  .strict()
  .superRefine(validateEditorialProposal);
export const feedEntrySchema = z
  .object({
    editorialItemId: idSchema,
    candidateId: idSchema,
    rank: z.number().int().nonnegative(),
  })
  .strict();
export const feedRunSchema = z
  .object({
    id: idSchema,
    status: z.enum(["draft", "published", "aborted", "expired"]),
    generation: z.number().int().positive(),
    startedAt: isoSchema,
    expiresAt: isoSchema,
    publishedAt: isoSchema.nullable(),
    preferenceVersion: z.number().int().positive(),
    candidateRefs: z.array(candidateRefSchema).max(80),
    entries: z.array(feedEntrySchema).max(50),
    editor: editorialSubmissionSchema.shape.editor.nullable(),
    publishedRequestKey: idSchema.nullable(),
    publishedPayloadHash: z.string().max(128).nullable(),
  })
  .strict();
export const feedItemSchema = z
  .object({
    entry: feedEntrySchema.nullable(),
    item: editorialItemSchema,
    state: itemStateSchema,
    groups: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)).max(10),
  })
  .strict();
export const userSchema = z
  .object({
    id: idSchema,
    displayName: z.string().max(200),
    locale: z.string().min(2).max(16),
    timezone: z.string().min(1).max(100),
    createdAt: isoSchema,
    updatedAt: isoSchema,
  })
  .strict();
export const agentCredentialSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).max(200),
    scopes: z.array(scopeSchema).min(1).max(6),
    createdAt: isoSchema,
    expiresAt: isoSchema,
    revokedAt: isoSchema.nullable(),
    lastUsedAt: isoSchema.nullable(),
    rotatedFrom: idSchema.nullable(),
  })
  .strict();
export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().min(1).max(4096).nullable() }).strict();
export const apiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1).max(100),
        message: z.string().max(1000),
        requestId: idSchema,
        retryable: z.boolean(),
        details: z
          .array(z.object({ field: z.string().min(1).max(200), reason: z.string().min(1).max(500) }).strict())
          .max(50)
          .optional(),
      })
      .strict(),
  })
  .strict();
export type ID = z.infer<typeof idSchema>;
export type Principal = z.infer<typeof principalSchema>;
export type User = z.infer<typeof userSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type SourceAdapterConfig = z.infer<typeof sourceAdapterConfigSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type CandidateContent = z.infer<typeof candidateContentSchema>;
export type PreferenceProfile = z.infer<typeof preferenceSchema>;
export type FeedCategory = z.infer<typeof feedCategorySchema>;
export type ChannelIcon = z.infer<typeof channelIconSchema>;
export type EditorialProposal = z.infer<typeof editorialProposalSchema>;
export type EditorialSubmission = z.infer<typeof editorialSubmissionSchema>;
export type UserItemState = z.infer<typeof itemStateSchema>;
export type FeedRun = z.infer<typeof feedRunSchema>;
export type FeedEntry = z.infer<typeof feedEntrySchema>;
export type Presentation = z.infer<typeof presentationSchema>;
export type Emphasis = z.infer<typeof emphasisSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
export type EditorialItem = z.infer<typeof editorialItemSchema>;
export type FeedItem = z.infer<typeof feedItemSchema>;
export type Feedback = z.infer<typeof feedbackSchema>;
export type FeedbackInput = z.infer<typeof feedbackInputSchema>;
export type FeedbackTarget = z.infer<typeof feedbackTargetSchema>;
export type AgentCredential = z.infer<typeof agentCredentialSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type Page<T> = z.infer<
  ReturnType<typeof pageSchema<z.ZodType<T>>>
>;
