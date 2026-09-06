import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorialItem, FeedItem, PreferenceProfile } from "@siftera/shared";
import { api, ApiError, type Bootstrap, type PrototypeSource } from "./api.js";
import "./checkbox.css";

type Tab = "today" | "library" | "inbox" | "saved" | "settings" | "sources" | "editor";
type SharedInput = { url: string; title: string; text: string };
type InboxEntry = Bootstrap["inbox"][number];
type WebMcpTool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, never>; additionalProperties: false };
  annotations: { readOnlyHint: true; untrustedContent: true };
  execute: (input: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
};
type ModelContext = { registerTool: (tool: WebMcpTool, options: { signal: AbortSignal }) => void };

const formatDate = (value: string | null) => value ? new Intl.DateTimeFormat("cs-CZ", { day: "numeric", month: "long" }).format(new Date(value)) : "bez data";
const folded = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("cs");
const message = (reason: unknown) => reason instanceof ApiError && reason.status === 401 ? "Pro pokračování se přihlaste." : reason instanceof Error ? reason.message : "Něco se nepovedlo.";
/** „1 položka čeká“, „3 položky čekají“, „12 položek čeká“. */
const waitingLabel = (count: number) => count === 1 ? "1 položka čeká na redakční zpracování" : count < 5 ? `${count} položky čekají na redakční zpracování` : `${count} položek čeká na redakční zpracování`;
const pending = (data: Bootstrap | null) => (data?.inbox ?? []).filter((entry) => !entry.state.hidden);
const basisLabel: Record<string, string> = { full_text: "celý dostupný text", excerpt: "výňatek od zdroje", metadata: "pouze metadata" };
const presentationLabel: Record<string, string> = { article: "Článek", long_read: "Delší čtení", distilled_fact: "Ověřený fakt", school_notice: "Školní oznámení", video: "Video", audio: "Audio", discovery: "Objev", learning: "K naučení", recommendation: "Doporučení", short_fun: "Pro pobavení" };

export default function App() {
  const [tab, setTab] = useState<Tab>("today");
  const [data, setData] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const bootstrapRef = useRef<Bootstrap | null>(null);
  const [shared, setShared] = useState<SharedInput | null>(() => {
    const params = new URLSearchParams(location.search);
    const value = { url: params.get("url") ?? "", title: params.get("title") ?? "", text: params.get("text") ?? "" };
    return value.url || value.title || value.text ? value : null;
  });
  const reload = async () => { setLoading(true); setError(null); try { setData(await api.bootstrap()); } catch (reason) { setError(message(reason)); } finally { setLoading(false); } };
  useEffect(() => { void reload(); }, []);
  bootstrapRef.current = data;
  useEffect(() => {
    const controller = new AbortController();
    const modelContext = (document as Document & { modelContext?: ModelContext }).modelContext;
    modelContext?.registerTool({
      name: "siftera_get_status",
      description: "Vrátí stručný stav aktuálně načteného osobního prostoru Siftera.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContent: true },
      execute: async (input) => {
        if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).length !== 0) {
          throw new TypeError("siftera_get_status nepřijímá žádný vstup.");
        }
        const current = bootstrapRef.current;
        return { content: [{ type: "text", text: JSON.stringify({ signedIn: Boolean(current?.user), loaded: { feed: current?.feed.items.length ?? 0, library: current?.library.length ?? 0, inbox: current?.inbox.length ?? 0, sources: current?.sources.length ?? 0 }, lastPublishedAt: current?.feed.run?.publishedAt ?? null }) }] };
      },
    }, { signal: controller.signal });
    return () => controller.abort();
  }, []);
  const all = useMemo(() => data ? [...data.feed.items, ...data.library] : [], [data]);
  const opened = useMemo(() => open ? all.find((feed) => feed.item.id === open) ?? null : null, [all, open]);
  const results = useMemo(() => { const needle = folded(query); const items = [...new Map(all.map((item) => [item.item.id, item])).values()]; return needle ? items.filter((item) => folded(`${item.item.headline} ${item.item.summary} ${item.item.topics.join(" ")} ${item.item.provenance[0]?.sourceName ?? ""}`).includes(needle)) : []; }, [all, query]);
  const changeState = async (item: FeedItem, patch: { read?: boolean; saved?: boolean; hidden?: boolean }) => { try { await api.setItemState(item.state.candidateId, item.state.version, patch); await reload(); } catch (reason) { setNotice(message(reason)); } };
  const hideCandidate = async (entry: InboxEntry, hidden = true) => { try { await api.setItemState(entry.candidate.id, entry.state.version, { hidden }); await reload(); } catch (reason) { setNotice(message(reason)); } };
  const acceptShare = async () => { if (!shared) return; try { await api.addArticle(shared); setShared(null); history.replaceState({}, "", location.pathname); setNotice("Odkaz čeká v inboxu na zpracování."); await reload(); } catch (reason) { setNotice(message(reason)); } };
  return <div className="app"><header><button className="brand" onClick={() => setTab("today")}>Siftera<span>•</span></button><label className="search">⌕<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat v načtených položkách" aria-label="Hledat v načtených položkách" /></label></header><main>
    {shared && <ShareBox value={shared} update={setShared} accept={() => void acceptShare()} dismiss={() => { setShared(null); history.replaceState({}, "", location.pathname); }} />}
    {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice(null)} aria-label="Zavřít">×</button></div>}
    {error && <div className="error" role="alert">{error}{error === "Pro pokračování se přihlaste." ? <a href="/signin-with-chatgpt?return_to=/">Přihlásit se</a> : <button onClick={() => void reload()}>Načíst znovu</button>}</div>}
    {query ? <Page title={`„${query}“`} eyebrow="HLEDÁNÍ V NAČTENÝCH DATECH"><p className="hint">Prohledává se aktuálně načtený výběr a knihovna. Starší archiv se nepředstírá.</p><Cards items={results} onState={changeState} onOpen={(feed) => setOpen(feed.item.id)} empty={<Empty title="Nic jsme nenašli." detail="Hledá se jen ve vydaném výběru a knihovně, ne v čekajících položkách Inboxu." />} /></Page> : <Content tab={tab} data={data} loading={loading} setTab={setTab} reload={reload} notice={setNotice} onState={changeState} onHide={hideCandidate} onOpen={(feed) => setOpen(feed.item.id)} />}
  </main>{!query && <Nav tab={tab} setTab={setTab} />}
  {opened && <Detail feed={opened} onState={changeState} onClose={() => setOpen(null)} />}</div>;
}

