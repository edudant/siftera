import type { IngestInput } from "@siftera/core";
import { XMLParser } from "fast-xml-parser";
import { decodeHtmlEntities, extractHtmlText } from "./html.js";
import { SafeHttpClient, SafeHttpError, assertSafePublicUrl } from "./safe-http.js";

export * from "./html.js";
export * from "./safe-http.js";
export * from "./article.js";

export interface ConnectorSource {
  sourceId: string;
  sourceName: string;
  groups?: string[];
  deliveryMode?: "curated" | "all";
  enabled?: boolean;
  archivedAt?: string | null;
  includeKeywords?: string[];
  excludeKeywords?: string[];
}

export interface NormalizedIngestInput extends IngestInput {
  connector: "manual" | "rss";
  bodyTruncated: boolean;
}

export interface ConnectorResult {
  inputs: NormalizedIngestInput[];
  /** false means the caller must retain a continuation/due state rather than silently dropping items. */
  complete: boolean;
}

export interface ManualConnectorRequest extends ConnectorSource {
  url: string;
  title?: string;
  text?: string | null;
  excerpt?: string;
  publishedAt?: string | null;
  categories?: string[];
  medium?: IngestInput["medium"];
  access?: IngestInput["access"];
}

export interface RssConnectorRequest extends ConnectorSource {
  url: string;
  maxItems?: number;
}

export interface DefaultConnectorRequests {
  manual: ManualConnectorRequest;
  rss: RssConnectorRequest;
}

export interface InputConnector<Request> {
  collect(request: Request): Promise<ConnectorResult>;
}

export class ConnectorRegistry<Requests extends object> {
  private readonly connectors = new Map<keyof Requests, InputConnector<unknown>>();

  register<Kind extends keyof Requests>(
    kind: Kind,
    connector: InputConnector<Requests[Kind]>,
  ): this {
    if (this.connectors.has(kind)) throw new ConnectorError("DUPLICATE_CONNECTOR");
    this.connectors.set(kind, connector as InputConnector<unknown>);
    return this;
  }

  async collect<Kind extends keyof Requests>(
    kind: Kind,
    request: Requests[Kind],
  ): Promise<ConnectorResult> {
    const connector = this.connectors.get(kind);
    if (!connector) throw new ConnectorError("UNKNOWN_CONNECTOR");
    return connector.collect(request);
  }
}

export class ConnectorError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "DUPLICATE_CONNECTOR"
      | "UNKNOWN_CONNECTOR"
      | "INVALID_FEED"
      | "UNSUPPORTED_FEED",
    message: string = code,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

const whitespace = (value: string) => value.replace(/\s+/gu, " ").trim();
const asList = <Value>(value: Value | Value[] | undefined): Value[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return decodeHtmlEntities(String(value));
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(" ");
  const record = asRecord(value);
  if (!record) return "";
  return Object.entries(record)
    .filter(([key]) => !key.startsWith("@"))
    .map(([, child]) => text(child))
    .filter(Boolean)
    .join(" ");
}

