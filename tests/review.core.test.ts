import { describe, expect, it } from "vitest";
import { createServer } from "../apps/server/src/app.js";
import {
  EditorialService,
  defaultPreferences,
  type IngestInput,
} from "../packages/core/src/index.js";
import {
  MemoryContentStore,
  MemoryRepository,
} from "../packages/storage/src/index.js";
import type {
  Candidate,
  EditorialProposal,
  PreferenceProfile,
  Principal,
} from "../packages/shared/src/index.js";

const owner: Principal = { uid: "owner", kind: "user", scopes: [] };
const editor: Principal = {
  uid: owner.uid,
  kind: "agent",
  scopes: [
    "preferences:read",
    "candidates:read",
    "history:read",
    "feedback:read",
    "editorial:write",
    "feed:publish",
  ],
};
const other: Principal = { ...editor, uid: "other" };
const content = "A complete synthetic article about a useful technical change.";

function setup() {
  let timestamp = Date.parse("2026-09-06T06:00:00.000Z");
  let sequence = 0;
  const clock = { now: () => new Date(timestamp) };
  const service = new EditorialService(
    new MemoryRepository(),
    new MemoryContentStore(),
    clock,
    { next: () => `review_${++sequence}` },
  );
  return {
    service,
    clock,
    advance: (minutes: number) => {
      timestamp += minutes * 60_000;
    },
  };
}

function input(key: string, extra: Partial<IngestInput> = {}): IngestInput {
  return {
    sourceId: "source",
    sourceName: "Synthetic source",
    url: `https://example.org/${key}`,
    title: key,
    excerpt: "Synthetic excerpt",
    body: content,
    categories: ["technology"],
    ...extra,
  };
}

function article(
  candidate: Candidate,
  extra: Partial<EditorialProposal> = {},
): EditorialProposal {
  return {
    candidate: { candidateId: candidate.id, revision: candidate.revision },
    relatedCandidates: [],
    presentation: "article",
    headline: candidate.title,
    summary: "A short preview.",
    topics: ["technology"],
    assessment: {
      relevance: 70,
      quality: "unknown",
      novelty: "new",
      basis: "excerpt",
    },
    whyIncluded: "Relevant to the selected sources.",
    openOriginal: true,
    distilledText: null,
    evidenceQuote: null,
    schoolDetails: [],
    ...extra,
  };
}

async function submit(
  service: EditorialService,
  runId: string,
  items: EditorialProposal[],
  batchId = "batch",
) {
  return service.submit(editor, {
    schemaVersion: 1,
    runId,
    batchId,
    editor: { client: "review", model: null, promptVersion: "v1" },
    items,
    rejected: [],
  });
}

async function preferences(
  service: EditorialService,
  now: Date,
  patch: Partial<PreferenceProfile>,
) {
  return service.savePreferences(owner, 1, {
    ...defaultPreferences(now),
    ...patch,
  });
}

