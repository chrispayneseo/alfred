// Topic CRUD for the personalized news feed — a flat editable list, seeded
// once with the user's starting interests. Distinct from Notion Projects:
// these are feed-curation inputs, not workspace content.
import { ensureSchema, getSql, type Env } from "../db.js";

export interface NewsTopic {
  id: string;
  name: string;
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

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
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
    await sql.query("INSERT INTO news_topics (id, name) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING", [crypto.randomUUID(), name]);
  }
}

export async function listTopics(env: Env): Promise<NewsTopic[]> {
  await ensureSeeded(env);
  const sql = await db(env);
  const rows = (await sql.query("SELECT id, name FROM news_topics ORDER BY created_at ASC")) as { id: string; name: string }[];
  return rows;
}

export async function addTopic(env: Env, name: string): Promise<NewsTopic> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Topic name is required");
  const sql = await db(env);
  const id = crypto.randomUUID();
  const rows = (await sql.query(
    "INSERT INTO news_topics (id, name) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING RETURNING id, name",
    [id, trimmed]
  )) as { id: string; name: string }[];
  if (rows[0]) return rows[0];
  const [existing] = (await sql.query("SELECT id, name FROM news_topics WHERE name = $1", [trimmed])) as { id: string; name: string }[];
  return existing;
}

export async function removeTopic(env: Env, id: string): Promise<void> {
  const sql = await db(env);
  await sql.query("DELETE FROM news_topics WHERE id = $1", [id]);
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