function Content({ tab, data, loading, setTab, reload, notice, onState, onHide, onOpen }: { tab: Tab; data: Bootstrap | null; loading: boolean; setTab: (tab: Tab) => void; reload: () => Promise<void>; notice: (text: string) => void; onState: (item: FeedItem, patch: { read?: boolean; saved?: boolean; hidden?: boolean }) => Promise<void>; onHide: (entry: InboxEntry, hidden: boolean) => Promise<void>; onOpen: (feed: FeedItem) => void }) {
  if (loading) return <Loading />;
  if (tab === "today") return <Page title="Váš výběr" eyebrow={`DNES · ${formatDate(data?.feed.run?.publishedAt ?? null)}`}><Cards items={data?.feed.items ?? []} onState={onState} onOpen={onOpen} empty={<NothingYet data={data} setTab={setTab} title="Dnešní výběr je zatím prázdný." published="Vydání sestavuje AI editor z čekajících položek; do té doby tu nic nepřibude." />} /></Page>;
  if (tab === "library") return <Page title="Knihovna" eyebrow="POSLEDNÍ NAČTENÉ POLOŽKY"><Cards items={data?.library ?? []} onState={onState} onOpen={onOpen} empty={<NothingYet data={data} setTab={setTab} title="Knihovna je zatím prázdná." published="Do knihovny se ukládají vydané položky a zdroje v režimu „vše do knihovny“." />} /></Page>;
  if (tab === "saved") return <Page title="Uložené" eyebrow="VAŠE ČTENÍ NA POZDĚJI"><Cards items={(data?.library ?? []).filter((item) => item.state.saved)} onState={onState} onOpen={onOpen} empty={<Empty title="Nemáte nic uloženého." detail="Srdíčkem u karty si odložíte položku na později." />} /></Page>;
  if (tab === "inbox") return <Inbox data={data} reload={reload} notice={notice} onHide={onHide} />;
  if (tab === "sources") return <Sources data={data} reload={reload} notice={notice} />;
  if (tab === "editor") return <Editor notice={notice} />;
  return <Settings preferences={data?.preferences ?? null} notice={notice} setTab={setTab} reload={reload} />;
}

