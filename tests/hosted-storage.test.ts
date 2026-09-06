import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { D1Repository, R2ContentStore, type SqlDatabase, type SqlStatement, type SqlResult, type ObjectBucket } from "../packages/storage/src/cloudflare.js";
import { defaultPreferences, EditorialService } from "../packages/core/src/index.js";
import { MemoryContentStore } from "../packages/storage/src/index.js";

class TestD1 implements SqlDatabase {
  db = new DatabaseSync(":memory:");
  constructor() { this.db.exec(readFileSync(new URL("../drizzle/0000_melted_bromley.sql",import.meta.url),"utf8")); }
  prepare(sql:string): SqlStatement {
    let values: unknown[]=[];
    const statement = this.db.prepare(sql);
    return {
      bind(...input) {values=input;return this;},
      async first<T>() {return statement.get(...values as []) as T ?? null;},
      async all<T>() {return {results:statement.all(...values as []) as T[],meta:{}};},
      async run() {return {results:[],meta:{changes:Number(statement.run(...values as []).changes)}};},
    };
  }
  async batch(statements:SqlStatement[]):Promise<SqlResult[]> {
    this.db.exec("BEGIN");
    try { const results=[]; for (const statement of statements) results.push(await statement.run()); this.db.exec("COMMIT");return results; }
    catch(error) {this.db.exec("ROLLBACK");throw error;}
  }
}

describe("Hosted durable storage",()=>{
  it("persists the core ingest across services and scopes records to UID",async()=>{
    const db=new TestD1(); const content=new MemoryContentStore();
    const make=()=>new EditorialService(new D1Repository(db),content,{now:()=>new Date("2026-09-06T08:00:00Z")},{next:()=>crypto.randomUUID()});
    const a={uid:"a",kind:"user" as const,scopes:[]};
    const one=await make().ingest(a,{sourceId:"manual",sourceName:"Manual",url:"https://example.com/a",title:"One",body:"A complete text"});
    const two=await make().ingest(a,{sourceId:"manual",sourceName:"Manual",url:"https://example.com/a",title:"One",body:"A complete text"});
    expect(two.candidate.id).toBe(one.candidate.id);
    expect(two.deduped).toBe(true);
    expect(await new D1Repository(db).read("b",tx=>tx.listCandidates(10))).toEqual([]);
    db.db.close();
  });
  it("rolls back errors and reads staged values",async()=>{
    const db=new TestD1();const repo=new D1Repository(db);
    await expect(repo.transaction("a",async tx=>{
      await tx.putPreferences(defaultPreferences(new Date()));
      expect((await tx.getPreferences())?.version).toBe(1);
      throw new Error("cancel");
    })).rejects.toThrow("cancel");
    expect(await repo.read("a",tx=>tx.getPreferences())).toBeNull();db.db.close();
  });
  it("retries a stale tenant epoch without committing any stale record",async()=>{
    const db=new TestD1();const repo=new D1Repository(db);let attempts=0;
    await repo.transaction("a",async tx=>{
      attempts++;
      const p=defaultPreferences(new Date());p.instructions=String(attempts);
      await tx.putPreferences(p);
      if(attempts===1) await db.prepare("UPDATE siftera_epochs SET version=version+1 WHERE uid=?").bind("a").run();
    });
    expect(attempts).toBe(2);expect((await repo.read("a",tx=>tx.getPreferences()))?.instructions).toBe("2");db.db.close();
  });
  it("R2 safely hydrates content and preserves the first full text",async()=>{
    const objects=new Map<string,{etag:string;value:string}>();let version=0;
    const bucket:ObjectBucket={
      async get(key){const row=objects.get(key);return row?{etag:row.etag,text:async()=>row.value}:null;},
      async put(key,value,options){const prior=objects.get(key);if(options?.onlyIf?.etagDoesNotMatch==="*"&&prior)return null;if(options?.onlyIf?.etagMatches&&options.onlyIf.etagMatches!==prior?.etag)return null;const next={etag:String(++version),value};objects.set(key,next);return next;},
    };
    const store=new R2ContentStore(bucket);
    const base={candidateId:"c",revision:1,access:"partial" as const,text:"Partial",contentHash:"a".repeat(64),extractedAt:new Date().toISOString(),extractorVersion:"test",truncated:false,originalCharacterCount:7};
    await store.put("a",base);
    await store.put("a",{...base,access:"full",text:"Full",contentHash:"b".repeat(64)});
    await expect(store.put("a",{...base,access:"full",text:"Other",contentHash:"c".repeat(64)})).rejects.toThrow("conflict");
    expect((await store.get("a","c",1))?.text).toBe("Full");expect(await store.get("b","c",1)).toBeNull();
  });
});
