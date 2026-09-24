import { Pool } from "pg";

let pool: Pool | undefined;

export function databaseConfigured(): boolean {
  return Boolean(process.env.ALFRED_DATABASE_URL);
}

export function database(): Pool {
  if (!process.env.ALFRED_DATABASE_URL) {
    throw new Error("Alfred database is not configured. Set ALFRED_DATABASE_URL before using durable memory.");
  }
  pool ??= new Pool({ connectionString: process.env.ALFRED_DATABASE_URL, max: 5 });
  return pool;
}