/** Prázdný výběr znamená pokaždé jiný další krok: přidat zdroj, obnovit ho, nebo spustit AI editor. */
function NothingYet({ data, setTab, title, published }: { data: Bootstrap | null; setTab: (tab: Tab) => void; title: string; published: string }) {
  const waiting = pending(data).length;
  if (waiting) return <Empty title={`${waitingLabel(waiting)}.`} detail={published} action={{ label: "Otevřít AI editor", onClick: () => setTab("editor") }} />;
  if (!data?.sources.length) return <Empty title="Zatím nemáte žádný zdroj." detail="Přidejte RSS/Atom zdroj nebo vložte odkaz do Inboxu. Siftera nenačítá nic sama od sebe." action={{ label: "Přidat zdroj", onClick: () => setTab("sources") }} />;
  return <Empty title={title} detail="Obnovení zdrojů je v prototypu ruční. Spusťte ho u konkrétního zdroje." action={{ label: "Otevřít zdroje", onClick: () => setTab("sources") }} />;
}

function Nav({ tab, setTab }: { tab: Tab; setTab: (tab: Tab) => void }) { const entries: Array<[Tab, string, string]> = [["today", "☼", "Dnes"], ["library", "☷", "Knihovna"], ["inbox", "＋", "Inbox"], ["saved", "♡", "Uložené"], ["settings", "⚙", "Nastavení"]]; return <nav>{entries.map(([id, icon, label]) => <button key={id} className={id === tab || (id === "settings" && (tab === "sources" || tab === "editor")) ? "active" : ""} onClick={() => setTab(id)}><span>{icon}</span>{label}</button>)}</nav>; }
function Page({ title, eyebrow, children }: { title: string; eyebrow: string; children: React.ReactNode }) { return <section><div className="heading"><p>{eyebrow}</p><h1>{title}</h1></div>{children}</section>; }
function Loading() { return <div className="cards" aria-busy="true"><div className="skeleton"/><div className="skeleton"/><div className="skeleton"/></div>; }

function Cards({ items, onState, onOpen, empty }: { items: FeedItem[]; onState: (item: FeedItem, patch: { read?: boolean; saved?: boolean; hidden?: boolean }) => Promise<void>; onOpen: (feed: FeedItem) => void; empty: React.ReactNode }) { const visible = items.filter((item) => !item.state.hidden); return visible.length ? <div className="cards">{visible.map((feed) => <Card key={feed.item.id} feed={feed} onState={onState} onOpen={onOpen} />)}</div> : <>{empty}</>; }
function Empty({ title, detail, action }: { title: string; detail: string; action?: { label: string; onClick: () => void } }) { return <div className="empty"><span>⌁</span><h2>{title}</h2><p>{detail}</p>{action && <button className="primary" onClick={action.onClick}>{action.label}</button>}</div>; }
function Card({ feed, onState, onOpen }: { feed: FeedItem; onState: (item: FeedItem, patch: { read?: boolean; saved?: boolean; hidden?: boolean }) => Promise<void>; onOpen: (feed: FeedItem) => void }) {
  const { item, state } = feed;
  const provenance = item.provenance[0];
  const label = item.presentation === "long_read" && item.readingMinutes ? `Stojí za přečtení · ${item.readingMinutes} min` : presentationLabel[item.presentation] ?? null;
  return <article className={`card tap ${item.presentation} ${state.read ? "read" : ""}`} onClick={() => onOpen(feed)}>
    <div className="meta"><span>{provenance?.sourceName ?? "Zdroj"}</span><span className="dot">·</span><span>{formatDate(provenance?.publishedAt ?? null)}</span>{feed.groups.includes("school") && <b>Škola</b>}</div>
    <Shot image={item.image} seed={provenance?.sourceName ?? item.headline} alt={item.headline} />
    <div className="actions" onClick={(event) => event.stopPropagation()}>
      <button className={state.read ? "selected" : ""} onClick={() => void onState(feed, { read: !state.read })} aria-label={state.read ? "Označit jako nepřečtené" : "Označit jako přečtené"} aria-pressed={state.read}>✓</button>
      <button className={state.saved ? "selected" : ""} onClick={() => void onState(feed, { saved: !state.saved })} aria-label={state.saved ? "Odebrat z uložených" : "Uložit na později"} aria-pressed={state.saved}>{state.saved ? "♥" : "♡"}</button>
      <button onClick={() => void onState(feed, { hidden: true })} aria-label="Skrýt z výběru">⌄</button>
      <span className="spacer" />
    </div>
    {item.presentation === "distilled_fact" && item.distilledText ? <p className="fact">{item.distilledText}</p> : <><h2>{item.headline}</h2><p className="lede">{item.summary}</p></>}
    {label && <p className="kicker">{label}</p>}
  </article>;
}

