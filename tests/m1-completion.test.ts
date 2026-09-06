import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  agentCredentialSchema,
  apiErrorSchema,
  feedbackInputSchema,
  feedItemSchema,
  pageSchema,
  sourceSchema,
  userSchema,
} from "../packages/shared/src/index.js";

describe("M1 public DTO runtime contracts", () => {
  it("accepts the normative FeedItem fixture and rejects an added response field", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../docs/contracts/examples.json", import.meta.url), "utf8"),
    ) as { feedItem: unknown };
    expect(feedItemSchema.safeParse(fixture.feedItem).success).toBe(true);
    expect(
      feedItemSchema.safeParse({ ...fixture.feedItem as object, unexpected: true }).success,
    ).toBe(false);
  });

  it("enforces strict public write and response DTOs", () => {
    expect(
      feedbackInputSchema.safeParse({
        id: "feedback_1",
        candidateId: "candidate_1",
        editorialItemId: "item_1",
        action: "good",
        target: { kind: "item" },
        comment: null,
      }).success,
    ).toBe(true);
    expect(
      feedbackInputSchema.safeParse({
        id: "feedback_1",
        candidateId: "candidate_1",
        editorialItemId: "item_1",
        action: "good",
        target: { kind: "item" },
        comment: null,
        createdAt: "2026-09-06T06:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      sourceSchema.safeParse({
        id: "source_1",
        name: "Source",
        config: { kind: "rss", url: "https://example.org/feed" },
        groups: ["school"],
        deliveryMode: "all",
        enabled: true,
        archivedAt: null,
        pollIntervalMinutes: 15,
        includeKeywords: [],
        excludeKeywords: [],
        createdAt: "2026-09-06T06:00:00.000Z",
        updatedAt: "2026-09-06T06:00:00.000Z",
        nextFetchAt: "2026-09-06T06:00:00.000Z",
        lastSuccessAt: null,
        consecutiveFailures: 0,
        lastErrorCode: null,
        etag: null,
        lastModified: null,
      }).success,
    ).toBe(true);
    expect(userSchema.safeParse({ id: "user_1", displayName: "", locale: "cs", timezone: "Europe/Prague", createdAt: "2026-09-06T06:00:00.000Z", updatedAt: "2026-09-06T06:00:00.000Z" }).success).toBe(true);
    expect(agentCredentialSchema.safeParse({ id: "credential_1", label: "Editor", scopes: ["editorial:write"], createdAt: "2026-09-06T06:00:00.000Z", expiresAt: "2026-10-06T06:00:00.000Z", revokedAt: null, lastUsedAt: null, rotatedFrom: null }).success).toBe(true);
    expect(pageSchema(userSchema).safeParse({ items: [], nextCursor: null }).success).toBe(true);
    expect(apiErrorSchema.safeParse({ error: { code: "NOT_FOUND", message: "Missing", requestId: "request_1", retryable: false } }).success).toBe(true);
  });
});
