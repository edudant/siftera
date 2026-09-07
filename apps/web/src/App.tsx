import { EditorPanel } from "./EditorPanel.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Candidate, ChannelIcon, EditorialItem, FeedItem, PreferenceProfile, UserItemState } from "@siftera/shared";
import { api, ApiError, NEEDS_TOKEN, readToken, writeToken, type Bootstrap, type FeedCategory, type ImageMode, type PrototypeSource } from "./api.js";
import "./checkbox.css";

type Tab = "feed" | "settings" | "sources" | "editor" | "add";
/** Feed = nepřečtený proud po předvýběru, Vše = celý kanál včetně přečteného a nevybraného (ADR-021). */
type FeedMode = "feed" | "all";
type FeedSort = "smart" | "newest";
type FeedFilter = { channel: string; mode: FeedMode; sort: FeedSort; sourceId: string | null };
/** Kanál je karta v horní liště: Přehled, uživatelské kategorie, Uložené. */
type Channel = { id: string; label: string; icon: keyof typeof GLYPHS; category: FeedCategory | null; special?: "home" | "saved" };
type SharedInput = { url: string; title: string; text: string };
type InboxEntry = { candidate: Candidate; state: UserItemState };
type WebMcpTool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, never>; additionalProperties: false };
  annotations: { readOnlyHint: true; untrustedContent: true };
  execute: (input: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
};
type ModelContext = { registerTool: (tool: WebMcpTool, options: { signal: AbortSignal }) => void };

