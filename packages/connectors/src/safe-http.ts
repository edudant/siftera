export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * The resolver and fetch implementation are supplied by the runtime. In Node, the
 * fetch implementation must connect using the inspected address; otherwise DNS
 * rebinding can occur between this lookup and the connection.
 */
export type PublicHostResolver = (
  hostname: string,
) => Promise<readonly ResolvedAddress[]>;

export interface SafeHttpClientOptions {
  fetch: FetchLike;
  resolveHost: PublicHostResolver;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRedirects?: number;
  allowedContentTypes?: readonly string[];
}

export interface SafeHttpResponse {
  url: string;
  status: number;
  contentType: string | null;
  headers: Headers;
  body: string;
}

export class SafeHttpError extends Error {
  constructor(
    readonly code:
      | "INVALID_URL"
      | "BLOCKED_DESTINATION"
      | "DNS_LOOKUP_FAILED"
      | "TOO_MANY_REDIRECTS"
      | "MISSING_REDIRECT_LOCATION"
      | "TIMEOUT"
      | "BODY_TOO_LARGE"
      | "UNSUPPORTED_CONTENT_TYPE"
      | "NETWORK_ERROR",
    message = code,
  ) {
    super(message);
    this.name = "SafeHttpError";
  }
}

const defaultContentTypes = [
  "text/html",
  "application/xhtml+xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/xml",
  "text/xml",
] as const;
const redirects = new Set([301, 302, 303, 307, 308]);
const blockedHostnames = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

function isIpV4(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
  );
}

function isPublicIpv4(value: string): boolean {
  if (!isIpV4(value)) return false;
  const [a, b, c] = value.split(".").map(Number);
  if (a === undefined || b === undefined || c === undefined) return false;
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  )
    return false;
  return true;
}

function isPublicIpv6(value: string): boolean {
  const address = value.toLowerCase().replace(/^\[|\]$/gu, "");
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
  if (mapped?.[1]) return isPublicIpv4(mapped[1]);
  if (!/^[0-9a-f:]+$/u.test(address) || !address.includes(":")) return false;
  if (address === "::" || address === "::1") return false;
  const first = address.split(":")[0] ?? "";
  const firstValue = Number.parseInt(first || "0", 16);
  if (
    (firstValue & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (firstValue & 0xffc0) === 0xfe80 || // link local fe80::/10
    (firstValue & 0xff00) === 0xff00 || // multicast ff00::/8
    address.startsWith("2001:db8:") // documentation range
  )
    return false;
  return true;
}

export function isPublicIp(address: string, family: 4 | 6): boolean {
  return family === 4 ? isPublicIpv4(address) : isPublicIpv6(address);
}

export function assertSafePublicUrl(input: string, base?: string): URL {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw new SafeHttpError("INVALID_URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    (url.port !== "" && url.port !== "80" && url.port !== "443")
  )
    throw new SafeHttpError("INVALID_URL");
  url.hash = "";
  const host = url.hostname.toLowerCase();
  if (
    blockedHostnames.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    ((isIpV4(host) && !isPublicIpv4(host)) ||
      (host.includes(":") && !isPublicIpv6(host)))
  )
    throw new SafeHttpError("BLOCKED_DESTINATION");
  return url;
}

async function bodyText(response: Response, maxBodyBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel();
        throw new SafeHttpError("BODY_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export class SafeHttpClient {
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly maxRedirects: number;
  private readonly allowedContentTypes: readonly string[];

  constructor(private readonly options: SafeHttpClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBodyBytes = options.maxBodyBytes ?? 5 * 1024 * 1024;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.allowedContentTypes = options.allowedContentTypes ?? defaultContentTypes;
  }

  async get(input: string): Promise<SafeHttpResponse> {
    let url = assertSafePublicUrl(input);
    for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
      await this.assertPublicDestination(url);
      const response = await this.request(url);
      if (redirects.has(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new SafeHttpError("MISSING_REDIRECT_LOCATION");
        if (redirectCount === this.maxRedirects)
          throw new SafeHttpError("TOO_MANY_REDIRECTS");
        url = assertSafePublicUrl(location, url.toString());
        continue;
      }
      if (response.status === 304)
        return {
          url: url.toString(),
          status: response.status,
          contentType: null,
          headers: response.headers,
          body: "",
        };
      const contentType = response.headers.get("content-type");
      const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
      if (!mediaType || !this.allowedContentTypes.includes(mediaType))
        throw new SafeHttpError("UNSUPPORTED_CONTENT_TYPE");
      return {
        url: url.toString(),
        status: response.status,
        contentType: mediaType,
        headers: response.headers,
        body: await bodyText(response, this.maxBodyBytes),
      };
    }
    throw new SafeHttpError("TOO_MANY_REDIRECTS");
  }

  private async assertPublicDestination(url: URL): Promise<void> {
    if (isIpV4(url.hostname)) {
      if (!isPublicIpv4(url.hostname)) throw new SafeHttpError("BLOCKED_DESTINATION");
      return;
    }
    if (url.hostname.includes(":")) {
      if (!isPublicIpv6(url.hostname)) throw new SafeHttpError("BLOCKED_DESTINATION");
      return;
    }
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await this.options.resolveHost(url.hostname);
    } catch {
      throw new SafeHttpError("DNS_LOOKUP_FAILED");
    }
    if (addresses.length === 0 || addresses.some(({ address, family }) => !isPublicIp(address, family)))
      throw new SafeHttpError("BLOCKED_DESTINATION");
  }

  private async request(url: URL): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.options.fetch(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9" },
      });
    } catch (error) {
      if (controller.signal.aborted) throw new SafeHttpError("TIMEOUT");
      if (error instanceof SafeHttpError) throw error;
      throw new SafeHttpError("NETWORK_ERROR");
    } finally {
      clearTimeout(timeout);
    }
  }
}
