import { describe, expect, it } from "vitest";
import { EditorialService, defaultPreferences, type IngestInput } from "../packages/core/src/index.js";
import { MemoryContentStore, MemoryRepository } from "../packages/storage/src/index.js";
import type { Candidate, EditorialProposal, PreferenceProfile, Principal } from "../packages/shared/src/index.js";

const user: Principal = { uid: "reviewer", kind: "user", scopes: [] };
const agent: Principal = { uid: user.uid, kind: "agent", scopes: ["preferences:read", "candidates:read", "history:read", "feedback:read", "editorial:write", "feed:publish"] };
function setup() {
  let time = Date.parse("2026-09-06T06:00:00.000Z");
  let sequence = 0;
  const clock = { now: () => new Date(time) };
  const repository = new MemoryRepository();
  const service = new EditorialService(repository, new MemoryContentStore(), clock, { next: () => `next_${++sequence}` });
  return { service, repository, clock, advance: (days: number) => { time += days * 86_400_000; } };
}
function source(key: string, patch: Partial<IngestInput> = {}): IngestInput {
  return { sourceId: "source", sourceName: "Synthetic publisher", url: `https://example.org/${key}`, title: key, excerpt: "A short excerpt", body: "An entire synthetic article.", categories: ["science"], ...patch };
}
function proposal(candidate: Candidate): EditorialProposal {
  return { candidate: { candidateId: candidate.id, revision: candidate.revision }, relatedCandidates: [], presentation: "article", headline: candidate.title, summary: "A preview", topics: ["science"], assessment: { relevance: 60, quality: "unknown", novelty: "new", basis: "excerpt" }, whyIncluded: "Relevant source", openOriginal: true, distilledText: null, evidenceQuote: null, schoolDetails: [] };
}
function batch(runId: string, items: EditorialProposal[] = [], rejected: { candidate: { candidateId: string; revision: number }; reason: "irrelevant" }[] = [], batchId = "batch") {
  return { schemaVersion: 1, runId, batchId, editor: { client: "continuation-review", model: null, promptVersion: "v1" }, items, rejected };
}
async function preferences(service: EditorialService, now: Date, version: number, patch: Partial<PreferenceProfile>) {
  return service.savePreferences(user, version, { ...defaultPreferences(now), ...patch });
}
async function published(service: EditorialService, candidate: Candidate) {
  const run = await service.beginRun(agent, "begin");
  await service.submit(agent, batch(run.id, [proposal(candidate)]));
  return service.publish(agent, run.id, "publish", [candidate.id]);
}

describe("Continuation review: rejected decisions", () => {
  it("suppresses a rejected revision until preferences change", async () => {
    const { service, clock } = setup();
    const candidate = (await service.ingest(user, source("one"))).candidate;
    const run = await service.beginRun(agent, "begin");
    await service.submit(agent, batch(run.id, [], [{ candidate: { candidateId: candidate.id, revision: 1 }, reason: "irrelevant" }]));
    await service.abort(agent, run.id);
    const next = await service.beginRun(agent, "next");
    expect(next.candidateRefs).toHaveLength(0);
    await service.abort(agent, next.id);
    await preferences(service, clock.now(), 1, { instructions: "Consider this source again" });
    expect((await service.beginRun(agent, "changed")).candidateRefs.map((ref) => ref.candidateId)).toContain(candidate.id);
  });

  it("allows a new revision immediately and expires cooldown after seven days", async () => {
    const { service, clock, advance } = setup();
    await preferences(service, clock.now(), 1, { maxCandidateAgeDays: 30 });
    const candidate = (await service.ingest(user, source("one"))).candidate;
    const run = await service.beginRun(agent, "begin");
    await service.submit(agent, batch(run.id, [], [{ candidate: { candidateId: candidate.id, revision: 1 }, reason: "irrelevant" }]));
    await service.abort(agent, run.id);
    const changed = (await service.ingest(user, source("one", { title: "Revised source content" }))).candidate;
    const next = await service.beginRun(agent, "next");
    expect(next.candidateRefs).toContainEqual({ candidateId: candidate.id, revision: 2 });
    await service.submit(agent, batch(next.id, [], [{ candidate: { candidateId: changed.id, revision: 2 }, reason: "irrelevant" }]));
    await service.abort(agent, next.id);
    advance(7.01);
    expect((await service.beginRun(agent, "after_cooldown")).candidateRefs).toContainEqual({ candidateId: candidate.id, revision: 2 });
  });

  it("rejects foreign refs atomically without suppressing a valid candidate", async () => {
    const { service } = setup();
    const candidate = (await service.ingest(user, source("one"))).candidate;
    const run = await service.beginRun(agent, "begin");
    await expect(service.submit(agent, batch(run.id, [], [
      { candidate: { candidateId: candidate.id, revision: 1 }, reason: "irrelevant" },
      { candidate: { candidateId: "foreign", revision: 1 }, reason: "irrelevant" },
    ]))).rejects.toThrow();
    await service.abort(agent, run.id);
    expect((await service.beginRun(agent, "next")).candidateRefs.map((ref) => ref.candidateId)).toContain(candidate.id);
  });

  it("rejects a batch that both proposes and rejects the same candidate", async () => {
    const { service } = setup();
    const candidate = (await service.ingest(user, source("one"))).candidate;
    const run = await service.beginRun(agent, "begin");
    await expect(service.submit(agent, batch(run.id, [proposal(candidate)], [{ candidate: { candidateId: candidate.id, revision: 1 }, reason: "irrelevant" }]))).rejects.toThrow();
    await expect(service.publish(agent, run.id, "publish", [candidate.id])).rejects.toThrow();
  });
});

