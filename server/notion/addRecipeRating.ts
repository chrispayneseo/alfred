// One-off, idempotent migration: adds a "Rating" (1-5, plain number)
// property to the Recipes database. Run with:
// npx tsx server/notion/addRecipeRating.ts
import { loadEnv } from "vite";
import { createNotionClient } from "./client.js";
import { loadNotionEnv } from "./env.js";
import { RECIPES_PROPS } from "./schema.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDataSource = any;

async function main() {
  const env = loadNotionEnv(loadEnv("development", process.cwd(), ""));
  if (!env.token) throw new Error("NOTION_TOKEN is missing from .env");
  if (!env.recipesDbId) throw new Error("NOTION_RECIPES_DB_ID is missing from .env");
  const notion = createNotionClient(env.token);

  const ds = (await notion.dataSources.retrieve({ data_source_id: env.recipesDbId } as never)) as AnyDataSource;
  if (ds.properties?.[RECIPES_PROPS.rating]) {
    console.log(`"${RECIPES_PROPS.rating}" already exists — skipping`);
    return;
  }

  await notion.dataSources.update({
    data_source_id: env.recipesDbId,
    properties: { [RECIPES_PROPS.rating]: { number: { format: "number" } } },
  } as never);
  console.log(`Added "${RECIPES_PROPS.rating}" property.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
