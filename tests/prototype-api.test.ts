import { describe, expect, it } from "vitest";
import { EditorialService, type Clock, type IdGenerator } from "../packages/core/src/index.js";
import { MemoryContentStore, MemoryRepository } from "../packages/storage/src/index.js";
import { createPrototypeApi, MemoryPrototypeAuxStore } from "../packages/prototype-api/src/index.js";
import type { Principal } from "../packages/shared/src/index.js";

class FixedClock implements Clock {
  now(): Date { return new Date("2026-09-06T08:00:00.000Z"); }
}
class Ids implements IdGenerator {
  private value = 0;
  next(): string { this.value += 1; return `id_${this.value}`; }
}
const user = (uid: string): Principal => ({ uid, kind: "user", scopes: [] });
const request = (path: string, init: RequestInit = {}) => new Request(`https://siftera.example/api/v1${path}`, init);
const json = (value: unknown) => ({
  body: JSON.stringify(value),
  headers: { origin: "https://siftera.example", "content-type": "application/json" },
});

function setup() {
  const repository = new MemoryRepository();
  const contentStore = new MemoryContentStore();
  const service = new EditorialService(repository, contentStore, new FixedClock(), new Ids());
  return createPrototypeApi({
    service, repository, contentStore, auxStore: new MemoryPrototypeAuxStore(),
    resolvePrincipal: async (input) => ({ principal: user(input.headers.get("x-user") ?? "alice"), email: "alice@example.test" }),
    createId: () => "source_1",
  });
}

describe("prototype Fetch API", () => {
  it("uses the authenticated identity, validates source mutations, and keeps source configs tenant-scoped", async () => {
    const api = setup();
    const created = await api(request("/sources", { method: "POST", ...json({ name: "Example", url: "https://example.test/feed.xml", pluginId: "rss", groups: ["tech"] }) }));
    expect(created.status).toBe(201);
    expect((await created.json()).id).toBe("source_1");

    const crossTenant = await api(request("/sources/source_1", { method: "DELETE", headers: { origin: "https://siftera.example", "x-user": "bob" } }));
    expect(crossTenant.status).toBe(404);
    const csrf = await api(request("/sources/source_1", { method: "PATCH", ...json({ enabled: false }), headers: { "content-type": "application/json" } }));
    expect(csrf.status).toBe(403);
  });

  it("exports real bounded content receipts and imports through core publication", async () => {
    const api = setup();
    const article = await api(request("/articles", { method: "POST", ...json({ url: "https://example.test/article", title: "Ventilation", text: "Krátké větrání omezuje ochlazování stěn.", fullText: true }) }));
    expect(article.status).toBe(201);
    const candidate = (await article.json() as { candidate: { id: string; revision: number } }).candidate;

    const exported = await api(request("/editor/export", { method: "POST", ...json({ operationId: "export_1" }) }));
    expect(exported.status).toBe(200);
    const context = await exported.json() as { run: { id: string }; candidates: Array<{ candidate: { id: string }; content: { text: string } | null }>; schema: { $id: string } };
    expect(context.candidates[0]?.content?.text).toContain("Krátké větrání");
    expect(context.schema.$id).toContain("editorial-result");

    const importPayload = {
      operationId: "publish_1",
      orderedCandidateIds: [candidate.id],
      submission: {
        schemaVersion: 1,
        runId: context.run.id,
        batchId: "batch_1",
        editor: { client: "external-json", model: null, promptVersion: "v1" },
        items: [{
          candidate: { candidateId: candidate.id, revision: candidate.revision }, relatedCandidates: [], presentation: "distilled_fact",
          headline: "Větrání", summary: "", topics: ["science"], assessment: { relevance: 90, quality: "useful", novelty: "new", basis: "full_text" },
          whyIncluded: "Praktická rada.", openOriginal: false, distilledText: "Krátké větrání omezuje ochlazování stěn.", evidenceQuote: "Krátké větrání omezuje ochlazování stěn.", schoolDetails: [],
        }], rejected: [],
      },
    };
    const imported = await api(request("/editor/import", { method: "POST", ...json(importPayload) }));
    expect(imported.status).toBe(200);
    const replay = await api(request("/editor/import", { method: "POST", ...json(importPayload) }));
    expect(replay.status).toBe(200);
    const bootstrap = await api(request("/bootstrap"));
    const payload = await bootstrap.json() as { feed: { items: unknown[] } };
    expect(payload.feed.items).toHaveLength(1);
  });

  it("rejects non-JSON and requests above the one MiB request boundary", async () => {
    const api = setup();
    const text = await api(request("/articles", { method: "POST", body: "url=https://example.test", headers: { origin: "https://siftera.example" } }));
    expect(text.status).toBe(415);
    const huge = await api(request("/articles", { method: "POST", body: "x".repeat(1_048_577), headers: { origin: "https://siftera.example", "content-type": "application/json" } }));
    expect(huge.status).toBe(413);
  });
});
