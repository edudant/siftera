import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { deleteApp } from "firebase-admin/app";
import type { Storage } from "firebase-admin/storage";
import { EditorialService } from "../packages/core/src/index.js";
import { FirestoreRepository, FirebaseContentStore } from "../packages/storage/src/firebase.js";
import {
  createFirebaseRuntimeConfig,
  firebaseServices,
  FirebaseIdentityVerifier,
} from "../apps/server/src/firebase.js";
import type { App } from "firebase-admin/app";
import type { Principal } from "../packages/shared/src/index.js";

const projectId = "demo-siftera";
const env = {
  ...process.env,
  NODE_ENV: "test",
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_STORAGE_BUCKET: `${projectId}.appspot.com`,
};
const clock = { now: () => new Date("2026-09-06T08:00:00.000Z") };
let app: App;
let service: EditorialService;
let verifier: FirebaseIdentityVerifier;
let storage: Storage;

const editor = (uid: string): Principal => ({
  uid,
  kind: "agent",
  scopes: ["preferences:read", "candidates:read", "history:read", "feedback:read", "editorial:write", "feed:publish"],
});

async function emulatorToken(): Promise<{ uid: string; token: string }> {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST!;
  const email = `m2a-${randomUUID()}@example.test`;
  const response = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "not-a-real-password", returnSecureToken: true }),
  });
  expect(response.ok).toBe(true);
  const payload = await response.json() as { localId: string; idToken: string };
  return { uid: payload.localId, token: payload.idToken };
}

beforeAll(async () => {
  expect(process.env.FIREBASE_AUTH_EMULATOR_HOST).toMatch(/^(127\.0\.0\.1|localhost):\d+$/u);
  const config = createFirebaseRuntimeConfig(env);
  const services = firebaseServices(config);
  app = services.app;
  service = new EditorialService(
    new FirestoreRepository(services.firestore),
    new FirebaseContentStore(services.storage.bucket()),
    clock,
    { next: () => randomUUID() },
  );
  verifier = new FirebaseIdentityVerifier(services.auth);
  storage = services.storage;
});

afterAll(async () => { await deleteApp(app); });

describe("M2a Firebase runtime boundaries", () => {
  it("verifies a real Auth Emulator ID token and rejects malformed authorization", async () => {
    const issued = await emulatorToken();
    await expect(verifier.verifyAuthorizationHeader(`Bearer ${issued.token}`)).resolves.toEqual({ uid: issued.uid, kind: "user", scopes: [] });
    await expect(verifier.verifyAuthorizationHeader(`X-User-Id ${issued.uid}`)).rejects.toThrow("UNAUTHENTICATED");
    await expect(verifier.verifyAuthorizationHeader(undefined)).rejects.toThrow("UNAUTHENTICATED");
  });

  it("fails closed when production configuration contains emulator or dev-auth state", () => {
    expect(() => createFirebaseRuntimeConfig({
      NODE_ENV: "production",
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_STORAGE_BUCKET: `${projectId}.appspot.com`,
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    })).toThrow("production cannot use Firebase emulator");
    expect(() => createFirebaseRuntimeConfig({
      NODE_ENV: "production",
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_STORAGE_BUCKET: `${projectId}.appspot.com`,
      DEV_AUTH_MODE: "true",
    })).toThrow("production cannot use Firebase emulator");
  });

  it("publishes concurrently with one idempotent immutable feed", async () => {
    const issued = await emulatorToken();
    const user: Principal = { uid: issued.uid, kind: "user", scopes: [] };
    const candidate = (await service.ingest(user, {
      sourceId: "token_source",
      sourceName: "Token source",
      url: `https://example.test/${randomUUID()}`,
      title: "A persistent item",
      body: "A complete article body used by a real emulator integration test.",
      categories: ["science"],
    })).candidate;
    const run = await service.beginRun(editor(user.uid), "begin_token");
    await service.readRunContent(editor(user.uid), run.id, candidate.id, candidate.revision);
    await service.submit(editor(user.uid), {
      schemaVersion: 1,
      runId: run.id,
      batchId: "token_batch",
      editor: { client: "m2a", model: null, promptVersion: "v1" },
      items: [{
        candidate: { candidateId: candidate.id, revision: candidate.revision },
        relatedCandidates: [],
        presentation: "long_read",
        headline: "Persistent item",
        summary: "A short test summary.",
        topics: ["science"],
        assessment: { relevance: 90, quality: "useful", novelty: "new", basis: "full_text" },
        whyIncluded: "Integration coverage.",
        openOriginal: true,
        distilledText: null,
        evidenceQuote: null,
        schoolDetails: [],
      }],
      rejected: [],
    });
    const outcomes = await Promise.all([
      service.publish(editor(user.uid), run.id, "publish_token", [candidate.id]),
      service.publish(editor(user.uid), run.id, "publish_token", [candidate.id]),
    ]);
    expect(outcomes[0].run.entries).toEqual(outcomes[1].run.entries);
    expect((await service.latestFeed(user)).items).toHaveLength(1);
  });

  it("keeps client Firestore rules deny-all over the emulator REST API", async () => {
    const host = process.env.FIRESTORE_EMULATOR_HOST!;
    const response = await fetch(`http://${host}/v1/projects/${projectId}/databases/(default)/documents/users/unauthenticated`);
    expect(response.status).toBe(403);
  });

  it("keeps client Storage rules deny-all over the emulator REST API", async () => {
    const object = storage.bucket().file("users/rules/content/probe/1.json.gz");
    await object.save(Buffer.from("private test payload"));
    const host = process.env.FIREBASE_STORAGE_EMULATOR_HOST!;
    const response = await fetch(`http://${host}/v0/b/${projectId}.appspot.com/o/${encodeURIComponent(object.name)}?alt=media`);
    expect(response.status).toBe(403);
  });
});