describe("Independent review: run invariants", () => {
  it("keeps original and related provenance immutable after source updates", async () => {
    const { service } = setup();
    const main = (await service.ingest(owner, input("main"))).candidate;
    const related = (await service.ingest(owner, input("related", { sourceId: "related_source", sourceName: "Related publisher" }))).candidate;
    const run = await service.beginRun(editor, "begin");
    await submit(service, run.id, [article(main, { relatedCandidates: [{ candidateId: related.id, revision: 1 }] })]);
    const published = await service.publish(editor, run.id, "publish", [main.id]);
    expect(published.items[0]!.item.provenance).toHaveLength(2);
    expect(published.items[0]!.item.provenance[1]).toMatchObject({ candidateId: related.id, sourceName: "Related publisher", revision: 1 });
    const originalItem = structuredClone(published.items[0]!.item);
    await service.ingest(owner, input("main", { title: "Updated title", body: "Updated article text." }));
    await service.ingest(owner, input("related", { sourceId: "related_source", sourceName: "Related publisher", title: "Updated related title" }));
    expect((await service.latestFeed(owner)).items[0]!.item).toEqual(originalItem);
  });
  it("replays begin operation after publication without creating a second run", async () => {
    const { service } = setup();
    const run = await service.beginRun(editor, "begin_once");
    expect((await service.beginRun(editor, "begin_alias")).id).toBe(run.id);
    await service.publish(editor, run.id, "publish", []);
    expect((await service.beginRun(editor, "begin_once")).id).toBe(run.id);
    expect((await service.beginRun(editor, "begin_alias")).id).toBe(run.id);
    expect((await service.beginRun(editor, "begin_new")).id).not.toBe(run.id);
  });

  it("does not select an already published revision for the next daily run", async () => {
    const { service } = setup();
    const candidate = (await service.ingest(owner, input("one"))).candidate;
    const run = await service.beginRun(editor, "begin");
    await submit(service, run.id, [article(candidate)]);
    await service.publish(editor, run.id, "publish", [candidate.id]);
    const next = await service.beginRun(editor, "begin_next");
    expect(next.candidateRefs.map((ref) => ref.candidateId)).not.toContain(
      candidate.id,
    );
  });

  it("rejects stale preferences at publish and preserves the previous feed", async () => {
    const { service, clock } = setup();
    const previous = await service.beginRun(editor, "initial");
    await service.publish(editor, previous.id, "initial_publish", []);
    const candidate = (await service.ingest(owner, input("one"))).candidate;
    const run = await service.beginRun(editor, "begin");
    await submit(service, run.id, [article(candidate)]);
    await preferences(service, clock.now(), {
      instructions: "A changed preference.",
    });
    await expect(
      service.publish(editor, run.id, "publish", [candidate.id]),
    ).rejects.toMatchObject({ code: "STALE_PREFERENCES" });
    expect((await service.latestFeed(owner)).run?.id).toBe(previous.id);
  });

  it("rejects a related revision changed after submission, without publishing anything", async () => {
    const { service } = setup();
    const main = (await service.ingest(owner, input("main"))).candidate;
    const related = (await service.ingest(owner, input("related"))).candidate;
    const run = await service.beginRun(editor, "begin");
    await submit(service, run.id, [
      article(main, {
        relatedCandidates: [{ candidateId: related.id, revision: 1 }],
      }),
    ]);
    await service.ingest(
      owner,
      input("related", { title: "Changed related source" }),
    );
    await expect(
      service.publish(editor, run.id, "publish", [main.id]),
    ).rejects.toMatchObject({ code: "CANDIDATE_CHANGED" });
    expect((await service.latestFeed(owner)).run).toBeNull();
  });

  it("enforces avoidTopics even when AI adds a topic missing from source metadata", async () => {
    const { service, clock } = setup();
    await preferences(service, clock.now(), { avoidTopics: ["gambling"] });
    const candidate = (await service.ingest(owner, input("one"))).candidate;
    const run = await service.beginRun(editor, "begin");
    await expect(
      (async () => {
        await submit(service, run.id, [
          article(candidate, { topics: ["gambling"] }),
        ]);
        await service.publish(editor, run.id, "publish", [candidate.id]);
      })(),
    ).rejects.toThrow();
    expect((await service.latestFeed(owner)).run).toBeNull();
  });

  it("returns server-owned provenance and the normative feed DTO", async () => {
    const { service } = setup();
    const candidate = (await service.ingest(owner, input("one"))).candidate;
    const run = await service.beginRun(editor, "begin");
    await submit(service, run.id, [article(candidate)]);
    const published = await service.publish(editor, run.id, "publish", [
      candidate.id,
    ]);
    expect(published.items[0]).toMatchObject({
      entry: { candidateId: candidate.id, rank: 0 },
      item: {
        candidate: { candidateId: candidate.id, revision: 1 },
        provenance: [
          {
            canonicalUrl: candidate.canonicalUrl,
            sourceName: "Synthetic source",
          },
        ],
      },
      state: { candidateId: candidate.id, read: false },
      groups: [],
    });
  });
});