function field(record: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = record[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

function optionalDate(value: unknown): string | null {
  const source = whitespace(text(value));
  if (!source) return null;
  const parsed = new Date(source);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function sourceInput(source: ConnectorSource): Pick<IngestInput, "sourceId" | "sourceName" | "groups" | "deliveryMode" | "enabled" | "archivedAt" | "includeKeywords" | "excludeKeywords"> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(source.sourceId) || !whitespace(source.sourceName))
    throw new ConnectorError("INVALID_INPUT");
  return {
    sourceId: source.sourceId,
    sourceName: whitespace(source.sourceName).slice(0, 200),
    groups: source.groups ?? [],
    deliveryMode: source.deliveryMode ?? "curated",
    enabled: source.enabled ?? true,
    archivedAt: source.archivedAt ?? null,
    includeKeywords: source.includeKeywords ?? [],
    excludeKeywords: source.excludeKeywords ?? [],
  };
}

function bounded(value: string, max: number): { value: string; truncated: boolean } {
  const normalized = whitespace(value);
  return { value: normalized.slice(0, max), truncated: normalized.length > max };
}

function makeInput(
  source: ConnectorSource,
  value: Omit<IngestInput, keyof ReturnType<typeof sourceInput>>,
  connector: NormalizedIngestInput["connector"],
): NormalizedIngestInput {
  const url = assertSafePublicUrl(value.url).toString();
  const title = bounded(value.title, 500);
  if (!title.value) throw new ConnectorError("INVALID_INPUT", "entry is missing a title");
  const excerpt = bounded(value.excerpt ?? "", 10_000);
  const body = value.body === null || value.body === undefined ? null : bounded(value.body, 200_000);
  const categories = (value.categories ?? [])
    .map((category) => bounded(category, 80).value)
    .filter(Boolean)
    .slice(0, 30);
  return {
    ...sourceInput(source),
    ...value,
    url,
    title: title.value,
    excerpt: excerpt.value,
    body: body?.value ?? null,
    categories,
    externalId: value.externalId?.slice(0, 500) ?? null,
    connector,
    bodyTruncated: body?.truncated ?? false,
  };
}

export class ManualConnector implements InputConnector<ManualConnectorRequest> {
  async collect(request: ManualConnectorRequest): Promise<ConnectorResult> {
    const url = assertSafePublicUrl(request.url);
    const title = request.title ? whitespace(request.title) : url.hostname;
    const body = request.text ?? null;
    return {
      inputs: [
        makeInput(
          request,
          {
            url: url.toString(),
            title,
            excerpt: request.excerpt ?? (body ? extractHtmlText(body, 600) : ""),
            body: body ? extractHtmlText(body) : null,
            publishedAt: request.publishedAt ?? null,
            categories: request.categories ?? [],
            medium: request.medium ?? "text",
            access: request.access ?? (body ? "partial" : "unavailable"),
          },
          "manual",
        ),
      ],
      complete: true,
    };
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  processEntities: false,
  parseTagValue: false,
  trimValues: false,
});

/** Obrázek nesou feedy jako enclosure, media:content, media:thumbnail nebo itunes:image; bereme první bezpečný. */
function feedImage(item: Record<string, unknown>, base: string): NonNullable<IngestInput["image"]> | null {
  for (const key of ["enclosure", "media:content", "media:thumbnail", "itunes:image", "image"]) {
    for (const entry of asList(field(item, key))) {
      const record = asRecord(entry);
      if (!record) continue;
      const type = text(record["@type"]).toLowerCase();
      const medium = text(record["@medium"]).toLowerCase();
      if (type && !type.startsWith("image/")) continue;
      if (medium && medium !== "image") continue;
      const href = text(record["@url"]) || text(record["@href"]) || text(record["url"]);
      if (!href) continue;
      let url: string;
      try {
        url = assertSafePublicUrl(href, base).toString();
      } catch {
        continue;
      }
      const width = Number.parseInt(text(record["@width"]), 10);
      const height = Number.parseInt(text(record["@height"]), 10);
      return {
        url,
        width: Number.isInteger(width) && width > 0 ? width : null,
        height: Number.isInteger(height) && height > 0 ? height : null,
        alt: bounded(text(record["@alt"]) || text(record["@title"]), 500).value,
      };
    }
  }
  return null;
}

function rejectUnsafeXml(xml: string): void {
  if (/<!\s*(doctype|entity)\b/iu.test(xml))
    throw new ConnectorError("INVALID_FEED", "DTD and entities are not supported");
}

function resolvedLink(value: unknown, base: string): string | null {
  for (const link of asList(value)) {
    const record = asRecord(link);
    const href = record ? text(record["@href"]) : text(link);
    const rel = record ? text(record["@rel"]).toLowerCase() : "";
    if (rel && rel !== "alternate") continue;
    if (!href) continue;
    try {
      return assertSafePublicUrl(href, base).toString();
    } catch {
      continue;
    }
  }
  return null;
}

function rssItem(source: ConnectorSource, item: Record<string, unknown>, feedUrl: string): NormalizedIngestInput | null {
  const url = resolvedLink(field(item, "link"), feedUrl);
  if (!url) return null;
  const content = text(field(item, "content:encoded", "content"));
  const description = text(field(item, "description", "summary"));
  const title = text(field(item, "title")) || new URL(url).hostname;
  try {
    return makeInput(
      source,
      {
        url,
        externalId: whitespace(text(field(item, "guid", "id"))) || null,
        title,
        excerpt: extractHtmlText(description || content, 600),
        body: content ? extractHtmlText(content) : null,
        publishedAt: optionalDate(field(item, "pubDate", "published", "updated")),
        categories: asList(field(item, "category"))
          .map((category) => {
            const record = asRecord(category);
            return record ? text(record["@term"]) || text(record) : text(category);
          })
          .filter(Boolean),
        medium: "text",
        image: feedImage(item, feedUrl),
        // Feed text is metadata unless a later content fetch establishes full access.
        access: content ? "partial" : "unavailable",
      },
      "rss",
    );
  } catch (error) {
    if (error instanceof SafeHttpError || error instanceof ConnectorError) return null;
    throw error;
  }
}

function atomItem(source: ConnectorSource, item: Record<string, unknown>, feedUrl: string): NormalizedIngestInput | null {
  const xmlBase = text(item["@xml:base"]);
  const base = xmlBase ? new URL(xmlBase, feedUrl).toString() : feedUrl;
  const url = resolvedLink(field(item, "link"), base);
  if (!url) return null;
  const content = text(field(item, "content"));
  const summary = text(field(item, "summary", "subtitle"));
  const title = text(field(item, "title")) || new URL(url).hostname;
  try {
    return makeInput(
      source,
      {
        url,
        externalId: whitespace(text(field(item, "id"))) || null,
        title,
        excerpt: extractHtmlText(summary || content, 600),
        body: content ? extractHtmlText(content) : null,
        publishedAt: optionalDate(field(item, "published", "updated")),
        categories: asList(field(item, "category"))
          .map((category) => {
            const record = asRecord(category);
            return record ? text(record["@term"]) : text(category);
          })
          .filter(Boolean),
        medium: "text",
        image: feedImage(item, base),
        access: content ? "partial" : "unavailable",
      },
      "rss",
    );
  } catch (error) {
    if (error instanceof SafeHttpError || error instanceof ConnectorError) return null;
    throw error;
  }
}

export class RssAtomConnector implements InputConnector<RssConnectorRequest> {
  constructor(private readonly http: SafeHttpClient) {}

  async collect(request: RssConnectorRequest): Promise<ConnectorResult> {
    const maxItems = request.maxItems ?? 100;
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100)
      throw new ConnectorError("INVALID_INPUT", "maxItems must be 1..100");
    const response = await this.http.get(request.url);
    if (response.status === 304) return { inputs: [], complete: true };
    if (response.status < 200 || response.status >= 300)
      throw new ConnectorError("INVALID_FEED", `feed returned HTTP ${response.status}`);
    if (response.body.length > 5 * 1024 * 1024)
      throw new ConnectorError("INVALID_FEED", "feed body exceeds parser limit");
    rejectUnsafeXml(response.body);
    let document: Record<string, unknown>;
    try {
      document = parser.parse(response.body) as Record<string, unknown>;
    } catch {
      throw new ConnectorError("INVALID_FEED");
    }
    const rss = asRecord(document.rss);
    if (rss) {
      const channel = asRecord(rss.channel);
      if (!channel) throw new ConnectorError("INVALID_FEED");
      const entries = asList(field(channel, "item"))
        .map(asRecord)
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      return this.result(entries, maxItems, (entry) => rssItem(request, entry, response.url));
    }
    const feed = asRecord(document.feed);
    if (feed) {
      const feedBase = text(feed["@xml:base"]);
      const base = feedBase ? new URL(feedBase, response.url).toString() : response.url;
      const entries = asList(field(feed, "entry"))
        .map(asRecord)
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      return this.result(entries, maxItems, (entry) => atomItem(request, entry, base));
    }
    throw new ConnectorError("UNSUPPORTED_FEED");
  }

  private result(
    entries: Record<string, unknown>[],
    maxItems: number,
    convert: (entry: Record<string, unknown>) => NormalizedIngestInput | null,
  ): ConnectorResult {
    const inputs = entries.slice(0, maxItems).map(convert).filter((entry): entry is NormalizedIngestInput => entry !== null);
    return { inputs, complete: entries.length <= maxItems };
  }
}

export function createDefaultConnectorRegistry(options: { http: SafeHttpClient }): ConnectorRegistry<DefaultConnectorRequests> {
  return new ConnectorRegistry<DefaultConnectorRequests>()
    .register("manual", new ManualConnector())
    .register("rss", new RssAtomConnector(options.http));
}