/** Deterministický odstín podle zdroje, aby položka bez obrázku držela rytmus feedu a stejný zdroj stejnou barvu. */
function hue(seed: string): number {
  let value = 0;
  for (const character of seed) value = (value * 31 + character.codePointAt(0)!) % 3600;
  return value / 10;
}
function Shot({ image, seed, alt }: { image: EditorialItem["image"]; seed: string; alt: string }) {
  if (image) return <div className="shot"><img src={image.url} alt={image.alt || alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" width={image.width ?? undefined} height={image.height ?? undefined} /></div>;
  const base = hue(seed);
  return <div className="shot blank" style={{ background: `linear-gradient(135deg, hsl(${base} 52% 42%), hsl(${(base + 42) % 360} 48% 30%))` }} aria-hidden="true"><span>{seed}</span></div>;
}

/** Detail je vrstva nad feedem: ukazuje jen to, co skutečně máme, originál je poslední krok (ADR-014). */
function Detail({ feed, onState, onClose }: { feed: FeedItem; onState: (item: FeedItem, patch: { read?: boolean; saved?: boolean; hidden?: boolean }) => Promise<void>; onClose: () => void }) {
  const { item, state } = feed;
  const provenance = item.provenance[0];
  useEffect(() => {
    if (!state.read) void onState(feed, { read: true });
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", escape);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", escape); document.body.style.overflow = previous; };
    // Efekt patří k otevřené položce; přepnutí na jinou ho spustí znovu, změna callbacků ne.
  }, [item.id]);
  return <div className="sheet" role="dialog" aria-modal="true" aria-label={item.headline}>
    <div className="sheet-bar"><button onClick={onClose} aria-label="Zpět na výběr">←</button><strong>{provenance?.sourceName ?? "Zdroj"}</strong></div>
    <div className="sheet-body">
      <Shot image={item.image} seed={provenance?.sourceName ?? item.headline} alt={item.headline} />
      <h1>{item.headline}</h1>
      {item.presentation === "distilled_fact" && item.distilledText && <p className="fact">{item.distilledText}</p>}
      <p className="summary">{item.summary}</p>
      {provenance?.title && provenance.title !== item.headline && <p className="source-lede"><strong>Původní titulek:</strong> {provenance.title}</p>}
      {item.topics.length > 0 && <div className="topics">{item.topics.map((topic) => <span key={topic}>{topic}</span>)}</div>}
      <div className="sheet-actions">
        <button className={state.saved ? "selected" : ""} onClick={() => void onState(feed, { saved: !state.saved })} aria-pressed={state.saved}>{state.saved ? "♥ Uloženo" : "♡ Uložit"}</button>
        <button className={state.read ? "selected" : ""} onClick={() => void onState(feed, { read: !state.read })} aria-pressed={state.read}>{state.read ? "✓ Přečteno" : "Označit přečtené"}</button>
      </div>
      <div className="origin">
        <h3>Původ</h3>
        <p>{provenance?.sourceName} · {formatDate(provenance?.publishedAt ?? null)}</p>
        <p>{provenance?.canonicalUrl}</p>
        <p>Shrnutí sestavil váš AI editor. Podklad: {basisLabel[item.assessment?.basis ?? "metadata"]}.</p>
        {item.whyIncluded && <p>Proč to vidíte: {item.whyIncluded}</p>}
      </div>
      {provenance?.canonicalUrl && <a className="primary leave" href={provenance.canonicalUrl} target="_blank" rel="noopener noreferrer">Otevřít originál na webu zdroje ↗</a>}
    </div>
  </div>;
}