describe("Independent review: reading and identity", () => {
  it("requires a read receipt, not merely a cached complete article", async () => {
    const { service } = setup();
    const candidate = (await service.ingest(owner, input("one"))).candidate;
    const run = await service.beginRun(editor, "begin");
    await expect(
      submit(service, run.id, [
        article(candidate, {
          presentation: "long_read",
          assessment: {
            relevance: 90,
            quality: "useful",
            novelty: "new",
            basis: "full_text",
          },
        }),
      ]),
    ).rejects.toThrow();
  });

  it("does not serve run content after expiration", async () => {
    const { service, advance } = setup();
    const candidate = (await service.ingest(owner, input("one"))).candidate;
    const run = await service.beginRun(editor, "begin");
    advance(61);
    await expect(
      service.readRunContent(editor, run.id, candidate.id, 1),
    ).rejects.toThrow();
  });

  it("rejects changed and foreign candidates when reading a run", async () => {
    const { service } = setup();
    const candidate = (await service.ingest(owner, input("one"))).candidate;
    const run = await service.beginRun(editor, "begin");
    await expect(
      service.readRunContent(other, run.id, candidate.id, 1),
    ).rejects.toThrow();
    await service.ingest(
      owner,
      input("one", { body: "A genuinely changed complete body." }),
    );
    await expect(
      service.readRunContent(editor, run.id, candidate.id, 1),
    ).rejects.toThrow();
  });

  it("counts distinct content reads and does not double-charge a retry", async () => {
    const { service, clock } = setup();
    await preferences(service, clock.now(), { contentReadLimit: 1 });
    const one = (await service.ingest(owner, input("one"))).candidate;
    const two = (await service.ingest(owner, input("two"))).candidate;
    const run = await service.beginRun(editor, "begin");
    await service.readRunContent(editor, run.id, one.id, 1);
    await service.readRunContent(editor, run.id, one.id, 1);
    await expect(
      service.readRunContent(editor, run.id, two.id, 1),
    ).rejects.toThrow();
  });

  it("rejects full-text reads without candidate scope", async () => {
    const { service } = setup();
    const candidate = (await service.ingest(owner, input("one"))).candidate;
    const run = await service.beginRun(editor, "begin");
    await expect(
      service.readRunContent(
        { ...editor, scopes: ["editorial:write"] },
        run.id,
        candidate.id,
        1,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("hydrates partial text without changing identity, but never hides metadata changes", async () => {
    const { service } = setup();
    const original = (
      await service.ingest(
        owner,
        input("one", { body: "Only a partial excerpt.", access: "partial" }),
      )
    ).candidate;
    const full = await service.ingest(owner, input("one", { access: "full" }));
    expect(full.candidate.id).toBe(original.id);
    expect(full.candidate.revision).toBe(1);
    const changed = await service.ingest(
      owner,
      input("one", { title: "Changed title", access: "full" }),
    );
    expect(changed.candidate.revision).toBe(2);
  });

  it("deduplicates concurrent ingest operations atomically and returns detached values", async () => {
    const { service } = setup();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => service.ingest(owner, input("same"))),
    );
    expect(new Set(results.map((result) => result.candidate.id)).size).toBe(1);
    results[0]!.candidate.title = "External accidental mutation";
    expect((await service.ingest(owner, input("same"))).candidate.title).toBe(
      "same",
    );
  });
});

describe("Independent review: selection and state", () => {
  it("marks only the published run read and replays without changing versions", async () => {
    const { service } = setup();
    const selected = (await service.ingest(owner, input("selected"))).candidate;
    const outside = (await service.ingest(owner, input("outside", { sourceId: "school", deliveryMode: "all" }))).candidate;
    const run = await service.beginRun(editor, "begin");
    await submit(service, run.id, [article(selected)]);
    await service.publish(editor, run.id, "publish", [selected.id]);
    await service.patchState(owner, selected.id, 0, { saved: true, hidden: true });
    const before = await service.getPreferences(owner);
    const result = await service.markRunRead(owner, run.id, "mark_read");
    expect(result).toMatchObject({ updated: 1, states: [{ candidateId: selected.id, read: true, saved: true, hidden: true, version: 2 }] });
    expect(await service.markRunRead(owner, run.id, "mark_read")).toEqual(result);
    expect(await service.getPreferences(owner)).toEqual(before);
    expect((await service.libraryFeed(owner)).find((entry) => entry.state.candidateId === outside.id)?.state.read).toBe(false);
    await expect(service.markRunRead(editor, run.id, "forbidden")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("reserves discovery slots and gives a small source a chance", async () => {
    const { service, clock } = setup();
    await preferences(service, clock.now(), {
      candidateLimit: 10,
      targetItems: 10,
      preferredTopics: ["technology"],
      discoveryFraction: 0.2,
    });
    for (let index = 0; index < 20; index++)
      await service.ingest(owner, input(`tech_${index}`, { sourceId: `techsource_${index % 10}` }));
    const discoveries: string[] = [];
    for (let index = 0; index < 2; index++)
      discoveries.push(
        (
          await service.ingest(
            owner,
            input(`art_${index}`, {
              sourceId: "art",
              categories: ["art"],
              publishedAt: "2026-09-05T06:00:00.000Z",
            }),
          )
        ).candidate.id,
      );
    const run = await service.beginRun(editor, "begin");
    expect(run.candidateRefs).toHaveLength(10);
    expect(
      run.candidateRefs.filter((ref) => discoveries.includes(ref.candidateId)),
    ).toHaveLength(2);
  });

  it("caps school enrichment at ten while preserving all school notices in storage", async () => {
    const { service } = setup();
    for (let index = 0; index < 15; index++)
      await service.ingest(
        owner,
        input(`school_${index}`, {
          sourceId: "school",
          groups: ["school"],
          deliveryMode: "all",
        }),
      );
    const run = await service.beginRun(editor, "begin");
    expect(run.candidateRefs).toHaveLength(10);
    await service.publish(editor, run.id, "publish", []);
    expect(await service.libraryFeed(owner)).toHaveLength(15);
  });

  it("does not allow a state patch to replace candidate identity", async () => {
    const { service } = setup();
    const candidate = (await service.ingest(owner, input("one"))).candidate;
    const patch = { read: true, candidateId: "injected" };
    await expect(
      service.patchState(owner, candidate.id, 0, patch),
    ).rejects.toThrow();
  });

  it("keeps preferences stable through read, save and explicit feedback", async () => {
    const { service } = setup();
    const candidate = (await service.ingest(owner, input("one"))).candidate;
    const run = await service.beginRun(editor, "begin");
    await submit(service, run.id, [article(candidate)]);
    const published = await service.publish(editor, run.id, "publish", [
      candidate.id,
    ]);
    const before = await service.getPreferences(owner);
    await service.patchState(owner, candidate.id, 0, {
      read: true,
      saved: true,
    });
    await service.feedback(
      owner,
      candidate.id,
      published.run.entries[0]!.editorialItemId,
      "good",
    );
    expect(await service.getPreferences(owner)).toEqual(before);
  });

  it("rejects feedback pairing an existing article with a different candidate", async () => {
    const { service } = setup();
    const one = (await service.ingest(owner, input("one"))).candidate;
    const two = (await service.ingest(owner, input("two"))).candidate;
    const run = await service.beginRun(editor, "begin");
    await submit(service, run.id, [article(one)]);
    const published = await service.publish(editor, run.id, "publish", [
      one.id,
    ]);
    await expect(
      service.feedback(
        owner,
        two.id,
        published.run.entries[0]!.editorialItemId,
        "more",
      ),
    ).rejects.toThrow();
  });
});


describe("Independent review: server foundation", () => {
  it("rolls back failed repository transactions and isolates tenant state", async () => {
    const repository = new MemoryRepository();
    const profile = defaultPreferences(new Date("2026-09-06T06:00:00.000Z"));
    await expect(repository.transaction(owner.uid, async (tx) => {
      await tx.putPreferences(profile);
      throw new Error("Synthetic failure after a staged write");
    })).rejects.toThrow("Synthetic failure");
    expect(await repository.read(owner.uid, (tx) => tx.getPreferences())).toBeNull();
    await repository.transaction(owner.uid, (tx) => tx.putPreferences(profile));
    expect(await repository.read(other.uid, (tx) => tx.getPreferences())).toBeNull();
  });

  it("applies newest-first order before a bounded candidate query", async () => {
    const { service } = setup();
    const base = (await service.ingest(owner, input("base"))).candidate;
    const repository = new MemoryRepository();
    await repository.transaction(owner.uid, async (tx) => {
      for (let day = 1; day <= 4; day++) {
        await tx.putCandidate({ candidate: { ...base, id: `day_${day}`, discoveredAt: `2026-09-0${day}T06:00:00.000Z` }, sourcePayload: "fixture" });
      }
    });
    const recent = await repository.read(owner.uid, (tx) => tx.listCandidates(2));
    expect(recent.map((record) => record.candidate.id)).toEqual(["day_4", "day_3"]);
  });

  it("serves liveness and does not expose unauthenticated product routes", async () => {
    const { service } = setup();
    const app = createServer({ editorial: service });
    try {
      const health = await app.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: "ok" });
      expect((await app.inject({ method: "GET", url: "/api/v1/feed/latest" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
