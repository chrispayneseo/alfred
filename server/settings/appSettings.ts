// Small generic key-value store for user preferences that don't warrant
// their own table (currently just the weekly digest trigger day). Postgres
// (server/db.ts), same database as everything else.
import { ensureSchema, getSql, type Env } from "../db.js";

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

export async function getSetting(env: Env, key: string): Promise<string | undefined> {
  const sql = await db(env);
  const rows = (await sql.query("SELECT value FROM app_settings WHERE key = $1", [key])) as { value: string }[];
  return rows[0]?.value;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  const sql = await db(env);
  await sql.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}
