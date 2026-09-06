import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { default as addFormats } from "ajv-formats/dist/index.js";
import { describe, expect, it } from "vitest";
import {
  EditorialService,
  type Clock,
  type IdGenerator,
} from "../packages/core/src/index.js";
import {
  MemoryContentStore,
  MemoryRepository,
} from "../packages/storage/src/index.js";
import {
  editorialSubmissionSchema,
  type EditorialProposal,
  type Principal,
} from "../packages/shared/src/index.js";

class FixedClock implements Clock {
  constructor(private value = new Date("2026-09-06T06:00:00.000Z")) {}
  now(): Date {
    return new Date(this.value);
  }
}
class SequentialIds implements IdGenerator {
  private index = 0;
  next(): string {
    this.index += 1;
    return `id_${this.index}`;
  }
}
const user = (uid: string): Principal => ({ uid, kind: "user", scopes: [] });
const agent = (uid: string): Principal => ({
  uid,
  kind: "agent",
  scopes: [
    "preferences:read",
    "candidates:read",
    "editorial:write",
    "feed:publish",
  ],
});
const proposal = (
  candidateId: string,
  revision: number,
): EditorialProposal => ({
  candidate: { candidateId, revision },
  relatedCandidates: [],
  presentation: "distilled_fact",
  headline: "Ověřený fakt",
  summary: "",
  topics: ["science"],
  assessment: {
    relevance: 80,
    quality: "useful",
    novelty: "new",
    basis: "full_text",
  },
  whyIncluded: "Užitečné.",
  openOriginal: false,
  distilledText: "Krátké větrání omezuje ochlazování stěn.",
  evidenceQuote: "Krátké větrání omezuje ochlazování stěn.",
  schoolDetails: [],
});
const setup = () =>
  new EditorialService(
    new MemoryRepository(),
    new MemoryContentStore(),
    new FixedClock(),
    new SequentialIds(),
  );