function Inbox({ data, reload, notice, onHide }: { data: Bootstrap | null; reload: () => Promise<void>; notice: (text: string) => void; onHide: (entry: InboxEntry, hidden: boolean) => Promise<void> }) {
  const [input, setInput] = useState<SharedInput>({ url: "", title: "", text: "" });
  const [fullText, setFullText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(20);
  const [showHidden, setShowHidden] = useState(false);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setBusy(true); try { await api.addArticle({ ...input, fullText }); setInput({ url: "", title: "", text: "" }); setFullText(false); notice("Položka čeká v inboxu na zpracování."); await reload(); } catch (reason) { notice(message(reason)); } finally { setBusy(false); } };
  const waiting = useMemo(() => [...(showHidden ? (data?.inbox ?? []).filter((entry) => entry.state.hidden) : pending(data))].sort((left, right) => (right.candidate.publishedAt ?? right.candidate.discoveredAt).localeCompare(left.candidate.publishedAt ?? left.candidate.discoveredAt)), [data, showHidden]);
  const names = useMemo(() => new Map((data?.sources ?? []).map((entry) => [entry.id, entry.name])), [data]);
  const hiddenCount = (data?.inbox ?? []).filter((entry) => entry.state.hidden).length;
  return <Page title="Inbox" eyebrow="RUČNÍ PŘÍJEM"><p className="intro">Vložte odkaz nebo vlastní text. Nic se nevydává za AI výběr, dokud to neprojde vaším workflow.</p><form onSubmit={submit}><label>Odkaz<input type="url" value={input.url} onChange={(event) => setInput({ ...input, url: event.target.value })} placeholder="https://…" /></label><label>Název <em>volitelné</em><input value={input.title} onChange={(event) => setInput({ ...input, title: event.target.value })} /></label><label>Text <em>volitelné</em><textarea rows={6} value={input.text} onChange={(event) => { const text = event.target.value; setInput({ ...input, text }); if (!text) setFullText(false); }} /></label><label className="full-text"><input type="checkbox" checked={fullText} disabled={!input.text} onChange={(event) => setFullText(event.target.checked)} />Vkládám celý text článku</label><button className="primary" disabled={busy || (!input.url && !input.text)}>Přidat do inboxu</button></form>
    <div className="waiting"><h2>{showHidden ? "Skryté položky" : "Čeká na zpracování"}</h2><p className="hint">{showHidden ? "Skryté položky AI editor nevybírá. Šipkou je vrátíte mezi čekající." : waiting.length ? `${waitingLabel(waiting.length)}. Zobrazeny jsou názvy a úryvky od zdroje; shrnutí vzniká až v AI editoru.` : "Zatím nic nečeká. Načtěte zdroj nebo vložte odkaz výše."}</p>{hiddenCount > 0 && <button className="quiet" onClick={() => { setShowHidden(!showHidden); setShown(20); }}>{showHidden ? "← Zpět na čekající" : `Zobrazit skryté (${hiddenCount})`}</button>}</div>
    {waiting.length > 0 && <div className="cards">{waiting.slice(0, shown).map((entry) => <PendingCard key={entry.candidate.id} entry={entry} source={entry.candidate.sourceId === "manual" ? "Ručně vloženo" : names.get(entry.candidate.sourceId) ?? "Odebraný zdroj"} onHide={onHide} />)}</div>}
    {waiting.length > shown && <button className="quiet more" onClick={() => setShown(shown + 20)}>Zobrazit dalších {Math.min(20, waiting.length - shown)}</button>}
  </Page>;
}
function PendingCard({ entry, source, onHide }: { entry: InboxEntry; source: string; onHide: (entry: InboxEntry, hidden: boolean) => Promise<void> }) {
  const { candidate, state } = entry;
  return <article className={`card waiting-card ${state.hidden ? "read" : ""}`}>
    <div className="meta"><span>{source}</span><span className="dot">·</span><span>{formatDate(candidate.publishedAt)}</span>{candidate.access !== "full" && <b>bez plného textu</b>}</div>
    <Shot image={candidate.image} seed={source} alt={candidate.title} />
    <div className="actions">
      <a className="quiet" href={candidate.canonicalUrl} target="_blank" rel="noopener noreferrer" aria-label="Otevřít originál">Otevřít originál ↗</a>
      <span className="spacer" />
      <button onClick={() => void onHide(entry, !state.hidden)} aria-label={state.hidden ? "Vrátit mezi čekající" : "Skrýt z inboxu"} aria-pressed={state.hidden}>{state.hidden ? "↺" : "⌄"}</button>
    </div>
    <h2>{candidate.title || candidate.canonicalUrl}</h2>
    {candidate.excerpt && <p className="lede">{candidate.excerpt}</p>}
  </article>;
}

