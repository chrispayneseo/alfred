// Gmail's search `q` ANDs space-separated terms by default, so a derived
// query needs to be fairly aggressive about dropping words that describe the
// act of asking ("check", "find", "tell me") rather than the thing being
// searched for — one leftover noise word is enough to zero out real results.
const STOPWORDS = new Set([
  // grammar / question words
  "what",
  "when",
  "where",
  "who",
  "how",
  "many",
  "much",
  "is",
  "are",
  "was",
  "were",
  "do",
  "does",
  "did",
  "the",
  "a",
  "an",
  "for",
  "to",
  "of",
  "my",
  "me",
  "i",
  "have",
  "has",
  "had",
  "on",
  "in",
  "at",
  "about",
  "with",
  "and",
  "or",
  "but",
  "if",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "from",
  "by",
  "as",
  "be",
  "been",
  "being",
  // request/meta verbs — describe the act of asking, not the content to find
  "check",
  "find",
  "search",
  "look",
  "show",
  "get",
  "give",
  "confirm",
  "tell",
  "know",
  "see",
  "want",
  "would",
  "could",
  "should",
  "need",
  "like",
  "please",
  "can",
  "you",
  "your",
  "thanks",
  // generic nouns too broad to be useful search terms on their own
  "email",
  "emails",
  "inbox",
  "message",
  "messages",
  "note",
  "notes",
  "task",
  "tasks",
  "next",
  "due",
  "time",
]);

/** Strips question words, request-verbs, and punctuation from a chat message
 * to derive a search query — shared by the Notion and email context builders. */
export function deriveSearchQuery(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !STOPWORDS.has(word))
    .join(" ");
  return cleaned || text;
}
