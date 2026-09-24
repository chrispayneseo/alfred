import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const connectionString = process.env.ALFRED_DATABASE_URL;
if (!connectionString) throw new Error("ALFRED_DATABASE_URL is required.");

const client = new pg.Client({ connectionString });
await client.connect();

try {
  await client.query("begin");
  await client.query(`create table if not exists alfred_schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);

  const directory = join(process.cwd(), "db", "migrations");
  const migrations = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of migrations) {
    const exists = await client.query("select 1 from alfred_schema_migrations where name = $1", [name]);
    if (exists.rowCount) continue;
    await client.query(await readFile(join(directory, name), "utf8"));
    await client.query("insert into alfred_schema_migrations (name) values ($1)", [name]);
    console.log(`Applied ${name}`);
  }
  await client.query("commit");
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  await client.end();
}
