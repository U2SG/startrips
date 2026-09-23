/**
 * #512: what a fetched page is allowed to become before a provider reads it.
 *
 * A shared itinerary link carries the member's signature in its query, and the
 * page behind it arrives as raw markup: scripts, trackers, canonical tags and
 * every `href` the site prints, including the signed share URL itself. None of
 * that is what a recogniser needs — it needs the plan a person would read on
 * the screen — and #512 requires the material entering the recognition service
 * to be minimised, with signature and tracking links left out.
 *
 * So a page becomes a recognition document here and nowhere else: the origin
 * without the query, and the visible text with markup, script and every
 * absolute URL removed. A token cannot be redacted out of a document it was
 * never copied into.
 */

/** Stands in for a removed link so a sentence does not silently lose a word. */
export const REDACTED_LINK = "[链接已省略]";

const URL_PATTERN = /(?:https?:)?\/\/[^\s"'<>)\]]+/gi;
const BLOCK_ELEMENTS = /<\/(?:p|div|li|tr|h[1-6]|section|article|td|th)>/gi;
const REMOVED_ELEMENTS =
  /<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * The origin, and only the origin.
 *
 * It is the one part of a share link that helps a reading — it says which
 * site's layout this is — and the one part that carries no share token, no
 * order number and no member identifier. A link this function cannot parse
 * contributes nothing rather than falling back to the raw string.
 */
export function sourceOriginForRecognition(finalUrl: string): string | null {
  try {
    const url = new URL(finalUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** Remove every absolute or protocol-relative URL from already-visible text. */
export function redactLinks(text: string): string {
  return text.replace(URL_PATTERN, REDACTED_LINK);
}

/**
 * Reduce a fetched body to the text a person would have read.
 *
 * Markup is dropped rather than parsed: an attribute is where a share token
 * lives, so no attribute survives, and script and style bodies go with their
 * elements. A non-markup body keeps its own shape and only loses its links.
 */
export function minimizeRecognitionText(
  body: string,
  contentType: string | null,
): string {
  const markup = (contentType ?? "").toLowerCase().includes("html");
  if (!markup) return redactLinks(body);
  let text = body
    .replace(REMOVED_ELEMENTS, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(BLOCK_ELEMENTS, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  for (const [entity, character] of Object.entries(ENTITIES)) {
    text = text.split(entity).join(character);
  }
  return redactLinks(text)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim();
}

/**
 * The only way a fetched page becomes something a provider is handed.
 *
 * `finalUrl` never travels: the recogniser reads the page, not the private
 * address the page was served from.
 */
export function pageRecognitionDocument(page: {
  finalUrl: string;
  text: string;
  contentType: string | null;
}): { kind: "page"; sourceOrigin: string | null; text: string } {
  return {
    kind: "page",
    sourceOrigin: sourceOriginForRecognition(page.finalUrl),
    text: minimizeRecognitionText(page.text, page.contentType),
  };
}
