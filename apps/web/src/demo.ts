/**
 * Statický režim pro GitHub Pages (ADR-018): UI čte veřejný sanitizovaný snapshot a všechny změny drží
 * jen v prohlížeči. Nic, co potřebuje backend — sběr z RSS a redakční export/import — se tu nepředstírá;
 * takové akce hlásí, že vyžadují lokální backend, místo aby tiše selhaly na CORS.
 */
import type { Candidate, EditorialSubmission, FeedItem, PreferenceProfile, UserItemState } from "@siftera/shared";
import { ApiError, type Bootstrap, type PrototypeSource, type RefreshResult } from "./api.js";

const STORE_KEY = "siftera:demo-state";
type Patch = Partial<Pick<UserItemState, "read" | "saved" | "hidden">> & { seenAt?: string };
type Local = { states: Record<string, Patch>; preferences: PreferenceProfile | null; added: Array<{ candidate: Candidate; state: UserItemState }> };

const empty: Local = { states: {}, preferences: null, added: [] };
function load(): Local {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? { ...empty, ...(JSON.parse(raw) as Local) } : { ...empty };
  } catch { return { ...empty }; }
}
function save(state: Local): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* soukromý režim nebo plná kvóta */ }
}
function backendOnly(action: string): never {
  throw new ApiError(501, `${action} běží jen proti vlastnímu backendu. Veřejná ukázka je statická a data se do ní doplňují lokálně.`);
}

let snapshot: Bootstrap | null = null;
async function fetchSnapshot(): Promise<Bootstrap> {
  if (snapshot) return snapshot;
  const response = await fetch(`${import.meta.env.BASE_URL}demo-feed.json`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new ApiError(response.status, "Ukázková data se nepodařilo načíst.");
  snapshot = (await response.json()) as Bootstrap;
  return snapshot;
}

/** Lokální změny se skládají na snapshot při každém načtení; snapshot samotný zůstává beze změny. */
function apply(base: Bootstrap, local: Local): Bootstrap {
  const merge = (item: FeedItem): FeedItem => {
    const patch = local.states[item.state.candidateId];
    return patch ? { ...item, state: { ...item.state, ...patch, version: item.state.version + 1 } } : item;
  };
  const stream = base.stream.map(merge).filter((item) => !item.state.read && !item.state.hidden);
  const library = (base.library ?? []).map(merge);
  const inbox = [...local.added, ...(base.inbox ?? [])].map((entry) => {
    const patch = local.states[entry.candidate.id];
    return patch ? { ...entry, state: { ...entry.state, ...patch } } : entry;
  });
  return {
    ...base,
    preferences: local.preferences ?? base.preferences,
    stream,
    library,
    inbox: inbox.filter((entry) => !entry.state.hidden),
    hidden: inbox.filter((entry) => entry.state.hidden),
  };
}

function patchState(candidateId: string, patch: Patch): UserItemState {
  const local = load();
  local.states[candidateId] = { ...local.states[candidateId], ...patch };
  save(local);
  return { candidateId, read: false, saved: false, hidden: false, seenAt: null, version: 1, updatedAt: new Date().toISOString(), ...local.states[candidateId] };
}

export const demoApi = {
  // Ukázka drží celý snapshot v jednom souboru, takže archiv jen přebere ze stejných dat.
  library: async () => {
    const merged = apply(await fetchSnapshot(), load());
    return { library: merged.library ?? [] };
  },
  pending: async () => {
    const base = await fetchSnapshot();
    const local = load();
    const merged = apply(base, local);
    return { inbox: merged.inbox ?? [], hidden: merged.hidden ?? [] };
  },
  bootstrap: async (): Promise<Bootstrap> => apply(await fetchSnapshot(), load()),
  addArticle: async (input: { url?: string; title?: string; text?: string; fullText?: boolean }) => {
    const now = new Date().toISOString();
    const url = input.url || "https://example.com/";
    const candidate = {
      id: crypto.randomUUID(), sourceId: "manual", sourceIds: ["manual"], revision: 1,
      url, canonicalUrl: url, title: input.title || url, author: null,
      publishedAt: now, discoveredAt: now, updatedAt: now,
      excerpt: (input.text ?? "").slice(0, 600), medium: "text" as const, categories: [],
      image: null, media: null, access: "unavailable" as const,
      contentHash: null, contentRef: null, externalId: null, expiresAt: null,
    } satisfies Candidate;
    const local = load();
    local.added = [{ candidate, state: { candidateId: candidate.id, read: false, saved: false, hidden: false, seenAt: null, version: 0, updatedAt: now } }, ...local.added].slice(0, 50);
    save(local);
    return { candidate };
  },
  markSeen: async (candidateIds: string[]) => {
    const at = new Date().toISOString();
    for (const id of candidateIds) patchState(id, { seenAt: at });
    return { marked: candidateIds.length };
  },
  setItemState: async (candidateId: string, _expectedVersion: number, patch: Patch) => patchState(candidateId, patch),
  savePreferences: async (preferences: PreferenceProfile) => {
    const local = load();
    local.preferences = { ...preferences, version: preferences.version + 1, updatedAt: new Date().toISOString() };
    save(local);
    return local.preferences;
  },
  addSource: async (_input: unknown): Promise<PrototypeSource> => backendOnly("Přidání zdroje"),
  patchSource: async (_id: string, _patch: unknown): Promise<PrototypeSource> => backendOnly("Úprava zdroje"),
  deleteSource: async (_id: string): Promise<void> => backendOnly("Odebrání zdroje"),
  refreshSource: async (_id: string): Promise<RefreshResult> => backendOnly("Načtení zdroje"),
  exportEditorJob: async (): Promise<unknown> => backendOnly("Redakční export"),
  enrichEditorJob: async (_runId: string, _candidateIds: string[]): Promise<unknown> => backendOnly("Načtení originálu"),
  abortEditorJob: async (_runId: string): Promise<unknown> => backendOnly("Zrušení redakčního běhu"),
  importEditorBatches: async (_payload: unknown, _operationId: string): Promise<unknown> => backendOnly("Redakční import"),
  importEditorResponse: async (_submission: EditorialSubmission, _ordered: string[]): Promise<unknown> => backendOnly("Redakční import"),
};
