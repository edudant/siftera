import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { ArticlePage, ArticleReader } from "@siftera/core";
import { SafeHttpClient } from "./safe-http.js";

const MAX_TEXT = 24_000;
/** Only anonymous HTML is read. Scripts, hidden markup and structured-data bodies are never text sources. */
export function extractArticle(html: string, url: string): ArticlePage {
  // Advertising canvases have no article text and require native graphics unavailable in Workers.
  const { document } = parseHTML(html.replace(/<canvas\b[^>]*>[\s\S]*?<\/canvas\s*>/giu, "").replace(/<canvas\b[^>]*\/?\s*>/giu, ""));
  const paywall = /["']isAccessibleForFree["']\s*:\s*(?:false|["']false["'])/iu.test(html)
    || !!document.querySelector('[class*="paywall"], [id*="paywall"], [data-paywall]');
  document.querySelectorAll('script,style,template,noscript,svg,iframe,nav,footer,aside,[hidden],[aria-hidden="true"]').forEach(node => node.remove());
  document.querySelectorAll('[style]').forEach(node => {
    if (/display\s*:\s*none|visibility\s*:\s*hidden/iu.test(node.getAttribute('style') ?? '')) node.remove();
  });
  // Never extract a hidden subscriber body; retain only the public lead before a visible gate.
  document.querySelectorAll('[class*="paywall"], [id*="paywall"], [data-paywall]').forEach(node => {
    while (node.nextElementSibling) node.nextElementSibling.remove();
    node.remove();
  });
  const description = document.querySelector('meta[name="description"],meta[property="og:description"]')?.getAttribute('content') ?? '';
  const base = document.createElement('base'); base.setAttribute('href', url); document.head.appendChild(base);
  const parsed = new Readability(document as unknown as Document).parse();
  let text = (parsed?.textContent ?? description).replace(/\s+/gu, ' ').trim();
  if (!text) text = description.trim();
  // A subscription message is a boundary, not article content. Do not use text beyond it.
  const gate = /(?:pouze pro předplatitele|pokračování (?:článku|textu).{0,40}předplat|předplaťte si|odemknout článek|subscribe to (?:continue|read)|already a subscriber|subscription required)/iu.exec(text);
  if (gate) text = text.slice(0, gate.index).trim() || description.trim();
  const restricted = paywall || !!gate;
  // For a declared paywall we cannot infer CSS visibility of subscriber content from server HTML.
  // The publisher's public description is the safe preview; RSS remains available when it is empty.
  if (paywall) text = description.trim();
  const truncated = text.length > MAX_TEXT;
  return {
    title: parsed?.title?.slice(0, 500) || null,
    text: text.slice(0, MAX_TEXT),
    access: !text ? 'unavailable' : restricted || truncated || !parsed || text.length < 400 ? 'partial' : 'full',
    paywall: restricted,
    truncated,
  };
}

export class PublicArticleReader implements ArticleReader {
  constructor(private http: SafeHttpClient) {}
  async read(url: string): Promise<ArticlePage> {
    const result = await this.http.get(url);
    if (result.status < 200 || result.status >= 300 || !/html/iu.test(result.contentType ?? '')) throw new Error('ARTICLE_UNAVAILABLE');
    return extractArticle(result.body, result.url);
  }
}
