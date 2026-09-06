import { describe, expect, it } from "vitest";
import { EditorialService, type Clock, type IdGenerator } from "../packages/core/src/index.js";
import { MemoryContentStore, MemoryRepository } from "../packages/storage/src/index.js";
import { createPrototypeApi, MemoryPrototypeAuxStore } from "../packages/prototype-api/src/index.js";
import type { Principal } from "../packages/shared/src/index.js";

/**
 * Pokrývá to, co přineslo produkční nasazení: cross-origin přístup z jiné domény, dávkový ingest zvenčí
 * místo stahování na edge, a proud nepřečteného, který nahradil denní vydání.
 */
const NOW = new Date("2026-09-20T12:00:00.000Z");
class FixedClock implements Clock {
  now(): Date { return NOW; }
}
class Ids implements IdGenerator {
  private value = 0;
  next(): string { this.value += 1; return `id_${this.value}`; }
}
const user = (uid: string): Principal => ({ uid, kind: "user", scopes: [] });
const WEB = "https://edudant.github.io";

function setup(allowedOrigins: string[] = [WEB]) {
  const repository = new MemoryRepository();
  const contentStore = new MemoryContentStore();
  const service = new EditorialService(repository, contentStore, new FixedClock(), new Ids());
  const api = createPrototypeApi({
    service, repository, contentStore, auxStore: new MemoryPrototypeAuxStore(), allowedOrigins,
    resolvePrincipal: async (input) => input.headers.get("authorization") === "Bearer secret"
      ? { principal: user("owner"), email: null }
      : null,
    createId: () => "source_1",
  });
  const call = (path: string, init: RequestInit = {}) => api(new Request(`https://api.example/api/v1${path}`, init));
  const authorized = (path: string, init: RequestInit = {}) => call(path, {
    ...init,
    headers: { authorization: "Bearer secret", origin: WEB, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { call, authorized, service, repository };
}

describe("cross-origin access", () => {
  it("answers preflight for the allowed web and stays silent for anyone else", async () => {
    const { call } = setup();
    const allowed = await call("/items/seen", { method: "OPTIONS", headers: { origin: WEB } });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(allowed.headers.get("vary")).toBe("Origin");

    const stranger = await call("/items/seen", { method: "OPTIONS", headers: { origin: "https://attacker.example" } });
    expect(stranger.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects a request without credentials and echoes CORS on the rejection", async () => {
    const { call } = setup();
    const anonymous = await call("/bootstrap", { headers: { origin: WEB } });
    expect(anonymous.status).toBe(401);
    // Bez CORS na chybové odpovědi by prohlížeč místo hlášky ukázal jen síťovou chybu.
    expect(anonymous.headers.get("access-control-allow-origin")).toBe(WEB);
  });

  it("refuses a mutation from an origin that is not on the allowlist", async () => {
    const { call } = setup();
    const forged = await call("/items/seen", {
      method: "POST",
      headers: { authorization: "Bearer secret", origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ candidateIds: ["whatever"] }),
    });
    expect(forged.status).toBe(403);
  });
});

describe("batch ingest from a local process", () => {
  it("stores prepared items and reports how many were new", async () => {
    const { authorized } = setup();
    const body = {
      sourceId: "src_1", sourceName: "Example", deliveryMode: "curated" as const,
      items: [
        { url: "https://example.test/a", title: "První", excerpt: "Perex A", publishedAt: "2026-09-20T10:00:00.000Z" },
        { url: "https://example.test/b", title: "Druhá", excerpt: "Perex B" },
      ],
    };
    const first = await authorized("/ingest", { method: "POST", body: JSON.stringify(body) });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ received: 2, created: 2, errors: [] });

    // Opakovaná dávka je dedup, ne dvojí zápis; lokální cron může běžet klidně každou hodinu.
    const again = await authorized("/ingest", { method: "POST", body: JSON.stringify(body) });
    expect(await again.json()).toMatchObject({ received: 2, created: 0 });

    const bootstrap = await authorized("/bootstrap");
    expect((await bootstrap.json()).inbox).toHaveLength(2);
  });

  it("keeps an image supplied by the local collector", async () => {
    const { authorized } = setup();
    await authorized("/ingest", {
      method: "POST",
      body: JSON.stringify({
        sourceId: "src_1", sourceName: "Example",
        items: [{ url: "https://example.test/c", title: "S obrázkem", image: { url: "https://cdn.example/c.jpg", width: 900, height: 600, alt: "" } }],
      }),
    });
    const bootstrap = await (await authorized("/bootstrap")).json();
    expect(bootstrap.inbox[0].candidate.image).toMatchObject({ url: "https://cdn.example/c.jpg", width: 900 });
  });

  it("rejects a batch that is not a valid ingest payload", async () => {
    const { authorized } = setup();
    const empty = await authorized("/ingest", { method: "POST", body: JSON.stringify({ sourceId: "src_1", sourceName: "Example", items: [] }) });
    expect(empty.status).toBe(400);
    const bad = await authorized("/ingest", { method: "POST", body: JSON.stringify({ sourceId: "src_1", sourceName: "Example", items: [{ url: "not-a-url", title: "X" }] }) });
    expect(bad.status).toBe(400);
  });
});

describe("unread stream", () => {
  /** Publikuje položku a vrátí její candidateId, aby se dal ovlivnit její stav. */
  async function publish(setup: ReturnType<typeof setupStream>, title: string, relevance: number, publishedAt: string) {
    const { authorized } = setup;
    await authorized("/ingest", {
      method: "POST",
      body: JSON.stringify({ sourceId: "src_1", sourceName: "Example", items: [{ url: `https://example.test/${encodeURIComponent(title)}`, title, excerpt: "perex", publishedAt }] }),
    });
    const bootstrap = await (await authorized("/bootstrap")).json();
    const candidate = bootstrap.inbox.find((entry: { candidate: { title: string } }) => entry.candidate.title === title)!.candidate;
    const exported = await (await authorized("/editor/export", { method: "POST", body: JSON.stringify({ operationId: `op_${title}` }) })).json();
    const item = {
      candidate: { candidateId: candidate.id, revision: candidate.revision },
      relatedCandidates: [], presentation: "article" as const,
      headline: title, summary: "shrnutí", topics: ["tema"],
      assessment: { relevance, quality: "useful" as const, novelty: "new" as const, basis: "excerpt" as const },
      whyIncluded: "protože", openOriginal: true, distilledText: null, evidenceQuote: null, schoolDetails: [],
    };
    await authorized("/editor/import", {
      method: "POST",
      body: JSON.stringify({
        submission: {
          schemaVersion: 1, runId: exported.run.id, batchId: `batch_${title}`,
          editor: { client: "test", model: null, promptVersion: "1" },
          items: [item], rejected: [],
        },
        orderedCandidateIds: [candidate.id],
        operationId: `pub_${title}`,
      }),
    });
    return candidate.id;
  }
  const setupStream = () => setup();

  it("ranks by editor relevance decayed by age, so an older strong item does not stick to the top", async () => {
    const context = setupStream();
    const fresh = await publish(context, "cerstve-prumerne", 60, "2026-09-20T09:00:00.000Z");
    const old = await publish(context, "stare-silne", 95, "2026-09-15T09:00:00.000Z");
    const bootstrap = await (await context.authorized("/bootstrap")).json();
    const order = bootstrap.stream.map((entry: { item: { headline: string } }) => entry.item.headline);
    expect(order[0]).toBe("cerstve-prumerne");
    expect(order).toContain("stare-silne");
    expect([fresh, old].every(Boolean)).toBe(true);
  });

  it("drops items older than the window but keeps them in the library", async () => {
    const context = setupStream();
    await publish(context, "starsi", 70, "2026-09-15T09:00:00.000Z");
    await publish(context, "dnesni", 70, "2026-09-20T09:00:00.000Z");
    // Okno se testuje přímo na službě: přes ingest by starší položku nepustil prefilter kandidátů (7 dní).
    const narrow = await context.service.unreadStream(user("owner"), 2);
    expect(narrow.map((entry) => entry.item.headline)).toEqual(["dnesni"]);
    const wide = await context.service.unreadStream(user("owner"), 14);
    expect(wide.map((entry) => entry.item.headline).sort()).toEqual(["dnesni", "starsi"]);

    const bootstrap = await (await context.authorized("/bootstrap")).json();
    expect(bootstrap.library.map((entry: { item: { headline: string } }) => entry.item.headline).sort()).toEqual(["dnesni", "starsi"]);
  });

  it("demotes a seen item without removing it, and removes it once it is read", async () => {
    const context = setupStream();
    await publish(context, "nevideno", 60, "2026-09-20T09:00:00.000Z");
    const seenId = await publish(context, "videno", 60, "2026-09-20T09:00:00.000Z");

    await context.authorized("/items/seen", { method: "POST", body: JSON.stringify({ candidateIds: [seenId] }) });
    const afterSeen = await (await context.authorized("/bootstrap")).json();
    const order = afterSeen.stream.map((entry: { item: { headline: string } }) => entry.item.headline);
    expect(order).toHaveLength(2);
    expect(order[1]).toBe("videno");

    const seenEntry = afterSeen.stream.find((entry: { item: { headline: string } }) => entry.item.headline === "videno")!;
    await context.authorized(`/items/${seenId}/state`, {
      method: "PATCH",
      body: JSON.stringify({ patch: { read: true }, expectedVersion: seenEntry.state.version, operationId: "read_1" }),
    });
    const afterRead = await (await context.authorized("/bootstrap")).json();
    expect(afterRead.stream.map((entry: { item: { headline: string } }) => entry.item.headline)).toEqual(["nevideno"]);
  });

  it("records seen only once and never overwrites the reader's own state", async () => {
    const context = setupStream();
    const id = await publish(context, "polozka", 60, "2026-09-20T09:00:00.000Z");
    const first = await (await context.authorized("/items/seen", { method: "POST", body: JSON.stringify({ candidateIds: [id] }) })).json();
    const second = await (await context.authorized("/items/seen", { method: "POST", body: JSON.stringify({ candidateIds: [id] }) })).json();
    expect(first.marked).toBe(1);
    expect(second.marked).toBe(0);

    const bootstrap = await (await context.authorized("/bootstrap")).json();
    const entry = bootstrap.stream.find((row: { item: { headline: string } }) => row.item.headline === "polozka")!;
    expect(entry.state.seenAt).not.toBeNull();
    expect(entry.state.read).toBe(false);
    expect(entry.state.saved).toBe(false);
  });
});

describe("read fan-out", () => {
  it("keeps the number of repository reads flat as data grows", async () => {
    /**
     * Bootstrap kdysi dělal 661 dotazů a rostl lineárně s počtem kandidátů, což naráží na limit dotazů
     * na jeden Worker request. Test hlídá, že se N+1 nevrátí: desetinásobek dat nesmí znamenat
     * desetinásobek čtení.
     */
    const counting = () => {
      const repository = new MemoryRepository();
      let reads = 0;
      const wrap = <T extends object>(target: T): T => new Proxy(target, {
        get(source, key, receiver) {
          const value = Reflect.get(source, key, receiver);
          if (typeof value !== "function" || typeof key !== "string") return value;
          if (!/^(get|list|resolve)/.test(key)) return value.bind(source);
          return (...args: unknown[]) => { reads += 1; return (value as (...input: unknown[]) => unknown).apply(source, args); };
        },
      });
      const port = {
        read: <T>(uid: string, run: (tx: never) => Promise<T>) => repository.read(uid, (tx) => run(wrap(tx as object) as never)),
        transaction: <T>(uid: string, run: (tx: never) => Promise<T>) => repository.transaction(uid, (tx) => run(tx as never)),
      };
      return { port: port as unknown as MemoryRepository, reads: () => reads, reset: () => { reads = 0; } };
    };

    const measure = async (items: number) => {
      const counter = counting();
      const contentStore = new MemoryContentStore();
      const service = new EditorialService(counter.port, contentStore, new FixedClock(), new Ids());
      const api = createPrototypeApi({
        service, repository: counter.port, contentStore, auxStore: new MemoryPrototypeAuxStore(), allowedOrigins: [WEB],
        resolvePrincipal: async () => ({ principal: user("owner"), email: null }),
      });
      const call = (path: string, init: RequestInit = {}) => api(new Request(`https://api.example/api/v1${path}`, {
        ...init,
        headers: { authorization: "Bearer secret", origin: WEB, "content-type": "application/json", ...(init.headers ?? {}) },
      }));
      await call("/ingest", {
        method: "POST",
        body: JSON.stringify({
          sourceId: "src_1", sourceName: "Example",
          items: Array.from({ length: items }, (_, index) => ({ url: `https://example.test/${index}`, title: `Položka ${index}`, excerpt: "perex" })),
        }),
      });
      counter.reset();
      await call("/bootstrap");
      return counter.reads();
    };

    const small = await measure(5);
    const large = await measure(50);
    expect(large).toBeLessThan(small * 2);
  });
});
