import { describe, expect, it } from "vitest";
import {
  ConnectorError,
  ManualConnector,
  RssAtomConnector,
  SafeHttpClient,
  SafeHttpError,
  extractHtmlText,
} from "../packages/connectors/src/index.js";

const source = { sourceId: "source", sourceName: "Example source" };
const publicResolver = async () => [{ address: "93.184.216.34", family: 4 as const }];

function http(body: string, contentType = "application/rss+xml") {
  return new SafeHttpClient({
    resolveHost: publicResolver,
    fetch: async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": contentType },
      }),
  });
}

describe("manual connector", () => {
  it("normalizes explicitly supplied URL/text without any HTTP fetch", async () => {
    const result = await new ManualConnector().collect({
      ...source,
      url: "https://Example.COM/article#ignore",
      text: "<p>Hello &amp; <strong>world</strong></p><script>ignore()</script>",
    });
    expect(result).toEqual({
      complete: true,
      inputs: [
        expect.objectContaining({
          connector: "manual",
          url: "https://example.com/article",
          title: "example.com",
          body: "Hello & world",
          access: "partial",
        }),
      ],
    });
  });
});

describe("RSS and Atom connector", () => {
  it("parses RSS metadata, content text, categories, and GUID", async () => {
    const connector = new RssAtomConnector(
      http(`<?xml version="1.0"?>
        <rss><channel><item>
          <guid>entry-1</guid><title>  Useful &amp; safe  </title>
          <link>https://publisher.example/story</link>
          <description><![CDATA[<p>Short <b>summary</b></p>]]></description>
          <content:encoded><![CDATA[<article>Full <em>feed</em> text</article>]]></content:encoded>
          <category>technology</category><pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate>
        </item></channel></rss>`),
    );
    const result = await connector.collect({ ...source, url: "https://feed.example/rss.xml" });
    expect(result.complete).toBe(true);
    expect(result.inputs).toEqual([
      expect.objectContaining({
        connector: "rss",
        externalId: "entry-1",
        title: "Useful & safe",
        excerpt: "Short summary",
        body: "Full feed text",
        access: "partial",
        categories: ["technology"],
        publishedAt: "2026-09-01T10:00:00.000Z",
      }),
    ]);
  });

  it("resolves an Atom relative link using xml:base and reports a bounded continuation", async () => {
    const connector = new RssAtomConnector(
      http(`<?xml version="1.0"?>
        <feed xml:base="https://publisher.example/base/"><entry>
          <id>atom-1</id><title>Atom post</title><link href="article"/>
          <summary>Atom summary</summary>
        </entry><entry><id>atom-2</id><title>Later</title><link href="later"/></entry></feed>`, "application/atom+xml"),
    );
    const result = await connector.collect({ ...source, url: "https://feed.example/atom", maxItems: 1 });
    expect(result.complete).toBe(false);
    expect(result.inputs).toEqual([
      expect.objectContaining({ url: "https://publisher.example/base/article", externalId: "atom-1" }),
    ]);
  });

  it("rejects DTD input before XML parsing", async () => {
    const connector = new RssAtomConnector(http("<!DOCTYPE rss [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]><rss/>"));
    await expect(connector.collect({ ...source, url: "https://feed.example/rss" })).rejects.toMatchObject({
      code: "INVALID_FEED",
    } satisfies Partial<ConnectorError>);
  });
});

describe("safe HTTP", () => {
  it("rejects private resolved addresses and checks each redirect destination", async () => {
    const lookups: string[] = [];
    const client = new SafeHttpClient({
      resolveHost: async (host) => {
        lookups.push(host);
        return host === "private.example"
          ? [{ address: "127.0.0.1", family: 4 }]
          : [{ address: "93.184.216.34", family: 4 }];
      },
      fetch: async (url) => {
        if (url === "https://public.example/start")
          return new Response(null, { status: 302, headers: { location: "https://private.example/next" } });
        return new Response("never", { status: 200, headers: { "content-type": "text/html" } });
      },
    });
    await expect(client.get("https://public.example/start")).rejects.toMatchObject({
      code: "BLOCKED_DESTINATION",
    } satisfies Partial<SafeHttpError>);
    expect(lookups).toEqual(["public.example", "private.example"]);
  });

  it("enforces the decoded response body limit", async () => {
    const client = new SafeHttpClient({
      resolveHost: publicResolver,
      maxBodyBytes: 4,
      fetch: async () => new Response("12345", { status: 200, headers: { "content-type": "text/html" } }),
    });
    await expect(client.get("https://public.example/page")).rejects.toMatchObject({
      code: "BODY_TOO_LARGE",
    } satisfies Partial<SafeHttpError>);
  });
});

it("extracts safe plain text from ordinary HTML", () => {
  expect(extractHtmlText("<h1>A &amp; B</h1><style>hidden</style><p>Visible</p>")).toBe("A & B Visible");
});
