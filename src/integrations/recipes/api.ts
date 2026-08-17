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

export function createRecipe(title: string, mealType: MealType): Promise<{ id: string }> {
  return request("/api/recipes", { method: "POST", body: JSON.stringify({ title, mealType }) });
}

export async function deleteRecipe(recipeId: string): Promise<void> {
  await request(`/api/recipes/${recipeId}`, { method: "DELETE" });
}

/** Runs the same selection + email logic as the automatic Sunday-noon send,
 * immediately, to the same configured destination — see server/recipes/. */
export function generateRecipeSuggestions(): Promise<RecipeEmailResult> {
  return request("/api/recipes/generate", { method: "POST" });
}