const formatDate = (value: string | null) => value ? new Intl.DateTimeFormat("cs-CZ", { day: "numeric", month: "long" }).format(new Date(value)) : "bez data";
/** Ve feedu čteme čas jako v proudu: „teď“, „6 h“, „včera“; starší už dává smysl jen datem. */
function ago(value: string | null): string {
  if (!value) return "";
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return formatDate(value);
  if (minutes < 60) return minutes < 2 ? "teď" : `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  if (hours < 48) return "včera";
  return new Intl.DateTimeFormat("cs-CZ", { day: "numeric", month: "numeric" }).format(new Date(value));
}
const folded = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("cs");
const message = (reason: unknown) => reason instanceof ApiError && reason.status === 401 ? "Chybí nebo neplatí token. Vlož ho v Nastavení." : reason instanceof Error ? reason.message : "Něco se nepovedlo.";
/** „1 položka čeká“, „3 položky čekají“, „12 položek čeká“. */
const waitingLabel = (count: number) => count === 1 ? "1 položka čeká na redakční zpracování" : count < 5 ? `${count} položky čekají na redakční zpracování` : `${count} položek čeká na redakční zpracování`;
/** Jméno zdroje se řeší z aktuální konfigurace; zmrazená provenance u starších vydání může nést i URL. */
function sourceLabel(sourceId: string | undefined, frozen: string | undefined, names: Map<string, string>): string {
  const current = sourceId ? names.get(sourceId) : undefined;
  const label = current ?? frozen ?? "Zdroj";
  if (!/^https?:\/\//i.test(label)) return label;
  try { return new URL(label).hostname.replace(/^www\./, ""); } catch { return label; }
}
const RESUME_KEY = "siftera:resume";
/**
 * YouTube je jediný zdroj, který dovoluje přehrát obsah přímo ve feedu (oficiální embed) — u článků to
 * zakazuje `X-Frame-Options` zdroje. Identifikátor bere z `media`, ale vydané položky jsou nemměnné
 * (ADR-010), takže starším vydáním, která ještě `media` nenesla, ho odvodí z kanonické adresy.
 */
function youtubeId(item: EditorialItem): string | null {
  if (item.media?.provider === "youtube" && item.media.externalId) return item.media.externalId;
  const url = item.provenance[0]?.canonicalUrl;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const id = host === "youtu.be" ? parsed.pathname.slice(1)
      : host === "youtube.com" || host === "m.youtube.com" ? parsed.searchParams.get("v") ?? (parsed.pathname.startsWith("/shorts/") ? parsed.pathname.slice(8) : null)
      : null;
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
/** „12:04“, u delších „1:02:44“. */
function clock(seconds: number | null | undefined): string | null {
  if (!seconds || seconds < 0) return null;
  const parts = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), Math.floor(seconds % 60)];
  return (parts[0] ? [parts[0], String(parts[1]).padStart(2, "0")] : [parts[1]]).concat(String(parts[2]).padStart(2, "0")).join(":");
}
/**
 * Ikony kreslíme, ne píšeme: textové glyfy jako ⌕ nebo ＋ mají na každé platformě jinou šířku i optickou váhu.
 * Jeden tvar, jedna tloušťka tahu, velikost dědí z fontu rodiče.
 */
const GLYPHS: Record<string, React.ReactNode> = {
  mark: <><rect x="2.5" y="4.6" width="19" height="2.9" rx="1.45" fill="currentColor" stroke="none" /><rect x="5.5" y="10.5" width="13" height="2.9" rx="1.45" fill="currentColor" stroke="none" opacity=".72" /><rect x="8.5" y="16.4" width="7" height="2.9" rx="1.45" className="mark-drop" stroke="none" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.2" /><path d="M15.2 15.2 20.5 20.5" /></>,
  plus: <path d="M12 5.2v13.6M5.2 12h13.6" />,
  settings: <><path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h12M20 17h0" /><circle cx="16" cy="7" r="2.1" /><circle cx="8" cy="12" r="2.1" /><circle cx="18" cy="17" r="2.1" /></>,
  back: <path d="M19 12H5.6M11 5.6 4.6 12l6.4 6.4" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  heart: <path d="M12 20.2s-7.6-4.6-7.6-9.6A4.3 4.3 0 0 1 12 8.2a4.3 4.3 0 0 1 7.6 2.4c0 5-7.6 9.6-7.6 9.6z" />,
  more: <><circle cx="5.4" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="18.6" cy="12" r="1.5" fill="currentColor" stroke="none" /></>,
  sort: <path d="M7 4.5v15M7 19.5 3.6 16M17 19.5v-15M17 4.5 20.4 8" />,
  undo: <path d="M4.6 9.5h10.2a4.7 4.7 0 0 1 0 9.4H8M4.6 9.5 8.6 5.5M4.6 9.5l4 4" />,
  play: <path d="M7.4 4.8 19.6 12 7.4 19.2z" fill="currentColor" stroke="none" />,
  home: <path d="M3.8 10.7 12 4.2l8.2 6.5V20H3.8zM9.6 20v-5.6h4.8V20" />,
  news: <><rect x="3.2" y="5.6" width="17.6" height="12.8" rx="2.1" /><path d="M6.6 9.4h6.2M6.6 12.4h6.2M6.6 15.3h4M16 9.4h1.6M16 12.4h1.6M16 15.3h1.6" /></>,
  tech: <><rect x="7.2" y="7.2" width="9.6" height="9.6" rx="2" /><path d="M12 3.4v3.8M12 16.8v3.8M3.4 12h3.8M16.8 12h3.8M8.6 3.9v3.3M15.4 3.9v3.3M8.6 16.8v3.3M15.4 16.8v3.3" /></>,
  podcast: <><rect x="9.3" y="3.2" width="5.4" height="9.8" rx="2.7" /><path d="M5.9 11.2a6.1 6.1 0 0 0 12.2 0M12 17.3v3.3M8.8 20.6h6.4" /></>,
  video: <><rect x="3.2" y="5.2" width="17.6" height="13.6" rx="2.8" /><path d="M10.6 9.6 15.6 12l-5 2.4z" fill="currentColor" /></>,
  science: <><path d="M9.4 3.6h5.2M10.2 3.6v5L5.9 16.9a2.1 2.1 0 0 0 1.8 3.2h8.6a2.1 2.1 0 0 0 1.8-3.2L13.8 8.6v-5" /><path d="M7.9 14.4h8.2" /></>,
  work: <><rect x="3.2" y="7.4" width="17.6" height="11.2" rx="2.2" /><path d="M9.2 7.4V5.8a1.7 1.7 0 0 1 1.7-1.7h2.2a1.7 1.7 0 0 1 1.7 1.7v1.6M3.2 12.4h17.6" /></>,
  star: <path d="m12 4.3 2.5 5 5.5.8-4 3.9.95 5.5L12 16.9l-4.95 2.6.95-5.5-4-3.9 5.5-.8z" />,
  world: <><circle cx="12" cy="12" r="8.2" /><path d="M3.8 12h16.4M12 3.8c2.2 2.3 3.4 5.1 3.4 8.2s-1.2 5.9-3.4 8.2c-2.2-2.3-3.4-5.1-3.4-8.2s1.2-5.9 3.4-8.2z" /></>,
};
function Icon({ name, filled }: { name: keyof typeof GLYPHS; filled?: boolean }) {
  return <svg className="icon-svg" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false"
    fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{GLYPHS[name]}</svg>;
}

const PAGE = 15;
const CACHE_KEY = "siftera:bootstrap";
const PAGE_KEY = "siftera:shown";
/**
 * Odchod na originál načte aplikaci znovu, takže návrat by jinak čekal na bootstrap. Poslední odpověď proto
 * držíme v sessionStorage a při startu ji hned vykreslíme, zatímco na pozadí doběhne čerstvá.
 * sessionStorage, ne localStorage: obsahuje osobní feed a má zmizet se zavřením karty.
 */
function readCache(): Bootstrap | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Bootstrap) : null;
  } catch { return null; }
}
function writeCache(data: Bootstrap): void {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* plná kvóta nebo soukromý režim */ }
}
function useHidingHeader(): boolean {
  const [shown, setShown] = useState(true);
  const last = useRef(0);
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      const delta = y - last.current;
      if (Math.abs(delta) > 6) {
        setShown(delta < 0 || y < 80);
        last.current = y;
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return shown;
}
type Resume = { tab: Tab; scrollY: number; filter: FeedFilter };
const DEFAULT_FILTER: FeedFilter = { channel: "home", mode: "feed", sort: "smart", sourceId: null };
/** Obnovený filtr je uživatelský vstup ze sessionStorage: může být z jiné verze aplikace, takže se čte obezřetně. */
function sameFilter(value: unknown): FeedFilter {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Partial<FeedFilter>;
  return {
    channel: typeof raw.channel === "string" ? raw.channel : DEFAULT_FILTER.channel,
    mode: raw.mode === "all" ? "all" : "feed",
    sort: raw.sort === "newest" ? "newest" : "smart",
    sourceId: typeof raw.sourceId === "string" ? raw.sourceId : null,
  };
}
/** Přehled drží vše, kategorie nesou vlastní ikonu, Uložené uzavírají řadu (ADR-021). */
const HOME_CHANNEL: Channel = { id: "home", label: "Přehled", icon: "home", category: null, special: "home" };
function channelsOf(categories: FeedCategory[]): Channel[] {
  return [
    HOME_CHANNEL,
    ...categories.map((entry) => ({ id: entry.id, label: entry.label, icon: (entry.icon ?? "star") as keyof typeof GLYPHS, category: entry })),
    { id: "saved", label: "Uložené", icon: "heart", category: null, special: "saved" as const },
  ];
}
const basisLabel: Record<string, string> = { full_text: "celý dostupný text", excerpt: "výňatek od zdroje", metadata: "pouze metadata" };
const presentationLabel: Record<string, string> = { article: "Článek", long_read: "Delší čtení", distilled_fact: "Ověřený fakt", school_notice: "Školní oznámení", video: "Video", audio: "Audio", discovery: "Objev", learning: "K naučení", recommendation: "Doporučení", short_fun: "Pro pobavení" };

export default function App() {
  const [tab, setTab] = useState<Tab>("feed");
  const cached = useRef(readCache());
  const [data, setData] = useState<Bootstrap | null>(cached.current);
  const [loading, setLoading] = useState(cached.current === null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [panel, setPanel] = useState(false);
  const [restore, setRestore] = useState<number | null>(null);
  const [filter, setFilter] = useState<FeedFilter>(DEFAULT_FILTER);
  const headerShown = useHidingHeader();
  const bootstrapRef = useRef<Bootstrap | null>(null);
  const [shared, setShared] = useState<SharedInput | null>(() => {
    const params = new URLSearchParams(location.search);
    const value = { url: params.get("url") ?? "", title: params.get("title") ?? "", text: params.get("text") ?? "" };
    return value.url || value.title || value.text ? value : null;
  });
  const reload = async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const next = await api.bootstrap();
      setData(next);
      // Cache platí jen pro tutéž identitu; jiný účet nesmí ani na okamžik vidět předchozí feed.
      writeCache(next);
    } catch (reason) { setError(message(reason)); } finally { if (!silent) setLoading(false); }
  };
  useEffect(() => { void reload(cached.current !== null); }, []);
  useEffect(() => {
    // Když návrat obslouží bfcache, prohlížeč obnoví pozici sám a náš záznam by později skočil nečekaně.
    const onShow = (event: PageTransitionEvent) => { if (event.persisted) try { sessionStorage.removeItem(RESUME_KEY); } catch { /* ignore */ } };
    window.addEventListener("pageshow", onShow);
    try {
      const saved = sessionStorage.getItem(RESUME_KEY);
      if (saved) {
        sessionStorage.removeItem(RESUME_KEY);
        const resume = JSON.parse(saved) as Resume;
        setTab(resume.tab);
        if (resume.filter) setFilter(sameFilter(resume.filter));
        setRestore(resume.scrollY);
      }
    } catch { /* soukromý režim nebo poškozený záznam */ }
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  // Doskrolovat lze až na vykreslený feed, tedy po dokončeném bootstrapu.
  useEffect(() => {
    if (restore === null || !data) return;
    const frame = requestAnimationFrame(() => { window.scrollTo(0, restore); setRestore(null); });
    return () => cancelAnimationFrame(frame);
  }, [restore, data]);
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
        return { content: [{ type: "text", text: JSON.stringify({ signedIn: Boolean(current?.user), loaded: { feed: current?.feed.items.length ?? 0, library: current?.library.length ?? 0, inbox: current?.inbox?.length ?? 0, sources: current?.sources.length ?? 0 }, lastPublishedAt: current?.feed.run?.publishedAt ?? null }) }] };
      },
    }, { signal: controller.signal });
    return () => controller.abort();
  }, []);
  const all = useMemo(() => data ? [...data.feed.items, ...data.library] : [], [data]);
  const results = useMemo(() => { const needle = folded(query); const items = [...new Map(all.map((item) => [item.item.id, item])).values()]; return needle ? items.filter((item) => folded(`${item.item.headline} ${item.item.summary} ${item.item.topics.join(" ")} ${item.item.provenance[0]?.sourceName ?? ""}`).includes(needle)) : []; }, [all, query]);
  const changeState = async (item: FeedItem, patch: { read?: boolean; saved?: boolean; hidden?: boolean }) => { try { await api.setItemState(item.state.candidateId, item.state.version, patch); await reload(true); } catch (reason) { setNotice(message(reason)); } };
  const hideCandidate = async (entry: InboxEntry, hidden = true) => { try { await api.setItemState(entry.candidate.id, entry.state.version, { hidden }); await reload(true); } catch (reason) { setNotice(message(reason)); } };
  /**
   * Originál se otevírá ve stejné kartě, v PWA i v prohlížeči: uživatel se vrací tlačítkem zpět, nezavírá karty.
   * Pozici ve feedu si proto ukládáme sami — bez toho by se SPA po návratu načetla odshora.
   */
  const openOriginal = (feed: FeedItem) => {
    const url = feed.item.provenance[0]?.canonicalUrl;
    if (!url) return;
    if (!feed.state.read) void changeState(feed, { read: true });
    try { sessionStorage.setItem(RESUME_KEY, JSON.stringify({ tab, scrollY: window.scrollY, filter } satisfies Resume)); } catch { /* soukromý režim */ }
    window.location.href = url;
  };
  const modes = useMemo(() => new Map((data?.sources ?? []).map((entry) => [entry.id, entry.imageMode ?? "auto"] as const)), [data]);
  const names = useMemo(() => new Map((data?.sources ?? []).map((entry) => [entry.id, entry.name] as const)), [data]);
  const acceptShare = async () => { if (!shared) return; try { await api.addArticle(shared); setShared(null); history.replaceState({}, "", location.pathname); setNotice("Odkaz čeká v inboxu na zpracování."); await reload(); } catch (reason) { setNotice(message(reason)); } };
  return <div className="app"><header className={headerShown ? "" : "away"}>
    <div className="bar">
      {searching
        ? <><label className="search"><Icon name="search" /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat v načtených položkách" aria-label="Hledat v načtených položkách" /></label><button className="add-item" onClick={() => { setSearching(false); setQuery(""); }} aria-label="Zavřít hledání"><Icon name="close" /></button></>
        : <><button className="brand" onClick={() => { setTab("feed"); window.scrollTo(0, 0); }}><Icon name="mark" /><span className="word">Siftera</span></button><span className="spacer" />
          <button className="add-item" onClick={() => setSearching(true)} aria-label="Hledat"><Icon name="search" /></button>
          <button className="add-item" onClick={() => setTab("add")} aria-label="Přidat odkaz nebo text"><Icon name="plus" /></button>
          <button className={`add-item ${tab === "feed" ? "" : "on"}`} onClick={() => setTab(tab === "feed" ? "settings" : "feed")} aria-label={tab === "feed" ? "Nastavení" : "Zpět na feed"}><Icon name={tab === "feed" ? "settings" : "back"} /></button></>}
    </div>
    {tab === "feed" && !query && <>
      <ChannelBar channels={channelsOf(data?.preferences.categories ?? [])} filter={filter} setFilter={setFilter} />
      <ModeBar filter={filter} setFilter={setFilter} panel={panel} setPanel={setPanel} />
    </>}
  </header><main>
    {shared && <ShareBox value={shared} update={setShared} accept={() => void acceptShare()} dismiss={() => { setShared(null); history.replaceState({}, "", location.pathname); }} />}
    {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice(null)} aria-label="Zavřít">×</button></div>}
    {error && <div className="error" role="alert">{error}{error.includes("token") ? <button onClick={() => setTab("settings")}>Otevřít nastavení</button> : <button onClick={() => void reload()}>Načíst znovu</button>}</div>}
    {query ? <Page title={`„${query}“`} eyebrow="HLEDÁNÍ V NAČTENÝCH DATECH"><p className="hint">Prohledává se aktuálně načtený výběr a knihovna. Starší archiv se nepředstírá.</p><Cards items={results} onState={changeState} onOpen={openOriginal} modes={modes} names={names} empty={<Empty title="Nic jsme nenašli." detail="Hledá se jen ve vydaném výběru a knihovně, ne v čekajících položkách Inboxu." />} /></Page> : <Content tab={tab} data={data} loading={loading} setTab={setTab} reload={reload} notice={setNotice} onState={changeState} onHide={hideCandidate} onOpen={openOriginal} modes={modes} names={names} filter={filter} setFilter={setFilter} panel={panel} setPanel={setPanel} />}
  </main></div>;
}

function Content({ tab, data, loading, setTab, reload, notice, onState, onHide, onOpen, modes, names, filter, setFilter, panel, setPanel }: { tab: Tab; data: Bootstrap | null; loading: boolean; setTab: (tab: Tab) => void; reload: () => Promise<void>; notice: (text: string) => void; onState: (item: FeedItem, patch: { read?: boolean; saved?: boolean; hidden?: boolean }) => Promise<void>; onHide: (entry: InboxEntry, hidden: boolean) => Promise<void>; onOpen: (feed: FeedItem) => void; modes: Map<string, ImageMode>; names: Map<string, string>; filter: FeedFilter; setFilter: (filter: FeedFilter) => void; panel: boolean; setPanel: (open: boolean) => void }) {
  if (loading) return <Loading />;
  if (tab === "feed") return <FeedView data={data} setTab={setTab} onState={onState} onHide={onHide} onOpen={onOpen} modes={modes} names={names} filter={filter} setFilter={setFilter} panel={panel} setPanel={setPanel} />;
  if (tab === "add") return <AddItem reload={reload} notice={notice} setTab={setTab} />;
  if (tab === "sources") return <Sources data={data} reload={reload} notice={notice} />;
  if (tab === "editor") return <EditorPanel notice={notice} reload={reload} />;
  return <Settings preferences={data?.preferences ?? null} sources={data?.sources ?? []} notice={notice} setTab={setTab} reload={reload} />;
}

/**
 * Kanály jsou ikonky v hlavičce, protože jich bude přibývat (do budoucna i pracovní přehledy) a text by
 * se na mobilu nevešel. Vodorovně se roluje, aktivní kanál drží plnou barvu a jmenovku.
 */
function ChannelBar({ channels, filter, setFilter }: { channels: Channel[]; filter: FeedFilter; setFilter: (filter: FeedFilter) => void }) {
  const active = channels.some((entry) => entry.id === filter.channel) ? filter.channel : "home";
  return <div className="channels" role="tablist" aria-label="Kanály">
    {channels.map((entry) => <button key={entry.id} role="tab" aria-selected={active === entry.id} className={active === entry.id ? "on" : ""}
      onClick={() => { setFilter({ ...filter, channel: entry.id, sourceId: null }); window.scrollTo(0, 0); }}>
      <span className="glyph"><Icon name={entry.icon} filled={entry.id === "saved" && active === "saved"} /></span>
      <small>{entry.label}</small>
    </button>)}
  </div>;
}

/** Režim patří dovnitř kanálu: v každém se dá brouzdat nepřečteným (Feed) i celým archivem (Vše). */
function ModeBar({ filter, setFilter, panel, setPanel }: { filter: FeedFilter; setFilter: (filter: FeedFilter) => void; panel: boolean; setPanel: (open: boolean) => void }) {
  const tuned = filter.sort !== "smart" || filter.sourceId !== null;
  const saved = filter.channel === "saved";
  const modes: Array<[FeedMode, string]> = [["feed", "Feed"], ["all", "Vše"]];
  return <div className="modes">
    {saved
      ? <span className="mode-note">Vše, co jste si uložili</span>
      : modes.map(([mode, label]) => <button key={mode} aria-pressed={filter.mode === mode} className={filter.mode === mode ? "on" : ""} onClick={() => setFilter({ ...filter, mode })}>{label}</button>)}
    <span className="spacer" />
    <button className={`filter ${tuned ? "on" : ""}`} onClick={() => setPanel(!panel)} aria-expanded={panel} aria-label="Řazení a filtry"><Icon name="sort" /></button>
  </div>;
}

/** Kategorie je uživatelský filtr nad tématy a zdroji (ADR-016), ne škatulka od editora. */
function matchesCategory(item: FeedItem, category: FeedCategory): boolean {
  if (category.topics.some((topic) => item.item.topics.includes(topic))) return true;
  return category.sourceIds.some((sourceId) => item.item.provenance.some((entry) => entry.sourceId === sourceId));
}
/**
 * Položka, kterou uživatel právě přečetl, ze serverového proudu vypadne. Ve feedu ale musí zůstat na svém
 * místě a jen zešednout — jinak se pod rukama přeskládá okolí a čtenář ztratí kontext (UX: filtr se znovu
 * uplatní až při explicitním obnovení). Proto se drží dřívější pořadí a chybějící se do něj vrací.
 */
function keepOrder(previous: string[], current: string[]): string[] {
  if (!previous.length) return current;
  const fresh = new Set(current);
  const order = [...current];
  previous.forEach((id, index) => {
    if (fresh.has(id)) return;
    order.splice(Math.min(index, order.length), 0, id);
  });
  return order;
}
function stamp(item: FeedItem): number {
  const at = item.item.provenance[0]?.publishedAt ?? item.item.createdAt;
  const value = new Date(at).getTime();
  return Number.isFinite(value) ? value : 0;
}

function usePending(active: boolean, reloadKey: number) {
  const [pending, setPending] = useState<{ inbox: InboxEntry[]; hidden: InboxEntry[] } | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void api.pending().then((value) => { if (live) setPending(value); }).catch(() => { if (live) setPending({ inbox: [], hidden: [] }); });
    return () => { live = false; };
  }, [active, reloadKey]);
  return pending;
}

function FeedView({ data, setTab, onState, onHide, onOpen, modes, names, filter, setFilter, panel, setPanel }: { data: Bootstrap | null; setTab: (tab: Tab) => void; onState: (item: FeedItem, patch: { read?: boolean; saved?: boolean; hidden?: boolean }) => Promise<void>; onHide: (entry: InboxEntry, hidden: boolean) => Promise<void>; onOpen: (feed: FeedItem) => void; modes: Map<string, ImageMode>; names: Map<string, string>; filter: FeedFilter; setFilter: (filter: FeedFilter) => void; panel: boolean; setPanel: (open: boolean) => void }) {
  const categories = data?.preferences.categories ?? [];
  const channels = useMemo(() => channelsOf(categories), [categories]);
  const channel = channels.find((entry) => entry.id === filter.channel) ?? HOME_CHANNEL;
  const category = channel.category;
  const saved = channel.special === "saved";
  // Zdroje k filtrování drží kanál: v kategorii jen její, v Přehledu všechny.
  const sources = useMemo(() => {
    const all = data?.sources ?? [];
    return category && category.sourceIds.length ? all.filter((entry) => category.sourceIds.includes(entry.id)) : all;
  }, [data, category]);
  // Přepnutí pohledu je nový seznam; do té doby si feed drží pořadí, aby pod rukama nemizely položky.
  const viewKey = `${channel.id}|${saved ? "saved" : filter.mode}|${filter.sort}|${filter.sourceId ?? ""}`;
  const held = useRef<{ key: string; ids: string[] }>({ key: viewKey, ids: [] });
  if (held.current.key !== viewKey) held.current = { key: viewKey, ids: [] };
  const items = useMemo(() => {
    const base = saved ? (data?.library ?? []).filter((entry) => entry.state.saved)
      : filter.mode === "feed" ? data?.stream ?? []
      : data?.library ?? [];
    const inChannel = category ? base.filter((item) => matchesCategory(item, category)) : base;
    const filtered = filter.sourceId ? inChannel.filter((item) => item.item.provenance.some((entry) => entry.sourceId === filter.sourceId)) : inChannel;
    const current = filter.sort === "newest" ? [...filtered].sort((left, right) => stamp(right) - stamp(left)) : filtered;
    const known = new Map((data?.library ?? []).concat(data?.stream ?? []).map((entry) => [entry.item.id, entry]));
    const order = keepOrder(held.current.ids, current.map((entry) => entry.item.id));
    const resolved = order.map((id) => known.get(id)).filter((entry): entry is FeedItem => Boolean(entry));
    held.current = { key: viewKey, ids: resolved.map((entry) => entry.item.id) };
    return resolved;
  }, [data, filter, category, saved, viewKey]);
  // Prázdný kanál má dvě různé příčiny: buď je přečtený, nebo do něj ještě nic nedorazilo. Rozlišuje se počtem přes celý archiv.
  const stocked = useMemo(() => {
    if (!category) return true;
    return (data?.library ?? []).concat(data?.stream ?? []).some((item) => matchesCategory(item, category));
  }, [data, category]);
  // Nezpracované položky patří do Přehledu / Vše: nikam jinam se ještě zařadit nedaly.
  const rawVisible = !saved && !category && filter.mode === "all";
  const fetched = usePending(rawVisible, data?.preferences.version ?? 0);
  const waiting = rawVisible ? fetched?.inbox ?? [] : [];
  return <section>
    {panel && <FilterPanel sources={sources} filter={filter} setFilter={setFilter} close={() => setPanel(false)} setTab={setTab} channel={channel} />}
    <ChannelNote channel={channel} filter={filter} setFilter={setFilter} names={names} count={items.length} data={data} />
    <Cards items={items} onState={onState} onOpen={onOpen} modes={modes} names={names}
      tail={waiting.map((entry) => <PendingCard key={entry.candidate.id} entry={entry} source={entry.candidate.sourceId === "manual" ? "Ručně vloženo" : sourceLabel(entry.candidate.sourceId, undefined, names)} onHide={onHide} imageMode={modes.get(entry.candidate.sourceId) ?? "auto"} />)}
      empty={saved
        ? <Empty title="Nemáte nic uloženého." detail="Srdíčkem u karty si odložíte položku na později." />
        : filter.mode === "all"
          ? <Empty title="Nic tu není." detail={category ? `Z kanálu ${channel.label} zatím nic neprošlo redakcí. Zkontrolujte, které zdroje do něj patří.` : "V režimu Vše najdeš i položky, které redakcí neprošly."} {...(category ? { action: { label: "Upravit kanály", onClick: () => setTab("settings") } } : {})} />
          : category
            ? stocked
              ? <Empty title="Máte přečteno." detail={`V kanálu ${channel.label} není nic nepřečteného. Přepněte na Vše, ať vidíte i starší.`} action={{ label: "Zobrazit vše", onClick: () => setFilter({ ...filter, mode: "all" }) }} />
              : <Empty title={`V kanálu ${channel.label} ještě nic není.`} detail="Položky ze zdrojů kanálu čekají na redakční zpracování — po dalším běhu AI editoru se tu objeví." action={{ label: "Otevřít AI editor", onClick: () => setTab("editor") }} />
            : <NothingYet data={data} setTab={setTab} title="Zatím tu nic nečeká." published="Proud drží nepřečtené položky z posledních 14 dní. Nové sestaví AI editor z čekajících." />} />
  </section>;
}

/** „1 položka", „3 položky", „0 položek" — nula se v češtině chová jako množné číslo. */
const itemsLabel = (count: number) => `${count} ${count === 1 ? "položka" : count > 1 && count < 5 ? "položky" : "položek"}`;
/** Jeden řádek pod hlavičkou říká, co je na obrazovce a jak z toho vystoupit — bez novinové hlavy. */
function ChannelNote({ channel, filter, setFilter, names, count, data }: { channel: Channel; filter: FeedFilter; setFilter: (filter: FeedFilter) => void; names: Map<string, string>; count: number; data: Bootstrap | null }) {
  if (filter.sourceId) return <p className="stream-note">{names.get(filter.sourceId) ?? "Zdroj"} · {itemsLabel(count)} · <button className="linky" onClick={() => setFilter({ ...filter, sourceId: null })}>zrušit filtr</button></p>;
  if (channel.category) return <p className="stream-note">{channel.label} · {filter.mode === "feed" ? "nepřečtené" : "vše"} · {itemsLabel(count)}</p>;
  if (channel.special === "saved" || filter.mode === "all") return null;
  return streamNote(data) ? <p className="stream-note">{streamNote(data)}</p> : null;
}

function FilterPanel({ sources, filter, setFilter, close, setTab, channel }: { sources: PrototypeSource[]; filter: FeedFilter; setFilter: (filter: FeedFilter) => void; close: () => void; setTab: (tab: Tab) => void; channel: Channel }) {
  return <div className="panel">
    <div className="panel-row"><span>Řadit</span><div className="seg">
      <button className={filter.sort === "smart" ? "on" : ""} onClick={() => setFilter({ ...filter, sort: "smart" })}>Podle výběru</button>
      <button className={filter.sort === "newest" ? "on" : ""} onClick={() => setFilter({ ...filter, sort: "newest" })}>Od nejnovějších</button>
    </div></div>
    <div className="panel-row"><span>Zdroj{channel.category ? ` v kanálu ${channel.label}` : ""}</span></div>
    <div className="chips">
      <button className={!filter.sourceId ? "chip on" : "chip"} onClick={() => setFilter({ ...filter, sourceId: null })}>Všechny</button>
      {sources.map((entry) => <button key={entry.id} className={filter.sourceId === entry.id ? "chip on" : "chip"} onClick={() => { setFilter({ ...filter, sourceId: entry.id }); close(); }}>{entry.name}</button>)}
    </div>
    <div className="panel-row"><span /><button className="linky" onClick={() => { close(); setTab("settings"); }}>Upravit kanály</button></div>
  </div>;
}

/** Prázdný výběr znamená pokaždé jiný další krok: přidat zdroj, obnovit ho, nebo spustit AI editor. */
function NothingYet({ data, setTab, title, published }: { data: Bootstrap | null; setTab: (tab: Tab) => void; title: string; published: string }) {
  const waiting = data?.stream.length ?? 0;
  if (waiting) return <Empty title={`${waitingLabel(waiting)}.`} detail={published} action={{ label: "Otevřít AI editor", onClick: () => setTab("editor") }} />;
  if (!data?.sources.length) return <Empty title="Zatím nemáte žádný zdroj." detail="Přidejte RSS/Atom zdroj nebo vložte odkaz do Inboxu. Siftera nenačítá nic sama od sebe." action={{ label: "Přidat zdroj", onClick: () => setTab("sources") }} />;
  return <Empty title={title} detail="Obnovení zdrojů je v prototypu ruční. Spusťte ho u konkrétního zdroje." action={{ label: "Otevřít zdroje", onClick: () => setTab("sources") }} />;
}

/** Proud je „co jsi ještě nečetl“, ne vydání; poznámka to má říct bez novinové hlavy. */
function streamNote(data: Bootstrap | null): string | null {
  const count = data?.stream.length ?? 0;
  if (!data) return null;
  if (!count) return null;
  return count === 1 ? "1 položka, kterou jsi ještě nečetl" : count < 5 ? `${count} položky, které jsi ještě nečetl` : `${count} položek, které jsi ještě nečetl`;
}
function Page({ title, eyebrow, children }: { title: string; eyebrow: string; children: React.ReactNode }) { return <section><div className="heading"><p>{eyebrow}</p><h1>{title}</h1></div>{children}</section>; }
function Loading() { return <div className="cards" aria-busy="true"><div className="skeleton"/><div className="skeleton"/><div className="skeleton"/></div>; }

function Cards({ items, onState, onOpen, modes, names, empty, tail = [] }: { items: FeedItem[]; onState: (item: FeedItem, patch: { read?: boolean; saved?: boolean; hidden?: boolean }) => Promise<void>; onOpen: (feed: FeedItem) => void; modes: Map<string, ImageMode>; names: Map<string, string>; empty: React.ReactNode; tail?: React.ReactNode[] }) {
  const watch = useSeen();
  // Který přehrávač je živý, ví proud: spuštěním dalšího videa první zmizí, takže nikdy nehrají dvě naráz.
  const [playing, setPlaying] = useState<string | null>(null);
  const visible = items.filter((item) => !item.state.hidden);
  const total = visible.length + tail.length;
  const [shown, setShown] = useState(() => {
    try { return Math.max(PAGE, Number.parseInt(sessionStorage.getItem(PAGE_KEY) ?? "", 10) || PAGE); } catch { return PAGE; }
  });
  useEffect(() => { try { sessionStorage.setItem(PAGE_KEY, String(shown)); } catch { /* soukromý režim */ } }, [shown]);
  const more = useRef<HTMLDivElement | null>(null);
  // Sentinel musí být poslední prvek proudu, jinak ho rychlý scroll přeskočí; proto se dočítá i doplněk.
  useEffect(() => {
    const target = more.current;
    if (!target || shown >= total) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setShown((count) => count + PAGE);
    }, { rootMargin: "600px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [shown, total]);
  useEffect(() => { setShown((count) => Math.min(count, Math.max(PAGE, total))); }, [items, tail.length, total]);
  if (!total) return <>{empty}</>;
  return <><div className="cards">
    {visible.slice(0, shown).map((feed) => <Card key={feed.item.id} feed={feed} onState={onState} onOpen={onOpen} imageMode={modes.get(feed.item.provenance[0]?.sourceId ?? "") ?? "auto"} watch={watch} names={names}
      playing={playing === feed.item.id} onPlay={() => setPlaying(feed.item.id)} />)}
    {shown > visible.length && tail.slice(0, shown - visible.length)}
  </div>
    {shown < total && <div ref={more} className="loading-more">Načítám další…</div>}</>;
}

function Empty({ title, detail, action }: { title: string; detail: string; action?: { label: string; onClick: () => void } }) { return <div className="empty"><span>⌁</span><h2>{title}</h2><p>{detail}</p>{action && <button className="primary" onClick={action.onClick}>{action.label}</button>}</div>; }
/**
 * Důraz karty: co řekl editor, jinak odvozeno z prezentace a hodnocení. Zdroj má poslední slovo nad obrazem,
 * protože některé weby posílají jen loga nebo drobné náhledy, kde velký obraz nic nepřidává.
 */
type Layout = "lead" | "standard" | "compact" | "text";
function layoutOf(item: EditorialItem, imageMode: ImageMode): Layout {
  const declared = item.emphasis;
  const base: Layout = declared ?? (
    item.presentation === "distilled_fact" || item.presentation === "school_notice" ? "text"
    : item.presentation === "long_read" ? "lead"
    : item.presentation === "short_fun" || item.presentation === "recommendation" ? "compact"
    : (item.assessment?.relevance ?? 0) >= 75 ? "lead"
    : "standard");
  if (!item.image || imageMode === "none" || (item.imageTreatment === "hide" && imageMode === "auto")) return "text";
  if (imageMode === "small" && base === "lead") return "standard";
  if (imageMode === "large" && base === "compact") return "standard";
  return base;
}

/**
 * Sleduje, co měl uživatel skutečně před očima (ADR-015): karta se počítá za viděnou, když byla aspoň
 * z poloviny ve viewportu déle než vteřinu. Hlásí se dávkově, ne po jedné, a jen jednou za relaci —
 * je to slabý signál pro pořadí, ne uživatelova volba, takže nikdy nesmí přebít read/saved/hidden.
 */
function useSeen(): (element: Element | null, candidateId: string) => void {
  const pending = useRef(new Set<string>());
  const sent = useRef(new Set<string>());
  const timers = useRef(new Map<Element, number>());
  const flush = useRef<number | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  const ids = useRef(new WeakMap<Element, string>());

  useEffect(() => {
    const send = () => {
      flush.current = null;
      const batch = [...pending.current];
      pending.current.clear();
      if (batch.length) void api.markSeen(batch).catch(() => { /* pořadí smí zaostat, čtení se tím nerozbije */ });
    };
    observer.current = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = ids.current.get(entry.target);
        if (!id || sent.current.has(id)) continue;
        if (entry.isIntersecting) {
          if (timers.current.has(entry.target)) continue;
          timers.current.set(entry.target, window.setTimeout(() => {
            timers.current.delete(entry.target);
            sent.current.add(id);
            pending.current.add(id);
            flush.current ??= window.setTimeout(send, 4000);
          }, 1000));
        } else {
          const timer = timers.current.get(entry.target);
          if (timer !== undefined) { window.clearTimeout(timer); timers.current.delete(entry.target); }
        }
      }
    }, { threshold: 0.5 });
    // Odchod na originál i zavření karty musí stihnout odeslat, co se nasbíralo.
    const onHide = () => { if (document.visibilityState === "hidden") send(); };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      observer.current?.disconnect();
      for (const timer of timers.current.values()) window.clearTimeout(timer);
      timers.current.clear();
      if (flush.current !== null) window.clearTimeout(flush.current);
      send();
    };
  }, []);

  return (element, candidateId) => {
    if (!element || !observer.current || sent.current.has(candidateId)) return;
    ids.current.set(element, candidateId);
    observer.current.observe(element);
  };
}

/**
 * Klik na kartu vede na originál, ale až při čistém tapnutí: když prst mezitím popojel nebo se zdržel,
 * je to scroll, ne volba. Bez toho by se při rolování palcem odcházelo z aplikace omylem.
 */
function useTap(onTap: () => void) {
  const start = useRef<{ x: number; y: number; at: number } | null>(null);
  return {
    onPointerDown: (event: React.PointerEvent) => { start.current = { x: event.clientX, y: event.clientY, at: Date.now() }; },
    onPointerUp: (event: React.PointerEvent) => {
      const from = start.current;
      start.current = null;
      if (!from) return;
      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > 10) return;
      if (Date.now() - from.at > 500) return;
      if ((event.target as HTMLElement).closest("button, a, .lede, .why")) return;
      onTap();
    },
  };
}

function Card({ feed, onState, onOpen, imageMode, watch, names, playing, onPlay }: { feed: FeedItem; onState: (item: FeedItem, patch: { read?: boolean; saved?: boolean; hidden?: boolean }) => Promise<void>; onOpen: (feed: FeedItem) => void; imageMode: ImageMode; watch: (element: Element | null, candidateId: string) => void; names: Map<string, string>; playing: boolean; onPlay: () => void }) {
  const { item, state } = feed;
  const provenance = item.provenance[0];
  const [expanded, setExpanded] = useState(false);
  const [why, setWhy] = useState(false);
  const [menu, setMenu] = useState(false);
  const lede = useRef<HTMLParagraphElement | null>(null);
  const [clipped, setClipped] = useState(false);
  const readOnArrival = useRef(state.read);
  const [small, setSmall] = useState(item.image ? (item.image.width ?? measured.get(item.image.url) ?? 0) > 0 && (item.image.width ?? measured.get(item.image.url)!) < TOO_SMALL : false);
  const video = youtubeId(item);
  const base = layoutOf(item, imageMode);
  const layout: Layout = video ? (base === "text" ? "standard" : base === "compact" ? "standard" : base) : small && base !== "text" ? "compact" : base;
  const label = sourceLabel(provenance?.sourceId, provenance?.sourceName, names);
  const kind = item.presentation === "long_read" && item.readingMinutes ? `Stojí za přečtení · ${item.readingMinutes} min` : item.presentation === "article" ? null : presentationLabel[item.presentation] ?? null;
  const tap = useTap(() => onOpen(feed));
  // Rozbalení je způsob, jak si položku přečíst; proto se počítá stejně jako otevření originálu.
  const expand = () => { setExpanded(true); if (!state.read) void onState(feed, { read: true }); };
  useEffect(() => {
    const element = lede.current;
    if (!element || expanded) return;
    const measure = () => setClipped(element.scrollHeight - element.clientHeight > 4);
    measure();
    // Písmo dojde později a šířka se mění s otočením displeje; bez pozorovatele by odkaz zmizel nebo přebýval.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, item.summary]);
  // Spuštění videa je čtení stejně jako rozbalení textu; odchod na YouTube tím naopak přestává být nutný.
  const start = () => { onPlay(); if (!state.read) void onState(feed, { read: true }); };
  const shot = video
    ? <Player id={video} title={item.headline} image={item.image} playing={playing} start={start} seconds={item.media?.durationSeconds ?? null} />
    : layout !== "text" && item.image && imageMode !== "none"
      ? <Shot image={item.image} alt={item.headline} thumb={layout === "compact"} onSmall={() => setSmall(true)} />
      : null;
  // Odkaz „Zobrazit víc“ nesmí být uvnitř zkráceného odstavce: clamp ho odstřihne i s ním. Patří pod text,
  // a jen když se text opravdu nevejde — jinak by slibovalo pokračování, které neexistuje.
  const summary = <>
    <p ref={lede} className={expanded ? "lede" : "lede clamp"} onClick={() => { if (expanded) setExpanded(false); else expand(); }}>{item.summary}</p>
    {clipped && !expanded && <button className="showmore" onClick={(event) => { event.stopPropagation(); expand(); }}>Zobrazit víc</button>}
    {expanded && <button className="showmore" onClick={(event) => { event.stopPropagation(); setExpanded(false); }}>Zobrazit méně</button>}
  </>;
  const tags = item.topics.length > 0
    ? <div className="topics">{item.topics.slice(0, 5).map((topic) => <span key={topic}>{topic.replace(/-/g, " ")}</span>)}</div>
    : null;
  const heading = <h2><a href={provenance?.canonicalUrl ?? "#"} onClick={(event) => { event.preventDefault(); onOpen(feed); }}>{item.headline}</a></h2>;
  return <article className={`card ${layout} ${readOnArrival.current && state.read ? "dim" : ""} ${state.read ? "read" : ""} ${state.seenAt ? "seen" : ""}`} ref={(element) => watch(element, state.candidateId)} {...tap}>
    <div className="meta">
      <Avatar name={label} url={provenance?.canonicalUrl} />
      <b className="who">{label}</b>
      <span className="dot">·</span><span>{ago(provenance?.publishedAt ?? null)}</span>
      {feed.groups.includes("school") && <em className="badge">Škola</em>}
      {kind && <em className="badge kind">{kind}</em>}
      <span className="spacer" />
      <button className={`icon ${state.saved ? "selected" : ""}`} onClick={() => void onState(feed, { saved: !state.saved })} aria-label={state.saved ? "Odebrat z uložených" : "Uložit na později"} aria-pressed={state.saved}><Icon name="heart" filled={state.saved} /></button>
      <button className="icon" onClick={() => setMenu(!menu)} aria-label="Další možnosti" aria-expanded={menu}><Icon name="more" /></button>
    </div>
    {menu && <div className="menu">
      <button onClick={() => { setMenu(false); void onState(feed, { hidden: true }); }}>Skrýt z výběru</button>
      <button onClick={() => { setMenu(false); void onState(feed, { read: !state.read }); }}>{state.read ? "Označit jako nepřečtené" : "Označit jako přečtené"}</button>
      <button onClick={() => { setMenu(false); setWhy(!why); }}>{why ? "Skrýt podrobnosti" : "Proč to vidím"}</button>
    </div>}
    {layout === "compact"
      ? <div className="row"><div className="body">{heading}{summary}</div>{shot}</div>
      : <>{heading}{shot}{item.presentation === "distilled_fact" && item.distilledText ? <p className="fact">{item.distilledText}</p> : summary}</>}
    {tags}
    {why && <div className="why">
      {item.whyIncluded && <p>Proč to vidíte: {item.whyIncluded}</p>}
      <p>Shrnutí sestavil váš AI editor. Podklad: {basisLabel[item.assessment?.basis ?? "metadata"]}.</p>
    </div>}
  </article>;
}

function Avatar({ name, url }: { name: string; url: string | undefined }) {
  const [failed, setFailed] = useState(false);
  const origin = (() => { try { return url ? new URL(url).origin : null; } catch { return null; } })();
  if (origin && !failed) return <img className="avatar" src={`${origin}/favicon.ico`} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  const base = hue(name);
  return <span className="avatar mono" style={{ background: `hsl(${base} 45% 42%)` }} aria-hidden="true">{[...name].find((character) => /[\p{L}\p{N}]/u.test(character)) ?? "?"}</span>;
}

/** Deterministický odstín podle zdroje, aby položka bez obrázku držela rytmus feedu a stejný zdroj stejnou barvu. */
function hue(seed: string): number {
  let value = 0;
  for (const character of seed) value = (value * 31 + character.codePointAt(0)!) % 3600;
  return value / 10;
}
/** Skutečné rozměry známe až po načtení: feedy hlásí width jen zřídka a některé posílají náhledy 160px. */
const measured = new Map<string, number>();
const TOO_SMALL = 480;
function Shot({ image, alt, thumb, onSmall }: { image: EditorialItem["image"]; alt: string; thumb?: boolean; onSmall?: () => void }) {
  if (image) return <div className={thumb ? "shot thumb" : "shot"}><img
    src={image.url} alt={image.alt || alt} loading="lazy" decoding="async" referrerPolicy="no-referrer"
    onLoad={(event) => {
      const width = event.currentTarget.naturalWidth;
      if (!width) return;
      measured.set(image.url, width);
      if (width < TOO_SMALL) onSmall?.();
    }}
    onError={(event) => { event.currentTarget.closest(".shot")?.classList.add("failed"); }}
  /></div>;
  return null;
}

/**
 * Fasáda místo embedu: dokud uživatel nespustí přehrávání, nejde na YouTube ani jeden request. Po kliknutí
 * se vloží iframe na youtube-nocookie.com, takže sledování zůstává na volbě uživatele, ne na otevření feedu.
 */
function Player({ id, title, image, playing, start, seconds }: { id: string; title: string; image: EditorialItem["image"]; playing: boolean; start: () => void; seconds: number | null }) {
  const length = clock(seconds);
  if (playing) return <div className="shot player"><iframe
    src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1`}
    title={title} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen
    loading="lazy" referrerPolicy="strict-origin-when-cross-origin" /></div>;
  return <div className="shot player">
    <button className="face" onClick={start} aria-label={`Přehrát video: ${title}`}>
      {image && <img src={image.url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />}
      <span className="play" aria-hidden="true"><Icon name="play" /></span>
      {length && <span className="dur">{length}</span>}
    </button>
  </div>;
}

