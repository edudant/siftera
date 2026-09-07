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

describe("feed images", () => {
  it("reads an RSS enclosure image and rejects a non-image enclosure", async () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>F</title>
      <item><title>With image</title><link>https://example.com/a</link>
        <enclosure url="https://cdn.example.com/a.jpg?itok=x" type="image/jpeg" length="1234" /></item>
      <item><title>Audio only</title><link>https://example.com/b</link>
        <enclosure url="https://cdn.example.com/b.mp3" type="audio/mpeg" /></item>
      </channel></rss>`;
    const result = await new RssAtomConnector(http(feed)).collect({ ...source, url: "https://example.com/rss" });
    expect(result.inputs[0]?.image).toEqual({ url: "https://cdn.example.com/a.jpg?itok=x", width: null, height: null, alt: "" });
    expect(result.inputs[1]?.image).toBeNull();
  });

  it("reads media:content with dimensions and resolves a relative Atom image against xml:base", async () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>F</title>
      <item><title>Media</title><link>https://example.com/a</link>
        <media:content url="https://cdn.example.com/m.jpg" medium="image" width="800" height="450" /></item>
      </channel></rss>`;
    const withMedia = await new RssAtomConnector(http(rss)).collect({ ...source, url: "https://example.com/rss" });
    expect(withMedia.inputs[0]?.image).toEqual({ url: "https://cdn.example.com/m.jpg", width: 800, height: 450, alt: "" });

    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>F</title>
      <entry xml:base="https://example.com/posts/"><title>Relative</title><link href="https://example.com/posts/a" />
        <media:thumbnail url="thumb.png" /></entry></feed>`;
    const relative = await new RssAtomConnector(http(atom, "application/atom+xml")).collect({ ...source, url: "https://example.com/atom" });
    expect(relative.inputs[0]?.image?.url).toBe("https://example.com/posts/thumb.png");
  });

  it("drops an unsafe image URL instead of failing the whole entry", async () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>F</title>
      <item><title>Private host</title><link>https://example.com/a</link>
        <enclosure url="http://127.0.0.1/secret.jpg" type="image/jpeg" /></item>
      </channel></rss>`;
    const result = await new RssAtomConnector(http(feed)).collect({ ...source, url: "https://example.com/rss" });
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]?.image).toBeNull();
  });
});

describe("media groups", () => {
  it("reads description and thumbnail from media:group, as YouTube feeds provide them", async () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <title>Kanál</title>
      <entry><title>Video o něčem</title><link rel="alternate" href="https://www.youtube.com/watch?v=abc123" />
        <published>2026-09-03T08:23:37+00:00</published>
        <media:group>
          <media:description>Rozbor nové studie a co z ní plyne pro praxi.</media:description>
          <media:thumbnail url="https://i.ytimg.com/vi/abc123/hqdefault.jpg" width="480" height="360" />
        </media:group>
      </entry></feed>`;
    const result = await new RssAtomConnector(http(atom, "application/atom+xml")).collect({ ...source, url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCabc" });
    expect(result.inputs[0]?.excerpt).toContain("Rozbor nové studie");
    expect(result.inputs[0]?.image).toMatchObject({ url: "https://i.ytimg.com/vi/abc123/hqdefault.jpg", width: 480, height: 360 });
  });
});

describe("rozpoznání videa (přehrávání ve feedu)", () => {
  const atom = (entry: string) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Kanál</title>${entry}</feed>`;

  it("označí YouTube položku jako video a uloží identifikátor i délku", async () => {
    const feed = atom(`<entry><title>Video</title><link rel="alternate" href="https://www.youtube.com/watch?v=FluKUJyeYD8" />
      <yt:videoId>FluKUJyeYD8</yt:videoId>
      <media:group><media:content url="https://www.youtube.com/v/FluKUJyeYD8?version=3" duration="754" /></media:group>
    </entry>`);
    const result = await new RssAtomConnector(http(feed, "application/atom+xml")).collect({ ...source, url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCabc" });
    expect(result.inputs[0]?.medium).toBe("video");
    expect(result.inputs[0]?.media).toEqual({
      provider: "youtube", externalId: "FluKUJyeYD8",
      url: "https://www.youtube.com/watch?v=FluKUJyeYD8", durationSeconds: 754,
    });
  });

  it("pozná video i bez yt:videoId, podle kanonické adresy", async () => {
    const feed = atom(`<entry><title>Video</title><link rel="alternate" href="https://youtu.be/0Rp9KJCEIvg" /></entry>`);
    const result = await new RssAtomConnector(http(feed, "application/atom+xml")).collect({ ...source, url: "https://example.com/atom" });
    expect(result.inputs[0]?.media?.externalId).toBe("0Rp9KJCEIvg");
  });

  it("cizí adresu za video nevydává, i když se tak jmenuje", async () => {
    const feed = atom(`<entry><title>Článek o YouTube</title><link rel="alternate" href="https://example.com/youtube.com/watch?v=abc" /></entry>`);
    const result = await new RssAtomConnector(http(feed, "application/atom+xml")).collect({ ...source, url: "https://example.com/atom" });
    expect(result.inputs[0]?.medium).toBe("text");
    expect(result.inputs[0]?.media ?? null).toBeNull();
  });

  it("nesmyslný identifikátor odmítne, aby se do embedu nedostal cizí vstup", async () => {
    const feed = atom(`<entry><title>Video</title><link rel="alternate" href="https://www.youtube.com/watch?v=../../etc/passwd" /></entry>`);
    const result = await new RssAtomConnector(http(feed, "application/atom+xml")).collect({ ...source, url: "https://example.com/atom" });
    expect(result.inputs[0]?.media ?? null).toBeNull();
  });
});
