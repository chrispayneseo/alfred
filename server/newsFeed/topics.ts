// Topic CRUD for the personalized news feed — a flat editable list, seeded
// once with the user's starting interests. Distinct from Notion Projects:
// these are feed-curation inputs, not workspace content.
import { ensureSchema, getSql, type Env } from "../db.js";

export interface NewsTopic {
  id: string;
  name: string;
  preferredDomains: string[];
}

const SEED_TOPICS = [
  "SEO",
  "Leeds United",
  "AI",
  "Claude",
  "ChatGPT",
  "The Cure",
  "Kaiser Chiefs",
  "Sum 41",
  "OK Go",
  "family history",
  "Hampshire history",
  "British history",
];

// A user-curated starting point for each seed topic's web search — see
// SEED_DOMAINS below. Editable per-topic afterwards; this is just the
// out-of-the-box default so the feed isn't a blind open-web search from day
// one. Empty/absent means "search the open web" (any topic added later
// starts this way until the user curates sources for it too).
//
// Five domains from the user's original list block Claude's web-search
// crawler outright (confirmed live: arstechnica.com, bbc.co.uk,
// leeds-live.co.uk, moz.com, pitchfork.com) — the API 400s the whole
// request if even one allowed_domains entry is inaccessible, so these are
// dropped here rather than relying on searchNewsForTopic's retry-and-drop
// fallback on every single scan.
export const SEED_DOMAINS: Record<string, string[]> = {
  SEO: ["searchengineland.com", "searchenginejournal.com", "ahrefs.com", "developers.google.com"],
  "Leeds United": ["thesquareball.net", "leedsunited.com", "yorkshireeveningpost.co.uk"],
  AI: ["anthropic.com", "openai.com", "deeplearning.ai", "simonwillison.net"],
  Claude: ["anthropic.com", "openai.com", "deeplearning.ai", "simonwillison.net"],
  ChatGPT: ["anthropic.com", "openai.com", "deeplearning.ai", "simonwillison.net"],
  "The Cure": ["nme.com", "kerrang.com", "rollingstone.com", "thecure.com"],
  "Kaiser Chiefs": ["nme.com", "kerrang.com", "rollingstone.com", "kaiserchiefs.com"],
  "Sum 41": ["nme.com", "kerrang.com", "rollingstone.com", "sum41.com"],
  "OK Go": ["okgo.net", "consequence.net", "rollingstone.com"],
  "family history": ["nationalarchives.gov.uk", "familysearch.org", "hgs-familyhistory.com", "hampshirearchivestrust.co.uk", "british-history.ac.uk"],
  "Hampshire history": ["nationalarchives.gov.uk", "familysearch.org", "hgs-familyhistory.com", "hampshirearchivestrust.co.uk", "british-history.ac.uk"],
  "British history": ["historytoday.com", "english-heritage.org.uk", "british-history.ac.uk", "nationalarchives.gov.uk"],
};

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

interface TopicRow {
  id: string;
  name: string;
  preferred_domains: string;
}

function toTopic(row: TopicRow): NewsTopic {
  let preferredDomains: string[] = [];
  try {
    const parsed = JSON.parse(row.preferred_domains);
    if (Array.isArray(parsed)) preferredDomains = parsed.filter((d): d is string => typeof d === "string");
  } catch {
    // malformed JSON in the column — treat as no restriction rather than throwing
  }
  return { id: row.id, name: row.name, preferredDomains };
}

/** Seeds the default topic list exactly once — a no-op on every call after
 * the first, since it only inserts when the table is still empty. Called
 * lazily from listTopics() rather than from ensureSchema() (schema and
 * starting content are different concerns). */
async function ensureSeeded(env: Env): Promise<void> {
  const sql = await db(env);
  const [{ n }] = (await sql.query("SELECT COUNT(*) AS n FROM news_topics")) as { n: string }[];
  if (Number(n) > 0) return;
  for (const name of SEED_TOPICS) {
    await sql.query("INSERT INTO news_topics (id, name, preferred_domains) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING", [
      crypto.randomUUID(),
      name,
      JSON.stringify(SEED_DOMAINS[name] ?? []),
    ]);
  }
}

export async function listTopics(env: Env): Promise<NewsTopic[]> {
  await ensureSeeded(env);
  const sql = await db(env);
  const rows = (await sql.query("SELECT id, name, preferred_domains FROM news_topics ORDER BY created_at ASC")) as TopicRow[];
  return rows.map(toTopic);
}

export async function addTopic(env: Env, name: string): Promise<NewsTopic> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Topic name is required");
  const sql = await db(env);
  const id = crypto.randomUUID();
  const rows = (await sql.query(
    "INSERT INTO news_topics (id, name) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING RETURNING id, name, preferred_domains",
    [id, trimmed]
  )) as TopicRow[];
  if (rows[0]) return toTopic(rows[0]);
  const [existing] = (await sql.query("SELECT id, name, preferred_domains FROM news_topics WHERE name = $1", [trimmed])) as TopicRow[];
  return toTopic(existing);
}

export async function removeTopic(env: Env, id: string): Promise<void> {
  const sql = await db(env);
  await sql.query("DELETE FROM news_topics WHERE id = $1", [id]);
}

/** Replaces a topic's preferred-domains list wholesale — an empty array
 * clears the restriction back to an open-web search for that topic. */
export async function setTopicDomains(env: Env, id: string, domains: string[]): Promise<NewsTopic> {
  const cleaned = domains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  const sql = await db(env);
  const rows = (await sql.query(
    "UPDATE news_topics SET preferred_domains = $1 WHERE id = $2 RETURNING id, name, preferred_domains",
    [JSON.stringify(cleaned), id]
  )) as TopicRow[];
  if (!rows[0]) throw new Error("Topic not found");
  return toTopic(rows[0]);
}

/** Wipes topics, suggestions, and generated feed content — used by the
 * settings "delete everything / disconnect" flow. This is Alfred's own
 * derived/preference data, not connected-account content. */
export async function clearAllNewsFeed(env: Env): Promise<void> {
  const sql = await db(env);
  await sql.query("DELETE FROM news_topics");
  await sql.query("DELETE FROM news_topic_suggestions");
  await sql.query("DELETE FROM news_feed_items");
  await sql.query("DELETE FROM news_feed_generations");
  await sql.query("DELETE FROM news_feed_scanned_emails");
}
