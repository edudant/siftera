import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeApp, deleteApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { getAuth } from "firebase-admin/auth";
import { createFirebaseAdmin, createFirebaseRuntimeConfig, FirebaseIdentityVerifier } from "../apps/server/src/firebase.js";
import { EditorialService, defaultPreferences } from "../packages/core/src/index.js";
import { FirestoreRepository, FirebaseContentStore, LocalContentStore } from "../packages/storage/src/firebase.js";
import type { CandidateContent, EditorialProposal, Principal } from "../packages/shared/src/index.js";

const projectId = "demo-siftera";
const bucketName = `${projectId}.appspot.com`;
const clock = { now: () => new Date("2026-09-06T06:00:00.000Z") };
const apps: App[] = [];
let db: Firestore;
let app: App;
let localRoot: string;
function owner(): Principal { return { uid: `review_${randomUUID()}`, kind: "user", scopes: [] }; }
function editor(user: Principal): Principal { return { ...user, kind: "agent", scopes: ["preferences:read", "candidates:read", "history:read", "feedback:read", "editorial:write", "feed:publish"] }; }
function freshApp() { const value = initializeApp({ projectId, storageBucket: bucketName }, `review_${randomUUID()}`); apps.push(value); return value; }
function service(firebaseApp: App) { return new EditorialService(new FirestoreRepository(getFirestore(firebaseApp)), new FirebaseContentStore(getStorage(firebaseApp).bucket()), clock, { next: () => randomUUID() }); }
function body(candidateId: string, text: string, access: CandidateContent["access"] = "full"): CandidateContent {
  return { candidateId, revision: 1, text, contentHash: createHash("sha256").update(text.replace(/\s+/gu, " ").trim()).digest("hex"), access, extractedAt: clock.now().toISOString(), extractorVersion: "review-v1", truncated: false, originalCharacterCount: text.length };
}

beforeAll(async () => {
  expect(process.env.FIRESTORE_EMULATOR_HOST).toMatch(/^(127\.0\.0\.1|localhost):\d+$/u);
  expect(process.env.FIREBASE_AUTH_EMULATOR_HOST).toMatch(/^(127\.0\.0\.1|localhost):\d+$/u);
  expect(process.env.FIREBASE_STORAGE_EMULATOR_HOST).toMatch(/^(127\.0\.0\.1|localhost):\d+$/u);
  app = freshApp();
  db = getFirestore(app);
  localRoot = await mkdtemp(join(tmpdir(), "siftera-content-review-"));
});

afterAll(async () => {
  await Promise.all(apps.map((value) => deleteApp(value)));
  if (localRoot) await rm(localRoot, { recursive: true, force: true });
});

