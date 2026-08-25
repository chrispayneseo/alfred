/** Crude but dependency-free HTML-to-text: strips script/style/comments and
 * every remaining tag, then collapses whitespace. Loses structure, but the
 * pages this is used against (recipe pages, fixture listings) almost always
 * keep clear textual markers even as flat text, and the LLM extraction that
 * follows is doing the real structuring work — this just needs to get the
 * readable content out of the markup. */
export function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