function ShareBox({ value, update, accept, dismiss }: { value: SharedInput; update: (value: SharedInput) => void; accept: () => void; dismiss: () => void }) { return <aside className="share"><p>PŘEDAT DO SIFTERY</p><h2>Přidat sdílený obsah?</h2><label>Název<input value={value.title} onChange={(event) => update({ ...value, title: event.target.value })} /></label><label>Odkaz<input value={value.url} onChange={(event) => update({ ...value, url: event.target.value })} /></label><label>Poznámka<textarea rows={3} value={value.text} onChange={(event) => update({ ...value, text: event.target.value })} /></label><button className="primary" onClick={accept}>Potvrdit do inboxu</button><button className="quiet" onClick={dismiss}>Zahodit</button></aside>; }

function Sources({ data, reload, notice }: { data: Bootstrap | null; reload: () => Promise<void>; notice: (text: string) => void }) {
  const [source, setSource] = useState({ name: "", url: "", group: "", deliveryMode: "curated" as "curated" | "all" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setFieldErrors({});
    try {
      await api.addSource({ name: source.name.trim() || source.url.trim(), url: source.url.trim(), pluginId: "rss", groups: source.group.trim() ? [source.group] : [], deliveryMode: source.deliveryMode });
      setSource({ name: "", url: "", group: "", deliveryMode: "curated" });
      notice("Zdroj byl přidán.");
      await reload();
    } catch (reason) {
      if (reason instanceof ApiError && reason.details.length) setFieldErrors(Object.fromEntries(reason.details.map(({ field, reason }) => [field, reason])));
      notice(message(reason));
    }
  };
  const refresh = async (entry: PrototypeSource) => { try { const result = await api.refreshSource(entry.id); const summary = [`Načteno: ${result.ingested}.`, result.skipped ? `Přeskočeno: ${result.skipped}.` : "", result.complete === false ? "Zdroj měl víc položek, než prototyp načítá; starší zůstaly u zdroje." : "", ...result.errors].filter(Boolean).join(" "); notice(summary); await reload(); } catch (reason) { notice(message(reason)); } };
  const groupError = fieldErrors.groups || fieldErrors["groups.0"];
  return <Page title="Zdroje" eyebrow="VAŠE ZDROJE"><p className="intro">Přidávejte pouze zdroje, které chcete číst. „Vše do knihovny“ se hodí pro školní oznámení.</p><form onSubmit={add} noValidate><label>URL zdroje<input required type="url" value={source.url} onChange={(event) => setSource({ ...source, url: event.target.value })} placeholder="https://example.cz/rss" aria-invalid={Boolean(fieldErrors.url)} aria-describedby={fieldErrors.url ? "source-url-error" : undefined} />{fieldErrors.url && <small className="field-error" id="source-url-error">{fieldErrors.url}</small>}</label><label>Název<input value={source.name} onChange={(event) => setSource({ ...source, name: event.target.value })} aria-invalid={Boolean(fieldErrors.name)} aria-describedby={fieldErrors.name ? "source-name-error" : undefined} />{fieldErrors.name && <small className="field-error" id="source-name-error">{fieldErrors.name}</small>}</label><div className="pair"><label>Skupina <em>volitelné</em><input value={source.group} onChange={(event) => setSource({ ...source, group: event.target.value })} placeholder="např. Zprávy nebo škola" aria-invalid={Boolean(groupError)} aria-describedby={groupError ? "source-group-error" : undefined} />{groupError && <small className="field-error" id="source-group-error">{groupError}</small>}</label><label>Režim<select value={source.deliveryMode} onChange={(event) => setSource({ ...source, deliveryMode: event.target.value as "curated" | "all" })}><option value="curated">výběr editora</option><option value="all">vše do knihovny</option></select></label></div><button className="primary">Přidat zdroj</button></form><div className="sources">{data?.sources.map((entry) => <article key={entry.id}><div><h2>{entry.name}</h2><p>{entry.url}</p><small>{entry.lastError ? `Chyba: ${entry.lastError}` : entry.lastFetchedAt ? `Naposledy ${formatDate(entry.lastFetchedAt)}` : "Čeká na první načtení"}</small></div><div className="source-actions"><button onClick={() => void refresh(entry)}>Obnovit</button><button onClick={() => void api.patchSource(entry.id, { enabled: !entry.enabled }).then(reload).catch((reason: unknown) => notice(message(reason)))}>{entry.enabled ? "Pozastavit" : "Zapnout"}</button><button className="danger" onClick={() => { if (confirm(`Odebrat „${entry.name}“?`)) void api.deleteSource(entry.id).then(reload).catch((reason: unknown) => notice(message(reason))); }}>Odebrat</button></div></article>)}</div></Page>;
}

function Settings({ preferences, notice, setTab, reload }: { preferences: PreferenceProfile | null; notice: (text: string) => void; setTab: (tab: Tab) => void; reload: () => Promise<void> }) { const [draft, setDraft] = useState<PreferenceProfile | null>(preferences); useEffect(() => setDraft(preferences), [preferences]); const save = async () => { if (!draft) return; try { await api.savePreferences(draft); notice("Preference jsou uložené."); await reload(); } catch (reason) { notice(message(reason)); } }; return <Page title="Nastavení" eyebrow="VÁŠ PROSTOR"><div className="settings"><button onClick={() => setTab("sources")}><span>☷</span><strong>Zdroje</strong><small>Přidat, obnovit nebo odebrat</small><b>›</b></button><button onClick={() => setTab("editor")}><span>✦</span><strong>AI editor</strong><small>Exportovat práci a importovat odpověď</small><b>›</b></button></div><section className="prefs"><h2>Co chci číst</h2>{draft ? <><label>Popište svůj dlouhodobý výběr<textarea rows={6} value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /></label><label>Témata oddělte čárkou<input value={draft.preferredTopics.join(", ")} onChange={(event) => setDraft({ ...draft, preferredTopics: event.target.value.split(",").map((word) => word.trim()).filter(Boolean) })} /></label><button className="primary" onClick={() => void save()}>Uložit preference</button></> : <p>Preference se načítají z vašeho účtu.</p>}</section></Page>; }
function editorJobSummary(value: unknown): string {
  const candidates = typeof value === "object" && value !== null && Array.isArray((value as { candidates?: unknown }).candidates)
    ? (value as { candidates: Array<{ content?: unknown }> }).candidates
    : [];
  const withFullText = candidates.filter((candidate) => candidate.content && typeof candidate.content === "object").length;
  return `Kandidáti: ${candidates.length}. Plný text k dispozici: ${withFullText}.`;
}

function Editor({ notice }: { notice: (text: string) => void }) { const [job, setJob] = useState(""); const [jobSummary, setJobSummary] = useState(""); const [response, setResponse] = useState(""); const [confirmed, setConfirmed] = useState(false); const exportJob = async () => { try { const value = await api.exportEditorJob(); const json = JSON.stringify(value, null, 2); setJob(json); setJobSummary(editorJobSummary(value)); const blob = new Blob([json], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "siftera-editor-job.json"; link.click(); URL.revokeObjectURL(link.href); notice("Redakční zadání je připravené ke zkopírování i stažené jako JSON."); } catch (reason) { notice(message(reason)); } }; const importJob = async () => { try { const parsed = JSON.parse(response) as { submission: import("@siftera/shared").EditorialSubmission; orderedCandidateIds: string[] }; await api.importEditorResponse(parsed.submission, parsed.orderedCandidateIds); notice("Odpověď prošla serverovou validací a byla importována."); setResponse(""); } catch (reason) { notice(reason instanceof SyntaxError ? "Vložte platný JSON." : message(reason)); } }; const readFile = (file: File | undefined) => { if (!file) return; void file.text().then(setResponse); }; return <Page title="AI editor" eyebrow="EXTERNÍ WORKFLOW"><p className="intro">AI běží mimo Sifteru. Aplikace neposílá přihlašovací údaje k AI službě; exportuje ověřený balíček a import vždy validuje server.</p><button className="primary" onClick={() => void exportJob()}>Připravit redakční zadání</button>{job && <><p className="hint">{jobSummary}</p><label className="editor">Redakční zadání<textarea readOnly rows={12} value={job} /></label></>}<hr/><label className="editor">Odpověď editoru<textarea rows={10} value={response} onChange={(event) => setResponse(event.target.value)} placeholder="Vložte JSON s submission a orderedCandidateIds" /></label><label className="file">Nebo vyberte JSON soubor<input type="file" accept="application/json" onChange={(event) => readFile(event.target.files?.[0])} /></label><label className="confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Rozumím, že server odpověď ověří a může ji odmítnout.</label><button className="primary" disabled={!confirmed || !response} onClick={() => void importJob()}>Ověřit a importovat</button></Page>; }
