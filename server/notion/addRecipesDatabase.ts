// One-off script: provisions the "Recipes" Notion database under the same
// parent page as everything else, for the weekly recipe suggestion email.
// Idempotent by convention with the other one-off scripts in this
// directory, though re-running would create a duplicate database (Notion
// has no natural "does this database already exist" check by name) — only
// run this once. Run with: npm run notion:add-recipes
import path from "node:path";
import { loadEnv } from "vite";
import type { Client } from "@notionhq/client";
import { createNotionClient } from "./client.js";
import { loadNotionEnv } from "./env.js";
import { updateEnvFile } from "../envFile.js";
import { MEAL_TYPES, RECIPES_PROPS, TITLE_PROP } from "./schema.js";

const title = (content: string) => [{ type: "text" as const, text: { content } }];

const MEAL_TYPE_COLORS: Record<(typeof MEAL_TYPES)[number], string> = {
  Dinner: "blue",
  Lunch: "green",
  Breakfast: "orange",
};

async function createDataSourceDb(notion: Client, parentPageId: string, name: string, properties: Record<string, unknown>): Promise<string> {
  const db = await notion.databases.create({
    parent: { type: "page_id", page_id: parentPageId },
    title: title(name),
    initial_data_source: { properties },
  } as never);
  if (!("data_sources" in db) || db.data_sources.length === 0) {
    throw new Error(`Created database "${name}" but got no data source back`);
  }
  return db.data_sources[0].id;
}

async function main() {
  const env = loadNotionEnv(loadEnv("development", process.cwd(), ""));
  if (!env.token) throw new Error("NOTION_TOKEN is missing from .env");
  if (!env.parentPageId) throw new Error("NOTION_PARENT_PAGE_ID is missing from .env");
  if (env.recipesDbId) {
    console.log("NOTION_RECIPES_DB_ID is already set — skipping (delete it from .env first if you really want to recreate the database).");
    return;
  }

  const notion = createNotionClient(env.token);

  console.log("Creating Recipes database...");
  const recipesId = await createDataSourceDb(notion, env.parentPageId, "Recipes", {
    [TITLE_PROP]: { title: {} },
    [RECIPES_PROPS.mealType]: {
      select: { options: MEAL_TYPES.map((name) => ({ name, color: MEAL_TYPE_COLORS[name] })) },
    },
  });

  const envPath = path.join(process.cwd(), ".env");
  updateEnvFile(envPath, { NOTION_RECIPES_DB_ID: recipesId });

  console.log("\nDone. Recipes data source ID written to .env:", recipesId);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
