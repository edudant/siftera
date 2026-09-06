/// <reference types="vite/client" />

import type {
  Candidate,
  EditorialSubmission,
  FeedItem,
  FeedRun,
  PreferenceProfile,
  UserItemState,
} from "@siftera/shared";

export type ImageMode = "auto" | "large" | "small" | "none";

export interface PrototypeSource {
  id: string;
  name: string;
  url: string;
  pluginId: string;
  groups: string[];
  deliveryMode: "curated" | "all";
  imageMode?: ImageMode;
  enabled: boolean;
  createdAt: string;
  lastFetchedAt: string | null;
  lastError: string | null;
}

export interface Bootstrap {
  user: { id: string; email: string };
  preferences: PreferenceProfile;
  feed: { run: FeedRun | null; items: FeedItem[] };
  library: FeedItem[];
  inbox: Array<{ candidate: Candidate; state: UserItemState }>;
  hidden: Array<{ candidate: Candidate; state: UserItemState }>;
  sources: PrototypeSource[];
  plugins: Array<{ id: string; label: string }>;
}

export interface RefreshResult {
  ingested: number;
  errors: string[];
  complete?: boolean;
  skipped?: number;
}

export interface ApiErrorDetail {
  field: string;
  reason: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly details: ApiErrorDetail[] = []) {
    super(message);
    this.name = "ApiError";
  }
}

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
const apiRoot = `${baseUrl.replace(/\/$/, "")}/api/v1`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiRoot}${path}`, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  if (response.status === 204) return undefined as T;
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string; details?: ApiErrorDetail[] } } | null;
    throw new ApiError(response.status, body?.error?.message ?? `Požadavek selhal (${response.status}).`, body?.error?.details ?? []);
  }
  return (await response.json()) as T;
}

export const api = {
  bootstrap: () => request<Bootstrap>("/bootstrap"),
  addArticle: (input: { url?: string; title?: string; text?: string; fullText?: boolean }) => request<{ candidate: Candidate }>("/articles", { method: "POST", body: JSON.stringify(input) }),
  addSource: (input: { name: string; url: string; pluginId: "rss"; groups?: string[]; deliveryMode?: "curated" | "all"; imageMode?: ImageMode }) => request<PrototypeSource>("/sources", { method: "POST", body: JSON.stringify(input) }),
  patchSource: (id: string, patch: { enabled?: boolean; name?: string; imageMode?: ImageMode }) => request<PrototypeSource>(`/sources/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSource: (id: string) => request<void>(`/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
  refreshSource: (id: string) => request<RefreshResult>(`/sources/${encodeURIComponent(id)}/refresh`, { method: "POST", body: "{}" }),
  savePreferences: (preferences: PreferenceProfile) => request<PreferenceProfile>("/preferences", { method: "PUT", body: JSON.stringify({ preferences, expectedVersion: preferences.version }) }),
  setItemState: (candidateId: string, expectedVersion: number, patch: Partial<Pick<UserItemState, "read" | "saved" | "hidden">>) => request<UserItemState>(`/items/${encodeURIComponent(candidateId)}/state`, { method: "PATCH", body: JSON.stringify({ patch, expectedVersion, operationId: crypto.randomUUID() }) }),
  exportEditorJob: () => request<unknown>("/editor/export", { method: "POST", body: JSON.stringify({ operationId: crypto.randomUUID() }) }),
  importEditorResponse: (submission: EditorialSubmission, orderedCandidateIds: string[]) => request<unknown>("/editor/import", { method: "POST", body: JSON.stringify({ submission, orderedCandidateIds, operationId: crypto.randomUUID() }) }),
};