describe("Continuation review: user operation retries", () => {
  it("replays a state operation before checking its now-stale base version", async () => {
    const { service } = setup();
    const candidate = (await service.ingest(user, source("one"))).candidate;
    const first = await service.patchState(user, candidate.id, 0, { saved: true }, "save_once");
    const replay = await service.patchState(user, candidate.id, 0, { saved: true }, "save_once");
    expect(replay).toEqual(first);
    await expect(service.patchState(user, candidate.id, 0, { saved: false }, "save_once")).rejects.toThrow();
    const changed = await service.patchState(user, candidate.id, first.version, { read: true }, "read_once");
    expect(changed.version).toBe(2);
  });

  it("makes full feedback idempotent and rejects changed targets or foreign ownership", async () => {
    const { service } = setup();
    const candidate = (await service.ingest(user, source("one"))).candidate;
    const feed = await published(service, candidate);
    const input = { id: "feedback_once", candidateId: candidate.id, editorialItemId: feed.run.entries[0]!.editorialItemId, action: "good" as const, target: { kind: "topic" as const, value: "science" }, comment: "Useful without asking for more" };
    const before = await service.getPreferences(user);
    const first = await service.feedback(user, input);
    expect(await service.feedback(user, input)).toEqual(first);
    expect(first).toMatchObject(input);
    await expect(service.feedback(user, { ...input, action: "more" })).rejects.toThrow();
    await expect(service.feedback({ ...user, uid: "other" }, input)).rejects.toThrow();
    await expect(service.feedback(user, { ...input, id: "wrong_topic", target: { kind: "topic", value: "unrelated" } })).rejects.toThrow();
    await expect(service.feedback(user, { ...input, id: "wrong_source", target: { kind: "source", sourceId: "unrelated" } })).rejects.toThrow();
    expect(await service.getPreferences(user)).toEqual(before);
  });
});

describe("Continuation review: selection", () => {
  it("bounds school card text while preserving the source title and full content", async () => {
    const { service } = setup();
    const title = "D".repeat(250);
    const excerpt = "O".repeat(1500);
    const candidate = (await service.ingest(user, source("school_long", { title, excerpt, body: excerpt, deliveryMode: "all", groups: ["school"] }))).candidate;
    const card = (await service.libraryFeed(user))[0]!.item;
    expect(card.headline.length).toBeLessThanOrEqual(180);
    expect(card.summary.length).toBeLessThanOrEqual(800);
    expect(card.provenance[0]!.title).toBe(title);
    expect((await service.getContent(user, candidate.id, 1)).text).toBe(excerpt);
  });

  it("gives an unrepresented source the documented diversity boost after reservation", async () => {
    const { service, clock } = setup();
    await preferences(service, clock.now(), 1, { targetItems: 10, candidateLimit: 10, preferredTopics: ["technology"], discoveryFraction: .2 });
    for (let i = 0; i < 2; i++) await service.ingest(user, source(`discovery_${i}`, { sourceId: "source_a", categories: ["science"] }));
    for (let i = 0; i < 10; i++) await service.ingest(user, source(`preferred_${i}`, { sourceId: "source_a", categories: ["technology"] }));
    const outside = (await service.ingest(user, source("outside", { sourceId: "source_b", categories: ["technology"], publishedAt: "2026-09-03T06:00:00.000Z" }))).candidate;
    const run = await service.beginRun(agent, "begin");
    expect(run.candidateRefs[2]!.candidateId).toBe(outside.id);
  });

  it("continues round-robin after all queue heads were already reserved", async () => {
    const { service, clock } = setup();
    await preferences(service, clock.now(), 1, { targetItems: 10, candidateLimit: 10, preferredTopics: ["technology"], discoveryFraction: .2 });
    for (let index = 0; index < 10; index++) await service.ingest(user, source(`discovery_${index}`, { sourceId: `source_${index % 2}` }));
    expect((await service.beginRun(agent, "begin")).candidateRefs).toHaveLength(10);
  });

  it("uses discovery date to age out implausible future publication dates", async () => {
    const { service, advance } = setup();
    const old = (await service.ingest(user, source("future", { publishedAt: "2027-01-01T00:00:00.000Z" }))).candidate;
    advance(10);
    const fresh = (await service.ingest(user, source("fresh"))).candidate;
    const run = await service.beginRun(agent, "begin");
    expect(run.candidateRefs.map((ref) => ref.candidateId)).not.toContain(old.id);
    expect(run.candidateRefs.map((ref) => ref.candidateId)).toContain(fresh.id);
  });

  it("persists a second source association even when duplicate content does not change", async () => {
    const { service, repository } = setup();
    const first = (await service.ingest(user, source("same"))).candidate;
    await service.ingest(user, source("same", { sourceId: "second", sourceName: "Second source" }));
    const stored = await repository.read(user.uid, (tx) => tx.getCandidate(first.id));
    expect(stored?.candidate.sourceIds).toEqual(["source", "second"]);
    expect(stored?.candidate.revision).toBe(1);
  });
});