function AddItem({ reload, notice, setTab }: { reload: () => Promise<void>; notice: (text: string) => void; setTab: (tab: Tab) => void }) {
  const [input, setInput] = useState<SharedInput>({ url: "", title: "", text: "" });
  const [fullText, setFullText] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.addArticle({ ...input, fullText });
      setInput({ url: "", title: "", text: "" });
      setFullText(false);
      notice("Položka čeká v režimu Vše na redakční zpracování.");
      await reload();
      setTab("feed");
    } catch (reason) { notice(message(reason)); } finally { setBusy(false); }
  };
  return <Page title="Přidat" eyebrow="RUČNÍ PŘÍJEM"><p className="intro">Vložte odkaz nebo vlastní text. Nic se nevydává za AI výběr, dokud to neprojde vaším workflow.</p><form onSubmit={submit}><label>Odkaz<input type="url" value={input.url} onChange={(event) => setInput({ ...input, url: event.target.value })} placeholder="https://…" /></label><label>Název <em>volitelné</em><input value={input.title} onChange={(event) => setInput({ ...input, title: event.target.value })} /></label><label>Text <em>volitelné</em><textarea rows={6} value={input.text} onChange={(event) => { const text = event.target.value; setInput({ ...input, text }); if (!text) setFullText(false); }} /></label><label className="full-text"><input type="checkbox" checked={fullText} disabled={!input.text} onChange={(event) => setFullText(event.target.checked)} />Vkládám celý text článku</label><button className="primary" disabled={busy || (!input.url && !input.text)}>Přidat</button></form></Page>;
}
function PendingCard({ entry, source, onHide, imageMode }: { entry: InboxEntry; source: string; onHide: (entry: InboxEntry, hidden: boolean) => Promise<void>; imageMode: ImageMode }) {
  const { candidate, state } = entry;
  return <article className={`card waiting-card ${state.hidden ? "read" : ""}`}>
    <div className="meta"><span>{source}</span><span className="dot">·</span><span>{formatDate(candidate.publishedAt)}</span>{candidate.access !== "full" && <b>bez plného textu</b>}</div>
    {imageMode !== "none" && candidate.image && <Shot image={candidate.image} alt={candidate.title} thumb={imageMode === "small"} />}
    <div className="actions">
      <a className="quiet" href={candidate.canonicalUrl} target="_blank" rel="noopener noreferrer" aria-label="Otevřít originál">Otevřít originál ↗</a>
      <span className="spacer" />
      <button onClick={() => void onHide(entry, !state.hidden)} aria-label={state.hidden ? "Vrátit mezi čekající" : "Skrýt z inboxu"} aria-pressed={state.hidden}><Icon name={state.hidden ? "undo" : "close"} /></button>
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

/** UI na jiné doméně než API se přihlašuje tokenem vlastníka; jinak je API pro kohokoli otevřené. */
function TokenSetting({ notice, reload }: { notice: (text: string) => void; reload: () => Promise<void> }) {
  const [value, setValue] = useState(readToken());
  const saved = readToken();
  return <section className="prefs"><h2>Přístup k API</h2>
    <p className="hint">{saved ? "Token je uložený v tomto prohlížeči." : "Bez tokenu se data z API nenačtou."}</p>
    <label>Token<input type="password" value={value} onChange={(event) => setValue(event.target.value)} placeholder="vložte token vlastníka" autoComplete="off" /></label>
    <button className="primary" onClick={() => { writeToken(value.trim()); notice(value.trim() ? "Token uložen." : "Token odstraněn."); void reload(); }}>Uložit token</button>
  </section>;
}

function Settings({ preferences, sources, notice, setTab, reload }: { preferences: PreferenceProfile | null; sources: PrototypeSource[]; notice: (text: string) => void; setTab: (tab: Tab) => void; reload: () => Promise<void> }) { const [draft, setDraft] = useState<PreferenceProfile | null>(preferences); useEffect(() => setDraft(preferences), [preferences]); const save = async () => { if (!draft) return; try { await api.savePreferences(draft); notice("Preference jsou uložené."); await reload(); } catch (reason) { notice(message(reason)); } }; return <Page title="Nastavení" eyebrow="VÁŠ PROSTOR"><div className="settings"><button onClick={() => setTab("sources")}><span>☷</span><strong>Zdroje</strong><small>Přidat, obnovit nebo odebrat</small><b>›</b></button><button onClick={() => setTab("editor")}><span>✦</span><strong>AI editor</strong><small>Exportovat práci a importovat odpověď</small><b>›</b></button></div>{NEEDS_TOKEN && <TokenSetting notice={notice} reload={reload} />}<section className="prefs"><h2>Co chci číst</h2>{draft ? <><label>Popište svůj dlouhodobý výběr<textarea rows={6} value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /></label><label>Témata oddělte čárkou<input value={draft.preferredTopics.join(", ")} onChange={(event) => setDraft({ ...draft, preferredTopics: event.target.value.split(",").map((word) => word.trim()).filter(Boolean) })} /></label><button className="primary" onClick={() => void save()}>Uložit preference</button></> : <p>Preference se načítají z vašeho účtu.</p>}</section>{draft && <Categories preferences={draft} sources={sources} save={async (next) => { try { await api.savePreferences(next); notice("Kategorie jsou uložené."); await reload(); } catch (reason) { notice(message(reason)); } }} />}</Page>; }
/** Kategorie si skládá uživatel z témat a zdrojů, která ve svých datech vidí (ADR-016). */
/** Ikona kanálu je jen vizuální klíč; nabídka je uzavřená, aby lišta držela jeden výtvarný jazyk. */
const CHANNEL_ICONS: Array<[ChannelIcon, string]> = [["news", "Zprávy"], ["tech", "Technika"], ["podcast", "Podcast"], ["video", "Video"], ["science", "Věda"], ["world", "Svět"], ["work", "Práce"], ["star", "Ostatní"]];

function Categories({ preferences, sources, save }: { preferences: PreferenceProfile; sources: PrototypeSource[]; save: (next: PreferenceProfile) => Promise<void> }) {
  const [draft, setDraft] = useState<FeedCategory | null>(null);
  const list = preferences.categories ?? [];
  const start = () => setDraft({ id: crypto.randomUUID(), label: "", icon: "star", topics: [], sourceIds: [] });
  const commit = async () => {
    if (!draft || !draft.label.trim() || (!draft.topics.length && !draft.sourceIds.length)) return;
    const next = { ...preferences, categories: [...list.filter((entry) => entry.id !== draft.id), { ...draft, label: draft.label.trim() }] };
    setDraft(null);
    await save(next);
  };
  const remove = async (id: string) => { await save({ ...preferences, categories: list.filter((entry) => entry.id !== id) }); };
  return <section className="prefs">
    <h2>Kanály</h2>
    <p className="hint">Kanál je vlastní filtr feedu a ikonka v hlavičce: vyber zdroje, témata, nebo obojí.</p>
    <div className="chips">
      {list.map((entry) => <span key={entry.id} className="chip"><Icon name={(entry.icon ?? "star") as keyof typeof GLYPHS} /> {entry.label}<button className="linky" onClick={() => void remove(entry.id)} aria-label={`Smazat ${entry.label}`}> ✕</button></span>)}
      {!draft && <button className="chip add" onClick={start}>+ Nový</button>}
    </div>
    {draft && <div className="panel">
      <label>Název<input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="např. Technika" /></label>
      <div className="panel-row"><span>Ikona</span></div>
      <div className="chips">{CHANNEL_ICONS.map(([icon, label]) => <button key={icon} className={(draft.icon ?? "star") === icon ? "chip on" : "chip"} onClick={() => setDraft({ ...draft, icon })} aria-label={label} title={label}><Icon name={icon} /></button>)}</div>
      <div className="panel-row"><span>Zdroje</span></div>
      <div className="chips">{sources.map((source) => <button key={source.id} className={draft.sourceIds.includes(source.id) ? "chip on" : "chip"} onClick={() => setDraft({ ...draft, sourceIds: draft.sourceIds.includes(source.id) ? draft.sourceIds.filter((id) => id !== source.id) : [...draft.sourceIds, source.id] })}>{source.name}</button>)}</div>
      <label>Témata <em>oddělená čárkou</em><input value={draft.topics.join(", ")} onChange={(event) => setDraft({ ...draft, topics: event.target.value.split(",").map((word) => word.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")).filter(Boolean).slice(0, 20) })} placeholder="linux, ai, programovani" /></label>
      <div className="sheet-actions">
        <button onClick={() => setDraft(null)}>Zrušit</button>
        <button className="primary" onClick={() => void commit()} disabled={!draft.label.trim() || (!draft.topics.length && !draft.sourceIds.length)}>Uložit kanál</button>
      </div>
    </div>}
  </section>;
}


