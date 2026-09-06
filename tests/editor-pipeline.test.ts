import { describe, expect, it } from "vitest";
import { EditorialService } from "../packages/core/src/index.js";
import { MemoryContentStore, MemoryRepository } from "../packages/storage/src/index.js";
import { createPrototypeApi, MemoryPrototypeAuxStore } from "../packages/prototype-api/src/index.js";
import { extractArticle, PublicArticleReader, SafeHttpClient } from "../packages/connectors/src/index.js";

const user = { uid: "alice", kind: "user" as const, scopes: [] };
const system = { ...user, kind: "system" as const };
const body = "Tento článek vysvětluje užitečné technické poznatky a jejich dopady v praxi. ".repeat(20);
function setup() {
  let id = 0;
  let requests = 0;
  const repository = new MemoryRepository();
  const contentStore = new MemoryContentStore();
  const service = new EditorialService(repository, contentStore, {now: () => new Date("2026-09-06T08:00:00Z")}, {next: () => `id_${++id}`});
  const reader = { read: async () => { requests++; return {text: body, title:"Text", access:"full" as const, paywall:false, truncated:false}; } };
  const api = createPrototypeApi({service, repository, contentStore, auxStore: new MemoryPrototypeAuxStore(), articleReader:reader,
    resolvePrincipal: async request => ({principal:{...user,uid:request.headers.get("x-user") ?? user.uid},email:null})});
  const call = async (path: string, value: unknown, uid = "alice") => api(new Request(`https://siftera.test/api/v1${path}`, {method:"POST", headers:{origin:"https://siftera.test","content-type":"application/json","x-user":uid},body:JSON.stringify(value)}));
  return {repository, service, reader, call, requests: () => requests};
}
describe("public original extraction", () => {
  it("extracts the article without navigation, scripts or hidden subscriber content", () => {
    const page = extractArticle(`<html><head><title>Science</title></head><body><nav>Menu</nav><canvas>AD</canvas><article><h1>Science</h1><p>${body}</p><div hidden>SECRET</div><script>SECRET</script></article></body></html>`,"https://news.test/story");
    expect(page.access).toBe("full"); expect(page.text).toContain("technické"); expect(page.text).not.toContain("SECRET"); expect(page.text).not.toContain("Menu");
  });
  it("uses only a public preview for a paywall even if HTML contains a subscriber body", () => {
    const page = extractArticle(`<html><head><meta name="description" content="Veřejný náhled"><script type="application/ld+json">{"isAccessibleForFree":false,"articleBody":"SECRET"}</script></head><body><article><p>${body}</p><div class="paywall">Subscribe</div><p>SECRET</p></article></body></html>`,"https://news.test/paid");
    expect(page).toMatchObject({access:"partial",paywall:true,text:"Veřejný náhled"});
  });
  it("blocks private destinations and does not send credentials", async () => {
    let fetched = false;
    const reader = new PublicArticleReader(new SafeHttpClient({resolveHost:async()=>[{address:"127.0.0.1",family:4}],fetch:async()=>{fetched=true;return new Response("");}}));
    await expect(reader.read("https://private.test/story")).rejects.toThrow(); expect(fetched).toBe(false);
  });
});
describe("two-stage editorial workflow", () => {
  it("exports states and partial RSS, hydrates an owned original once, and publishes its rendering decision", async () => {
    const f = setup();
    const {candidate} = await f.service.ingest(user,{sourceId:"rss",sourceName:"RSS",url:"https://news.test/a",title:"Title",excerpt:"Perex",body:"Longer RSS content",access:"partial"});
    await f.service.patchState(user,candidate.id,0,{saved:true},"save");
    await f.service.markSeen(user,[candidate.id]);
    const job = await (await f.call("/editor/export",{operationId:"start"})).json();
    expect(job.candidates[0]).toMatchObject({state:{saved:true,read:false},ageDays:0,content:{text:"Longer RSS content"},fullTextReceipt:false});
    expect(job.candidates[0].state.seenAt).toBeTruthy(); expect(f.requests()).toBe(0);
    expect((await f.call("/editor/enrich",{runId:job.run.id,candidateIds:[candidate.id]},"bob")).status).not.toBe(200);
    const input = {runId:job.run.id,candidateIds:[candidate.id]};
    expect((await f.call("/editor/enrich",input)).status).toBe(200);
    expect((await f.call("/editor/enrich",input)).status).toBe(200); expect(f.requests()).toBe(1);
    const enriched = await (await f.call("/editor/export",{operationId:"again"})).json();
    expect(enriched.candidates[0]).toMatchObject({candidate:{revision:1,access:"full"},fullTextReceipt:true,content:{text:body}});
    const item = {candidate:{candidateId:candidate.id,revision:1},relatedCandidates:[],presentation:"long_read",headline:"Science",summary:"Useful reading",topics:["science"],assessment:{relevance:85,quality:"useful",novelty:"new",basis:"full_text"},whyIncluded:"Relevant science",emphasis:"lead",imageTreatment:"hide",openOriginal:true,distilledText:null,evidenceQuote:null,schoolDetails:[]};
    const payload = {submission:{schemaVersion:1,runId:job.run.id,batchId:"b1",editor:{client:"test",model:null,promptVersion:"editor-v2"},items:[item],rejected:[]},orderedCandidateIds:[candidate.id],operationId:"publish"};
    const published = await f.call("/editor/import",payload); expect(await published.json()).toMatchObject({items:[{item:{imageTreatment:"hide",emphasis:"lead"}}]}); expect(published.status).toBe(200);
    expect((await f.call("/editor/import",payload)).status).toBe(200);
  });
  it("keeps failed reads bounded and rejects changed revisions before fetching", async () => {
    const f = setup();
    const input = {sourceId:"rss",sourceName:"RSS",url:"https://news.test/b",title:"Old"};
    const {candidate} = await f.service.ingest(user,input); const run = await f.service.beginRun(system,"start");
    await f.service.ingest(user,{...input,title:"Changed"});
    await expect(f.service.readOriginal(system,run.id,candidate.id,f.reader)).rejects.toMatchObject({code:"CANDIDATE_CHANGED"}); expect(f.requests()).toBe(0);
  });
  it("imports more than ten items in one publication, preserves ordering and replays safely", async () => {
    const f = setup(); const ids: string[] = [];
    for (let n = 0; n < 12; n++) ids.push((await f.service.ingest(user,{sourceId:`source_${n % 3}`,sourceName:`Source ${n % 3}`,url:`https://news.test/${n}`,title:`Article ${n}`})).candidate.id);
    const run = await f.service.beginRun(system,"batch_start");
    const editor = {client:"test",model:null,promptVersion:"editor-v2"};
    const items = ids.map((id,n) => ({candidate:{candidateId:id,revision:1},relatedCandidates:[],presentation:"article",headline:`Article ${n}`,summary:"",topics:[`topic-${n % 3}`],assessment:{relevance:90-n,quality:"unknown",novelty:"new",basis:"metadata"},whyIncluded:"Relevant",emphasis:n===0?"lead":"compact",imageTreatment:"auto",openOriginal:true,distilledText:null,evidenceQuote:null,schoolDetails:[]}));
    const submissions = [items.slice(0,10),items.slice(10)].map((batch,n)=>({schemaVersion:1,runId:run.id,batchId:`batch_${n}`,editor,items:batch,rejected:[]}));
    const payload = {submissions,orderedCandidateIds:[...ids].reverse(),operationId:"publish_many"};
    const result = await f.call("/editor/import",payload); const data = await result.json();
    expect(result.status).toBe(200); expect(data.items).toHaveLength(12); expect(data.items[0].item.candidate.candidateId).toBe(ids[11]);
    expect((await f.call("/editor/import",payload)).status).toBe(200);
    const nextJob = await (await f.call("/editor/export",{operationId:"history"})).json();
    expect(nextJob.history).toHaveLength(12); expect(nextJob.knownTopics).toContain("topic-1");
    expect(nextJob.candidates).toHaveLength(0);
  });
  it("does not grant full-text receipts to paywall previews and caches failed reads", async () => {
    const f = setup(); const ids: string[] = [];
    for (let n = 0; n < 2; n++) ids.push((await f.service.ingest(user,{sourceId:"source",sourceName:"Source",url:`https://news.test/paid-${n}`,title:"Paywall"})).candidate.id);
    const run = await f.service.beginRun(system,"partial_run");
    await f.service.readOriginal(system,run.id,ids[0]!,{read:async()=>({text:"Preview",title:null,access:"full",paywall:true,truncated:false})});
    let failures = 0;
    const failing = {read:async()=>{failures++;throw new Error("timeout");}};
    await f.service.readOriginal(system,run.id,ids[1]!,failing); await f.service.readOriginal(system,run.id,ids[1]!,failing);
    expect(failures).toBe(1);
    const job = await (await f.call("/editor/export",{operationId:"partial_export"})).json();
    expect(job.candidates.every((entry:{fullTextReceipt:boolean})=>!entry.fullTextReceipt)).toBe(true);
    expect(job.candidates.find((entry:{candidate:{id:string}})=>entry.candidate.id===ids[0]).articleRead.access).toBe("partial");
    await expect(f.service.readRunContent(system,run.id,ids[0]!,1)).rejects.toMatchObject({code:"CONTENT_UNAVAILABLE"});
  });
  it("enforces the original-read budget and stops after preference changes", async () => {
    const f = setup();
    const preferences = await f.service.getPreferences(user);
    await f.service.savePreferences(user,preferences.version,{...preferences,contentReadLimit:1});
    const one = (await f.service.ingest(user,{sourceId:"source",sourceName:"Source",url:"https://news.test/one",title:"One"})).candidate;
    const two = (await f.service.ingest(user,{sourceId:"source",sourceName:"Source",url:"https://news.test/two",title:"Two"})).candidate;
    const run = await f.service.beginRun(system,"limit_start");
    await f.service.readOriginal(system,run.id,one.id,f.reader);
    await expect(f.service.readOriginal(system,run.id,two.id,f.reader)).rejects.toMatchObject({code:"CONTENT_READ_LIMIT"});
    const updated = await f.service.getPreferences(user);
    await f.service.savePreferences(user,updated.version,{...updated,contentReadLimit:2});
    expect((await f.call("/editor/export",{operationId:"stale"})).status).toBe(409);
    await expect(f.service.readOriginal(system,run.id,two.id,f.reader)).rejects.toMatchObject({code:"STALE_PREFERENCES"});
  });
});
