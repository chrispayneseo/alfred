// One-off, idempotent migration: adds the structured recipe fields
// (Cuisine/Type, Prep Time, Cook Time, Source, Ingredients, Method, Tags)
// to the Recipes database, and adds "Snack"/"Baking" as Meal Type options
// alongside the existing Breakfast/Lunch/Dinner. Run with:
// npx tsx server/notion/addRecipeFields.ts
import { loadEnv } from "vite";
import type { Client } from "@notionhq/client";
import { createNotionClient } from "./client.js";
import { loadNotionEnv } from "./env.js";
import { MEAL_TYPES, RECIPES_PROPS } from "./schema.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDataSource = any;

const NEW_MEAL_TYPE_COLORS: Record<string, string> = { Snack: "yellow", Baking: "pink" };

async function ensureMealTypeOptions(notion: Client, dataSourceId: string): Promise<void> {
  const ds = (await notion.dataSources.retrieve({ data_source_id: dataSourceId } as never)) as AnyDataSource;
  const existingOptions: string[] = ds.properties?.[RECIPES_PROPS.mealType]?.select?.options?.map((o: { name: string }) => o.name) ?? [];
  const missing = MEAL_TYPES.filter((name) => !existingOptions.includes(name));
  if (missing.length === 0) {
    console.log(`  "${RECIPES_PROPS.mealType}" already has all meal types — skipping`);
    return;
  }
  await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: { [RECIPES_PROPS.mealType]: { select: { options: missing.map((name) => ({ name, color: NEW_MEAL_TYPE_COLORS[name] })) } } },
  } as never);
  console.log(`  added meal type options: ${missing.join(", ")}`);
}

async function ensureStructuredFields(notion: Client, dataSourceId: string): Promise<void> {
  const ds = (await notion.dataSources.retrieve({ data_source_id: dataSourceId } as never)) as AnyDataSource;
  const properties: Record<string, unknown> = {};

  if (!ds.properties?.[RECIPES_PROPS.cuisineType]) properties[RECIPES_PROPS.cuisineType] = { rich_text: {} };
  if (!ds.properties?.[RECIPES_PROPS.prepTime]) properties[RECIPES_PROPS.prepTime] = { rich_text: {} };
  if (!ds.properties?.[RECIPES_PROPS.cookTime]) properties[RECIPES_PROPS.cookTime] = { rich_text: {} };
  if (!ds.properties?.[RECIPES_PROPS.source]) properties[RECIPES_PROPS.source] = { url: {} };
  if (!ds.properties?.[RECIPES_PROPS.ingredients]) properties[RECIPES_PROPS.ingredients] = { rich_text: {} };
  if (!ds.properties?.[RECIPES_PROPS.method]) properties[RECIPES_PROPS.method] = { rich_text: {} };
  if (!ds.properties?.[RECIPES_PROPS.tags]) properties[RECIPES_PROPS.tags] = { multi_select: { options: [] } };

  if (Object.keys(properties).length === 0) {
    console.log("  all structured fields already exist — skipping");
    return;
  }

  await notion.dataSources.update({ data_source_id: dataSourceId, properties } as never);
  console.log(`  added properties: ${Object.keys(properties).join(", ")}`);
}

async function main() {
  const env = loadNotionEnv(loadEnv("development", process.cwd(), ""));
  if (!env.token) throw new Error("NOTION_TOKEN is missing from .env");
  if (!env.recipesDbId) throw new Error("NOTION_RECIPES_DB_ID is missing from .env — run notion:add-recipes first");
  const notion = createNotionClient(env.token);

  console.log("Meal Type options...");
  await ensureMealTypeOptions(notion, env.recipesDbId);

  console.log("Structured fields...");
  await ensureStructuredFields(notion, env.recipesDbId);

  console.log("\nDone.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