describe("Independent M2a repository review", () => {
  it("reads staged writes but rolls the entire transaction back after failure", async () => {
    const user = owner();
    const repository = new FirestoreRepository(db);
    const profile = defaultPreferences(clock.now());
    const original = (await service(app).ingest(user, { sourceId: "source", sourceName: "Source", url: "https://example.org/overlay", title: "Original candidate" })).candidate;
    await expect(repository.transaction(user.uid, async (tx) => {
      await tx.putPreferences(profile);
      expect(await tx.getPreferences()).toEqual(profile);
      await tx.putCandidate({ candidate: { ...original, id: "staged_candidate" }, sourcePayload: "fixture" });
      expect((await tx.listCandidates(10)).map((record) => record.candidate.id).sort()).toEqual([original.id, "staged_candidate"].sort());
      await tx.putState({ candidateId: "rollback_item", read: true, saved: false, hidden: false, version: 1, updatedAt: clock.now().toISOString() });
      expect((await tx.getState("rollback_item"))?.read).toBe(true);
      throw new Error("Synthetic rollback after pending writes");
    })).rejects.toThrow("Synthetic rollback");
    const fresh = new FirestoreRepository(getFirestore(freshApp()));
    expect(await fresh.read(user.uid, (tx) => tx.getPreferences())).toBeNull();
    expect(await fresh.read(user.uid, (tx) => tx.getState("rollback_item"))).toBeNull();
    expect(await fresh.read(user.uid, (tx) => tx.getCandidate("staged_candidate"))).toBeNull();
  });

  it("preserves published content and user state across fresh clients and isolates tenants", async () => {
    const user = owner();
    const foreign = owner();
    const first = service(app);
    const input = { sourceId: "review_source", sourceName: "Synthetic review publisher", url: "https://example.org/persist", title: "Original title", excerpt: "Original excerpt", body: "Original complete synthetic text.", categories: ["science"] };
    const candidate = (await first.ingest(user, input)).candidate;
    const run = await first.beginRun(editor(user), "begin");
    await first.readRunContent(editor(user), run.id, candidate.id, 1);
    const proposal: EditorialProposal = { candidate: { candidateId: candidate.id, revision: 1 }, relatedCandidates: [], presentation: "long_read", headline: "Read the original", summary: "A brief preview", topics: ["science"], assessment: { relevance: 80, quality: "useful", novelty: "new", basis: "full_text" }, whyIncluded: "Relevant technical source", openOriginal: true, distilledText: null, evidenceQuote: null, schoolDetails: [] };
    await first.submit(editor(user), { schemaVersion: 1, runId: run.id, batchId: "batch", editor: { client: "integration-review", model: null, promptVersion: "v1" }, items: [proposal], rejected: [] });
    const initial = await first.publish(editor(user), run.id, "publish", [candidate.id]);
    await first.patchState(user, candidate.id, 0, { saved: true }, "save");
    const restarted = service(freshApp());
    expect((await restarted.latestFeed(user)).items[0]).toMatchObject({ item: initial.items[0]!.item, state: { saved: true, version: 1 } });
    expect(await restarted.patchState(user, candidate.id, 0, { saved: true }, "save")).toMatchObject({ saved: true, version: 1 });
    expect((await restarted.getContent(user, candidate.id, 1)).text).toBe(input.body);
    expect((await restarted.latestFeed(foreign)).items).toEqual([]);
    await expect(restarted.getContent(foreign, candidate.id, 1)).rejects.toThrow();
    await restarted.ingest(user, { ...input, title: "Changed title", body: "Changed complete text." });
    expect((await restarted.latestFeed(user)).items[0]!.item).toEqual(initial.items[0]!.item);
    expect((await restarted.getContent(user, candidate.id, 1)).text).toBe(input.body);
    const revision = await db.doc(`users/${user.uid}/candidates/${candidate.id}/revisions/1`).get();
    expect(revision.exists).toBe(true);
  });

  it("persists the rejection cooldown across adapter reconstruction", async () => {
    const user = owner();
    const first = service(app);
    const candidate = (await first.ingest(user, { sourceId: "source", sourceName: "Source", url: "https://example.org/rejected", title: "Rejected candidate" })).candidate;
    const run = await first.beginRun(editor(user), "begin");
    await first.submit(editor(user), { schemaVersion: 1, runId: run.id, batchId: "reject", editor: { client: "integration-review", model: null, promptVersion: "v1" }, items: [], rejected: [{ candidate: { candidateId: candidate.id, revision: 1 }, reason: "irrelevant" }] });
    await first.abort(editor(user), run.id);
    const restarted = service(freshApp());
    expect((await restarted.beginRun(editor(user), "after_restart")).candidateRefs).toEqual([]);
  });

  it("prevents lost state updates when two different operations use the same base version", async () => {
    const user = owner();
    const first = service(app);
    const candidate = (await first.ingest(user, { sourceId: "source", sourceName: "Source", url: "https://example.org/concurrent", title: "Concurrent state" })).candidate;
    const second = service(freshApp());
    const results = await Promise.allSettled([
      first.patchState(user, candidate.id, 0, { read: true }, "read"),
      second.patchState(user, candidate.id, 0, { saved: true }, "save"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await new FirestoreRepository(db).read(user.uid, (tx) => tx.getState(candidate.id))).toMatchObject({ version: 1 });
  });
});

describe("Independent M2a identity review", () => {
  it("derives identity from an actual emulator token and rejects invalid bearer input", async () => {
    const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST!;
    const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-only`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `review-${randomUUID()}@example.test`, password: "SyntheticLocalFixture123!", returnSecureToken: true }),
    });
    expect(response.status).toBe(200);
    const account = await response.json() as { localId: string; idToken: string };
    const verifier = new FirebaseIdentityVerifier(getAuth(app));
    const principal = await verifier.verifyAuthorizationHeader(`Bearer ${account.idToken}`);
    expect(principal).toEqual({ uid: account.localId, kind: "user", scopes: [] });
    await expect(verifier.verifyAuthorizationHeader(undefined)).rejects.toThrow();
    await expect(verifier.verifyAuthorizationHeader("Bearer not-a-token")).rejects.toThrow();
    await expect(verifier.verifyAuthorizationHeader(`Bearer  ${account.idToken}`)).rejects.toThrow();
  });

  it("cannot construct a production Firebase app while ambient emulator flags are present", async () => {
    let created: App | undefined;
    try {
      expect(() => {
        const config = createFirebaseRuntimeConfig({ NODE_ENV: "production", FIREBASE_PROJECT_ID: "siftera-production-review", FIREBASE_STORAGE_BUCKET: "siftera-production-review.appspot.com" });
        created = createFirebaseAdmin(config);
      }).toThrow();
    } finally {
      if (created) await deleteApp(created);
    }
  });
});

describe("Independent M2a content store review", () => {
  it.each(["local", "firebase"] as const)("supports hydration and immutable full content in %s storage", async (kind) => {
    const user = owner();
    const storage = kind === "local" ? new LocalContentStore(localRoot) : new FirebaseContentStore(getStorage(app).bucket());
    const partial = body("article", "Partial excerpt", "partial");
    const full = body("article", "Complete synthetic content");
    await storage.put(user.uid, partial);
    await storage.put(user.uid, full);
    await storage.put(user.uid, { ...full, extractedAt: "2026-09-06T07:00:00.000Z" });
    expect((await storage.get(user.uid, "article", 1))?.text).toBe(full.text);
    await expect(storage.put(user.uid, body("article", "Different complete content"))).rejects.toThrow();
    expect((await storage.get(user.uid, "article", 1))?.text).toBe(full.text);
    expect(await storage.get(owner().uid, "article", 1)).toBeNull();
    await expect(storage.get("../outside", "article", 1)).rejects.toThrow();
    const matchingBytes = body("matching", "Same bytes with improved availability", "partial");
    await storage.put(user.uid, matchingBytes);
    await storage.put(user.uid, { ...matchingBytes, access: "full" });
    expect((await storage.get(user.uid, "matching", 1))?.access).toBe("full");
  });
});
