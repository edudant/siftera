const whitespace = (value: string) => value.replace(/\s+/gu, " ").trim();

const namedEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (whole, entity: string) => {
    if (entity[0] === "#") {
      const radix = entity[1]?.toLowerCase() === "x" ? 16 : 10;
      const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
      const codePoint = Number.parseInt(digits, radix);
      if (Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff)
        return String.fromCodePoint(codePoint);
      return whole;
    }
    return namedEntities[entity.toLowerCase()] ?? whole;
  });
}

/** Deterministic, plain-text-only fallback. It intentionally never returns source HTML. */
export function extractHtmlText(html: string, maxCharacters = 200_000): string {
  const withoutIgnored = html
    .replace(/<\s*(script|style|template|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/giu, " ")
    .replace(/<!--([\s\S]*?)-->/gu, " ");
  const withBreaks = withoutIgnored.replace(/<\s*\/?\s*(article|br|div|h[1-6]|li|p|section|tr)\b[^>]*>/giu, " ");
  return whitespace(decodeHtmlEntities(withBreaks.replace(/<[^>]*>/gu, " "))).slice(0, maxCharacters);
}

export function extractHtmlTitle(html: string): string | null {
  const match = /<\s*title\b[^>]*>([\s\S]*?)<\s*\/\s*title\s*>/iu.exec(html);
  const title = match?.[1] ? extractHtmlText(match[1], 500) : "";
  return title || null;
}
