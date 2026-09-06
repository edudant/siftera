import { useRef, useState } from "react";
import type { EditorialSubmission } from "@siftera/shared";
import { api } from "./api.js";

interface Job {
  run: { id: string; expiresAt: string };
  candidates: Array<{ candidate: { id: string }; fullTextReceipt: boolean; articleRead: {status: string; access: string} | null }>;
  recommendedShortlistCandidateIds: string[];
  budgets: { originalReadLimit: number; originalReadsUsed: number; maxSelected: number };
}
export function EditorPanel({ notice, reload }: { notice: (text: string) => void; reload: () => Promise<void> }) {
  const [job, setJob] = useState<Job | null>(null);
  const [response, setResponse] = useState("");
  const [busy, setBusy] = useState("");
  const operation = useRef({ payload: "", id: "" });
  const refresh = async () => {
    const value = await api.exportEditorJob() as Job;
    setJob(value); return value;
  };
  const act = async (work: () => Promise<void>) => {
    try { await work(); }
    catch (reason) { notice(reason instanceof SyntaxError ? "Vložte platnou JSON odpověď editoru." : reason instanceof Error ? reason.message : "Zpracování se nepodařilo."); }
    finally { setBusy(""); }
  };
  const enrich = async (ids: string[]) => {
    if (!job) throw new Error("Nejdřív připravte zadání.");
    const unique = [...new Set(ids)];
    if (!unique.length || unique.some(id => typeof id !== "string" || !job.candidates.some(entry => entry.candidate.id === id))) throw new Error("Předvýběr musí obsahovat ID článků z tohoto zadání.");
    const fresh = unique.filter(id => !job.candidates.find(entry => entry.candidate.id === id)?.articleRead);
    if (fresh.length + job.budgets.originalReadsUsed > job.budgets.originalReadLimit) throw new Error("Předvýběr překračuje rozpočet načítání originálů.");
    for (let offset = 0; offset < unique.length; offset += 4) {
      setBusy(`Načítám originály ${offset + 1}–${Math.min(offset + 4, unique.length)} z ${unique.length}…`);
      await api.enrichEditorJob(job.run.id, unique.slice(offset, offset + 4));
    }
    const updated = await refresh();
    setResponse("");
    const failed = updated.candidates.filter(entry => entry.articleRead?.status === "failed").length;
    notice(`Podklady jsou doplněné. Předejte aktualizované zadání editoru.${failed ? ` U ${failed} originálů zůstal dostupný jen původní podklad.` : ""}`);
  };
  const accept = async () => {
    const parsed = JSON.parse(response) as { shortlistCandidateIds?: string[]; submission?: EditorialSubmission; submissions?: EditorialSubmission[]; orderedCandidateIds: string[] };
    if (Array.isArray(parsed.shortlistCandidateIds)) { await enrich(parsed.shortlistCandidateIds); return; }
    setBusy("Ověřuji a publikuji výběr…");
    if (operation.current.payload !== response) operation.current = { payload: response, id: crypto.randomUUID() };
    await api.importEditorBatches(parsed, operation.current.id);
    setJob(null); setResponse("");
    notice("Výběr je zveřejněný ve feedu.");
    await reload();
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(job, null, 2)], {type:"application/json"}));
    const link = document.createElement("a"); link.href = url; link.download = "siftera-editor-job.json"; link.click(); URL.revokeObjectURL(url);
  };
  return <section className="page"><p className="eyebrow">OSOBNÍ REDAKCE</p><h1>AI editor</h1>
    <p className="intro">Připravte články pro svého AI asistenta. Ten vybere, které originály stojí za přečtení, a potom sestaví výběr včetně podoby karet.</p>
    <button className="primary" disabled={!!busy} onClick={() => { setBusy("Připravuji přehled článků…"); void act(async () => { await refresh(); }); }}>Připravit redakční zadání</button>
    {busy && <p role="status">{busy}</p>}
    {job && <>
      <p>{job.candidates.length} kandidátů · {job.candidates.filter(entry => entry.fullTextReceipt).length} úplných textů · {job.budgets.originalReadsUsed}/{job.budgets.originalReadLimit} načtených originálů · cíl nejvýše {job.budgets.maxSelected} položek</p>
      <p className="hint">Předejte zadání AI. Může vrátit předvýběr pro načtení originálů, nebo rovnou finální výběr. Můžete také použít doporučený předvýběr aplikace.</p>
      <button disabled={!!busy || !job.recommendedShortlistCandidateIds.length} onClick={() => void act(() => enrich(job.recommendedShortlistCandidateIds))}>Doplnit doporučené originály</button>
      <button disabled={!!busy} onClick={download}>Stáhnout zadání</button>
      <label className="editor">Aktuální zadání<textarea readOnly rows={10} value={JSON.stringify(job, null, 2)} /></label>
      <button disabled={!!busy} onClick={() => { setBusy("Ruším rozpracovanou redakci…"); void act(async () => { await api.abortEditorJob(job.run.id); setJob(null); }); }}>Zrušit rozpracovanou redakci</button>
    </>}
    <label className="editor">Odpověď AI<textarea rows={10} value={response} onChange={event => setResponse(event.target.value)} placeholder="Vložte JSON s předvýběrem nebo hotovým výběrem" /></label>
    <label className="file">Nebo vyberte JSON soubor<input type="file" accept="application/json" onChange={event => { const file = event.target.files?.[0]; if (file) void act(async () => setResponse(await file.text())); }} /></label>
    <button className="primary" disabled={!!busy || !response.trim()} onClick={() => void act(accept)}>Zpracovat odpověď AI</button>
  </section>;
}
