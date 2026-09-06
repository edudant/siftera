/**
 * JSON Schema handed to a human-operated external editor. Runtime acceptance
 * remains the shared Zod schema in core; this document intentionally mirrors
 * its public v1 boundary rather than exposing internal storage fields.
 */
const id = { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" };
const topic = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,39}$" };
const candidateRef = {
  type: "object", additionalProperties: false,
  properties: { candidateId: id, revision: { type: "integer", minimum: 1 } },
  required: ["candidateId", "revision"],
};
const editorialItem = {
  type: "object", additionalProperties: false,
  properties: {
    candidate: candidateRef,
    relatedCandidates: { type: "array", items: candidateRef, maxItems: 5 },
    presentation: { enum: ["article", "long_read", "distilled_fact", "school_notice", "video", "audio", "discovery", "learning", "recommendation", "short_fun"] },
    headline: { type: "string", minLength: 1, maxLength: 180 },
    summary: { type: "string", maxLength: 800 },
    topics: { type: "array", items: topic, minItems: 1, maxItems: 5, uniqueItems: true },
    assessment: {
      type: "object", additionalProperties: false,
      properties: { relevance: { type: "integer", minimum: 0, maximum: 100 }, quality: { enum: ["useful", "thin", "unknown"] }, novelty: { enum: ["new", "update", "repeat"] }, basis: { enum: ["full_text", "excerpt", "metadata"] } },
      required: ["relevance", "quality", "novelty", "basis"],
    },
    whyIncluded: { type: "string", minLength: 1, maxLength: 240 },
    openOriginal: { type: "boolean" },
    distilledText: { anyOf: [{ type: "string", minLength: 1, maxLength: 500 }, { type: "null" }] },
    evidenceQuote: { anyOf: [{ type: "string", minLength: 1, maxLength: 500 }, { type: "null" }] },
    schoolDetails: {
      type: "array", maxItems: 20,
      items: {
        type: "object", additionalProperties: false,
        properties: { kind: { enum: ["homework", "test", "learning_topic", "teacher_link", "announcement"] }, text: { type: "string", minLength: 1, maxLength: 500 }, dueDate: { anyOf: [{ type: "string", format: "date" }, { type: "null" }] }, subject: { anyOf: [{ type: "string", minLength: 1, maxLength: 80 }, { type: "null" }] }, origin: { enum: ["teacher", "ai_suggestion"] } },
        required: ["kind", "text", "dueDate", "subject", "origin"],
      },
    },
  },
  required: ["candidate", "relatedCandidates", "presentation", "headline", "summary", "topics", "assessment", "whyIncluded", "openOriginal", "distilledText", "evidenceQuote", "schoolDetails"],
  allOf: [
    {
      if: { properties: { presentation: { const: "distilled_fact" } } },
      then: { properties: { openOriginal: { const: false }, distilledText: { type: "string", minLength: 1, maxLength: 500 }, evidenceQuote: { type: "string", minLength: 1, maxLength: 500 }, assessment: { properties: { basis: { const: "full_text" } } } } },
      else: { properties: { distilledText: { type: "null" }, evidenceQuote: { type: "null" } } },
    },
    {
      if: { properties: { presentation: { not: { const: "school_notice" } } } },
      then: { properties: { schoolDetails: { maxItems: 0 } } },
    },
  ],
};

export const editorialSubmissionJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://siftera.local/schemas/editorial-result.v1.json",
  title: "Siftera EditorialSubmission v1",
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    runId: id,
    batchId: id,
    editor: {
      type: "object", additionalProperties: false,
      properties: { client: { type: "string", minLength: 1, maxLength: 80 }, model: { anyOf: [{ type: "string", minLength: 1, maxLength: 100 }, { type: "null" }] }, promptVersion: { type: "string", minLength: 1, maxLength: 40 } },
      required: ["client", "model", "promptVersion"],
    },
    items: { type: "array", items: editorialItem, maxItems: 10 },
    rejected: { type: "array", items: { type: "object", additionalProperties: false, properties: { candidate: candidateRef, reason: { enum: ["irrelevant", "low_value", "duplicate_story", "already_seen", "insufficient_content"] } }, required: ["candidate", "reason"] }, maxItems: 80 },
  },
  required: ["schemaVersion", "runId", "batchId", "editor", "items", "rejected"],
} as const;
