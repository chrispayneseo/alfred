export type MealType = "Breakfast" | "Lunch" | "Dinner" | "Snack" | "Baking";

export interface ApiRecipe {
  id: string;
  title: string;
  mealType: MealType;
  url: string;
  cuisineType?: string;
  prepTime?: string;
  cookTime?: string;
  sourceUrl?: string;
  ingredients?: string[];
  method?: string;
  tags?: string[];
  rating?: number;
}

export interface RecipeEmailResult {
  ok: true;
  sentTo: string;
  selection: Record<MealType, ApiRecipe[]>;
}

export interface RecipeExtraction {
  title: string;
  cuisineType: string | null;
  mealType: MealType | null;
  prepTime: string | null;
  cookTime: string | null;
  ingredients: string[];
  method: string;
  tags: string[];
  sourceUrl: string;
}

export interface RecipeDetails {
  cuisineType?: string | null;
  prepTime?: string | null;
  cookTime?: string | null;
  sourceUrl?: string;
  ingredients?: string[];
  method?: string;
  tags?: string[];
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

export function createRecipe(title: string, mealType: MealType, details?: RecipeDetails): Promise<{ id: string }> {
  return request("/api/recipes", { method: "POST", body: JSON.stringify({ title, mealType, ...details }) });
}

export async function deleteRecipe(recipeId: string): Promise<void> {
  await request(`/api/recipes/${recipeId}`, { method: "DELETE" });
}

export async function restoreRecipe(recipeId: string): Promise<void> {
  await request(`/api/recipes/${recipeId}/restore`, { method: "PATCH" });
}

/** `rating` is 1-5, or `null` to clear it. */
export async function setRecipeRating(recipeId: string, rating: number | null): Promise<void> {
  await request(`/api/recipes/${recipeId}/rating`, { method: "PATCH", body: JSON.stringify({ rating }) });
}

/** Fetches a recipe webpage and returns the extracted structured recipe
 * data — doesn't write anything to Notion itself, the caller reviews the
 * result and calls createRecipe to actually save it. */
export function extractRecipeFromUrl(url: string): Promise<RecipeExtraction> {
  return request("/api/recipes/extract", { method: "POST", body: JSON.stringify({ url }) });
}

/** Runs the same selection + email logic as the automatic Sunday-noon send,
 * immediately, to the same configured destination — see server/recipes/. */
export function generateRecipeSuggestions(): Promise<RecipeEmailResult> {
  return request("/api/recipes/generate", { method: "POST" });
}
