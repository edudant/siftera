import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { FirebaseContentStore } from "../packages/storage/src/firebase.js";
import type { CandidateContent } from "../packages/shared/src/index.js";

function content(text: string, access: CandidateContent["access"]): CandidateContent {
  return { candidateId: "article", revision: 1, text, contentHash: createHash("sha256").update(text).digest("hex"), access, extractedAt: "2026-09-06T06:00:00.000Z", extractorVersion: "race-fixture", truncated: false, originalCharacterCount: text.length };
}
const encode = (value: CandidateContent) => gzipSync(JSON.stringify(value));

describe("Content store race regression", () => {
  it("never combines old partial bytes with a newer complete object's generation", async () => {
    const committed = content("Committed complete text A", "full");
    const competing = content("Competing complete text B", "full");
    let stored = content("Partial text", "partial");
    let writes = 0;
    const fakeFile = {
      name: "users/owner/content/article/1.json.gz",
      download: async () => [encode(stored)],
      getMetadata: async () => {
        // Simulate writer A committing between B's download and metadata read.
        stored = committed;
        return [{ generation: "2" }];
      },
      save: async (bytes: Buffer) => { writes++; stored = JSON.parse(gunzipSync(bytes).toString("utf8")) as CandidateContent; },
    };
    const bucket = { file: () => fakeFile } as unknown as ConstructorParameters<typeof FirebaseContentStore>[0];
    const storage = new FirebaseContentStore(bucket);
    await expect(storage.put("owner", competing)).rejects.toThrow();
    expect(writes).toBe(0);
    expect((await storage.get("owner", "article", 1))?.text).toBe(committed.text);
  });
});
