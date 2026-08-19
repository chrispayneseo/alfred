// One-off, idempotent migration: adds a "Category" select property (the
// fixed DISH_CATEGORIES vocabulary — see server/recipes/dishCategories.ts)
// to the Recipes database, then classifies every recipe that doesn't have
// one set yet. Recipes the model can't confidently categorize are left
// blank — deliberately not guessed — and reported at the end for manual
// review in Notion. Safe to re-run: already-categorized recipes are
// skipped, so a second run only picks up ones still blank (e.g. new
// recipes added since, or ones you left blank on purpose). Run with:
// npx tsx server/notion/addRecipeCategory.ts
import { loadEnv } from "vite";
import { createNotionClient } from "./client.js";
import { loadNotionEnv } from "./env.js";
import { NotionRepo, type RecipeRecord } from "./queries.js";
import { RECIPES_PROPS } from "./schema.js";
import { loadLlmEnv } from "../llm/env.js";
import { routedComplete } from "../llm/routedComplete.js";
import { DISH_CATEGORIES, isDishCategory } from "../recipes/dishCategories.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDataSource = any;

const BATCH_SIZE = 25;
const CATEGORY_COLORS = [
  "red", "orange", "yellow", "green", "blue", "purple", "pink", "brown", "gray", "default",
];

async function ensureCategoryField(notion: ReturnType<typeof createNotionClient>, dataSourceId: string): Promise<void> {
  const ds = (await notion.dataSources.retrieve({ data_source_id: dataSourceId } as never)) as AnyDataSource;
  if (ds.properties?.[RECIPES_PROPS.category]) {
    console.log(`"${RECIPES_PROPS.category}" already exists — skipping field creation`);
    return;
  }
  await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: {
      [RECIPES_PROPS.category]: {
        select: { options: DISH_CATEGORIES.map((name, i) => ({ name, color: CATEGORY_COLORS[i % CATEGORY_COLORS.length] })) },
      },
    },
  } as never);
  console.log(`Added "${RECIPES_PROPS.category}" property with ${DISH_CATEGORIES.length} options.`);
}

const CLASSIFY_SYSTEM_PROMPT = `You classify recipes into a fixed dish-category vocabulary for a meal-planning app. Given a batch of recipes (title, cuisine/type notes, tags, and an ingredient snippet), assign each one exactly one category from this list: ${DISH_CATEGORIES.join(", ")}.

Use "other" only when genuinely nothing else fits. If you're not confident which category applies, set confident to false rather than guessing — a human will review those.

Respond with ONLY a JSON array (no markdown, no commentary), one entry per recipe in the same order given: [{"id": string, "category": string, "confident": boolean}, ...]`;

interface RawClassification {
  id: string;
  category: string;
  confident: boolean;
}

function isRawClassification(value: unknown): value is RawClassification {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.category === "string" && typeof v.confident === "boolean";
}

function parseJsonArrayLoose(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  const match = cleaned.match(/\[[\s\S]*\]/);
  return JSON.parse(match ? match[0] : cleaned);
}

function buildBatchText(batch: RecipeRecord[]): string {
  return batch
    .map((r) => {
      const ingredients = (r.ingredients ?? []).slice(0, 6).join("; ");
      return `id="${r.id}" title="${r.title}"${r.cuisineType ? ` cuisine="${r.cuisineType}"` : ""}${r.tags?.length ? ` tags=[${r.tags.join(", ")}]` : ""}${ingredients ? ` ingredients="${ingredients}"` : ""}`;
    })
    .join("\n");
}

async function main() {
  const rawEnv = loadEnv("development", process.cwd(), "");
  const notionEnv = loadNotionEnv(rawEnv);
  const llmEnv = loadLlmEnv(rawEnv);
  if (!notionEnv.token) throw new Error("NOTION_TOKEN is missing from .env");
  if (!notionEnv.recipesDbId) throw new Error("NOTION_RECIPES_DB_ID is missing from .env");
  const notion = createNotionClient(notionEnv.token);
  const repo = new NotionRepo(notion, notionEnv);

  console.log("Category field...");
  await ensureCategoryField(notion, notionEnv.recipesDbId);

  console.log("\nFetching recipes...");
  const all = await repo.listRecipes();
  const uncategorized = all.filter((r) => !r.category);
  console.log(`${all.length} total, ${uncategorized.length} without a category.`);
  if (uncategorized.length === 0) {
    console.log("Nothing to classify.");
    return;
  }

  const needsReview: string[] = [];
  let categorized = 0;

  for (let i = 0; i < uncategorized.length; i += BATCH_SIZE) {
    const batch = uncategorized.slice(i, i + BATCH_SIZE);
    console.log(`\nClassifying ${i + 1}-${i + batch.length} of ${uncategorized.length}...`);
    const userText = buildBatchText(batch);
    let raw: RawClassification[] = [];
    try {
      const result = await routedComplete(llmEnv, "recipe category classification", CLASSIFY_SYSTEM_PROMPT, userText, 3000, "claude-haiku-4-5");
      const parsed = parseJsonArrayLoose(result.text);
      if (Array.isArray(parsed)) raw = parsed.filter(isRawClassification);
    } catch (error) {
      console.error("  batch failed:", error);
      needsReview.push(...batch.map((r) => r.title));
      continue;
    }

    const byId = new Map(batch.map((r) => [r.id, r]));
    for (const item of raw) {
      const recipe = byId.get(item.id);
      if (!recipe) continue;
      byId.delete(item.id);
      if (!item.confident || !isDishCategory(item.category)) {
        needsReview.push(recipe.title);
        continue;
      }
      await notion.pages.update({
        page_id: recipe.id,
        properties: { [RECIPES_PROPS.category]: { select: { name: item.category } } },
      } as never);
      categorized++;
    }
    // Anything the model dropped from its response entirely
    for (const recipe of byId.values()) needsReview.push(recipe.title);
  }

  console.log(`\nDone. Categorized ${categorized}/${uncategorized.length}.`);
  if (needsReview.length > 0) {
    console.log(`\n${needsReview.length} recipe(s) need manual review (left blank in Notion):`);
    for (const title of needsReview) console.log(`  - ${title}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