describe("M1 contracts", () => {
  it("accepts the normative example and has JSON Schema parity for negative fixtures", async () => {
    const examples = JSON.parse(
      await readFile(
        new URL("../docs/contracts/examples.json", import.meta.url),
        "utf8",
      ),
    ) as { submission: unknown };
    const negative = JSON.parse(
      await readFile(
        new URL("../docs/contracts/negative-examples.json", import.meta.url),
        "utf8",
      ),
    ) as { invalidSubmissions: Array<{ input: unknown }> };
    const schema = JSON.parse(
      await readFile(
        new URL(
          "../docs/contracts/editorial-result.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as object;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const installFormats = addFormats as unknown as (instance: Ajv2020) => void;
    installFormats(ajv);
    const validate = ajv.compile(schema);
    expect(
      editorialSubmissionSchema.safeParse(examples.submission).success,
    ).toBe(true);
    expect(validate(examples.submission)).toBe(true);
    for (const fixture of negative.invalidSubmissions) {
      expect(editorialSubmissionSchema.safeParse(fixture.input).success).toBe(
        false,
      );
      expect(validate(fixture.input)).toBe(false);
    }
    const school = structuredClone(examples.submission) as {
      items: Array<Record<string, unknown>>;
    };
    Object.assign(school.items[0]!, {
      presentation: "school_notice",
      distilledText: null,
      evidenceQuote: null,
      schoolDetails: [
        {
          kind: "test",
          text: "Test",
          dueDate: "2026-02-28",
          subject: "Science",
          origin: "teacher",
        },
      ],
    });
    expect(editorialSubmissionSchema.safeParse(school).success).toBe(true);
    expect(validate(school)).toBe(true);
    const badDate = structuredClone(school);
    (
      badDate.items[0]!.schoolDetails as Array<Record<string, unknown>>
    )[0]!.dueDate = "2026-02-30";
    expect(editorialSubmissionSchema.safeParse(badDate).success).toBe(false);
    expect(validate(badDate)).toBe(false);
    const tooManySchoolDetails = structuredClone(school);
    tooManySchoolDetails.items[0]!.schoolDetails = Array.from(
      { length: 21 },
      () => ({
        kind: "test",
        text: "Test",
        dueDate: null,
        subject: null,
        origin: "teacher",
      }),
    );
    expect(
      editorialSubmissionSchema.safeParse(tooManySchoolDetails).success,
    ).toBe(false);
    expect(validate(tooManySchoolDetails)).toBe(false);
  });
});

describe("M1 editorial core", () => {
  it("runs fixture ingest through receipt, publication and a tenant-scoped feed exactly once", async () => {
    const service = setup();
    const first = await service.ingest(user("alice"), {
      sourceId: "source_a",
      sourceName: "Science",
      url: "https://Example.org/a?b=2&utm_campaign=x&a=1#frag",
      title: "Ventilation",
      excerpt: "Practical science",
      body: "Krátké větrání omezuje ochlazování stěn.",
      categories: ["science"],
    });
    await service.ingest(user("alice"), {
      sourceId: "source_b",
      sourceName: "Other",
      url: "https://example.org/b",
      title: "Second",
      excerpt: "Other item",
      body: "A separate complete text.",
      categories: ["science"],
    });
    expect(first.candidate.canonicalUrl).toBe("https://example.org/a?a=1&b=2");
    const run = await service.beginRun(agent("alice"), "operation_begin");
    expect((await service.beginRun(agent("alice"), "operation_begin")).id).toBe(
      run.id,
    );
    expect(run.candidateRefs).toHaveLength(2);
    await service.readRunContent(
      agent("alice"),
      run.id,
      first.candidate.id,
      first.candidate.revision,
    );
    const submission = {
      schemaVersion: 1 as const,
      runId: run.id,
      batchId: "batch_1",
      editor: { client: "test", model: null, promptVersion: "v1" },
      items: [proposal(first.candidate.id, first.candidate.revision)],
      rejected: [],
    };
    await service.submit(agent("alice"), submission);
    const published = await service.publish(
      agent("alice"),
      run.id,
      "publish_1",
      [first.candidate.id],
    );
    const replay = await service.publish(agent("alice"), run.id, "publish_1", [
      first.candidate.id,
    ]);
    expect(published.run.entries).toHaveLength(1);
    expect(replay.run.entries).toHaveLength(1);
    expect(published.items[0]!.entry?.candidateId).toBe(first.candidate.id);
    expect(published.items[0]!.item.provenance[0]?.canonicalUrl).toBe(
      first.candidate.canonicalUrl,
    );
    expect((await service.latestFeed(user("alice"))).items).toHaveLength(1);
    expect((await service.latestFeed(user("bob"))).items).toHaveLength(0);
  });

  it("keeps state and feedback separate from preferences and rejects stale/hidden publication", async () => {
    const service = setup();
    const input = {
      sourceId: "source_a",
      sourceName: "Source",
      url: "https://example.org/a",
      title: "A",
      excerpt: "A",
      body: "Krátké větrání omezuje ochlazování stěn.",
      categories: ["science"],
    };
    const candidate = (await service.ingest(user("alice"), input)).candidate;
    const run = await service.beginRun(agent("alice"), "begin");
    await service.readRunContent(agent("alice"), run.id, candidate.id, 1);
    await service.submit(agent("alice"), {
      schemaVersion: 1,
      runId: run.id,
      batchId: "batch",
      editor: { client: "test", model: null, promptVersion: "v1" },
      items: [proposal(candidate.id, 1)],
      rejected: [],
    });
    await service.patchState(user("alice"), candidate.id, 0, { hidden: true });
    await expect(
      service.publish(agent("alice"), run.id, "publish", [candidate.id]),
    ).rejects.toMatchObject({ code: "ITEM_NOT_ELIGIBLE" });
    const run2 = await service.beginRun(agent("alice"), "again");
    await service.savePreferences(user("alice"), 1, {
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
    });
    expect(run2.preferenceVersion).toBe(1);
  });

  it("bulk-marks a published run exactly once and preserves saved state", async () => {
    const service = setup();
    const candidate = (
      await service.ingest(user("alice"), {
        sourceId: "source",
        sourceName: "Source",
        url: "https://example.org/bulk",
        title: "Bulk",
        excerpt: "Bulk",
        body: "Krátké větrání omezuje ochlazování stěn.",
        categories: ["science"],
      })
    ).candidate;
    const run = await service.beginRun(agent("alice"), "bulk-begin");
    await service.readRunContent(agent("alice"), run.id, candidate.id, 1);
    await service.submit(agent("alice"), {
      schemaVersion: 1,
      runId: run.id,
      batchId: "bulk-batch",
      editor: { client: "test", model: null, promptVersion: "v1" },
      items: [proposal(candidate.id, 1)],
      rejected: [],
    });
    await service.publish(agent("alice"), run.id, "bulk-publish", [
      candidate.id,
    ]);
    await service.patchState(user("alice"), candidate.id, 0, { saved: true });
    const first = await service.markRunRead(user("alice"), run.id, "bulk-read");
    const retry = await service.markRunRead(user("alice"), run.id, "bulk-read");
    expect(first.updated).toBe(1);
    expect(retry).toEqual(first);
    expect(first.states[0]).toMatchObject({
      read: true,
      saved: true,
      hidden: false,
    });
  });

  it("enforces roles, revision semantics and school all delivery without an editor", async () => {
    const service = setup();
    const base = {
      sourceId: "school",
      sourceName: "School",
      groups: ["school"],
      deliveryMode: "all" as const,
      url: "https://school.example/notice",
      title: "Homework",
      excerpt: "Read chapter",
      categories: ["school"],
    };
    const first = await service.ingest(user("alice"), base);
    expect(first.systemItemId).toBeTruthy();
    expect(await service.libraryFeed(user("alice"))).toHaveLength(1);
    await expect(service.ingest(agent("alice"), base)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      service.patchState(agent("alice"), first.candidate.id, 0, { read: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      service.savePreferences(agent("alice"), 1, {} as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const hydrated = await service.ingest(user("alice"), {
      ...base,
      body: "Read chapter one.",
    });
    expect(hydrated.revised).toBe(false);
    expect(hydrated.candidate.revision).toBe(1);
    const revised = await service.ingest(user("alice"), {
      ...base,
      title: "Homework updated",
      body: "Read chapter two.",
    });
    expect(revised.revised).toBe(true);
    expect(revised.candidate.revision).toBe(2);
  });
});
