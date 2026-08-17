export type MealType = "Dinner" | "Lunch" | "Breakfast";

export interface ApiRecipe {
  id: string;
  title: string;
  mealType: MealType;
  url: string;
}

export interface RecipeEmailResult {
  ok: true;
  sentTo: string;
  selection: Record<MealType, ApiRecipe[]>;
}

export interface RecipeExtraction {
  title: string;
  mealType: MealType | null;
  recipeText: string;
  sourceUrl: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  }
  return res.json();
}

export function fetchRecipes(): Promise<ApiRecipe[]> {
  return request("/api/recipes");
}

export function createRecipe(title: string, mealType: MealType, opts?: { sourceUrl?: string; bodyText?: string }): Promise<{ id: string }> {
  return request("/api/recipes", { method: "POST", body: JSON.stringify({ title, mealType, ...opts }) });
}

export async function deleteRecipe(recipeId: string): Promise<void> {
  await request(`/api/recipes/${recipeId}`, { method: "DELETE" });
}

/** Fetches a recipe webpage and returns the extracted title/meal-type
 * guess/recipe text — doesn't write anything to Notion itself, the caller
 * reviews the result and calls createRecipe to actually save it. */
export function extractRecipeFromUrl(url: string): Promise<RecipeExtraction> {
  return request("/api/recipes/extract", { method: "POST", body: JSON.stringify({ url }) });
}

/** Runs the same selection + email logic as the automatic Sunday-noon send,
 * immediately, to the same configured destination — see server/recipes/. */
export function generateRecipeSuggestions(): Promise<RecipeEmailResult> {
  return request("/api/recipes/generate", { method: "POST" });
}
