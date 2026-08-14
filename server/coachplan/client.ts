import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CoachPlanEnv } from "./env.js";

let client: SupabaseClient | undefined;
let cachedUrl: string | undefined;

/** Memoized per URL — same reasoning as every other client.ts in this repo
 * (Notion, Anthropic, OpenAI): avoid re-constructing on every call within a
 * warm serverless instance or long-lived dev process. Always built with the
 * publishable/anon key (see .env.example) — read-only by CoachPlan's own
 * Row Level Security, not just by convention in this codebase. */
export function getCoachPlanClient(env: CoachPlanEnv): SupabaseClient {
  if (!client || cachedUrl !== env.url) {
    client = createClient(env.url, env.key, { auth: { persistSession: false } });
    cachedUrl = env.url;
  }
  return client;
}
