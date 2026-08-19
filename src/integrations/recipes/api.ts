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
  category?: string;
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

export interface MealPlanCandidate {
  id: string;
  title: string;
  url: string;
  category?: string;
  cuisineType?: string;
  prepTime?: string;
  cookTime?: string;
}

export interface MealPlanDay {
  dayIndex: number;
  date: string;
  dayLabel: string;
  status: "pending" | "accepted" | "skipped";
  recipeTitle?: string;
  candidate?: MealPlanCandidate;
}

export interface MealPlanState {
  sessionId: string;
  status: "active" | "sent";
  days: MealPlanDay[];
  allResolved: boolean;
}

export interface MealPlanSendResult {
  ok: true;
  sentTo: string;
  mealCount: number;
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

/** The in-progress meal-plan session, if any — null if none is active. */
export function fetchCurrentMealPlan(): Promise<MealPlanState | null> {
  return request("/api/recipes/plan");
}

/** Starts a fresh rolling-week plan, superseding any other in-progress one. */
export function startMealPlan(): Promise<MealPlanState> {
  return request("/api/recipes/plan/start", { method: "POST" });
}

export function acceptMealPlanDay(sessionId: string): Promise<MealPlanState> {
  return request(`/api/recipes/plan/${sessionId}/accept`, { method: "POST" });
}

export function rejectMealPlanDay(sessionId: string): Promise<MealPlanState> {
  return request(`/api/recipes/plan/${sessionId}/reject`, { method: "POST" });
}

export function skipMealPlanDay(sessionId: string): Promise<MealPlanState> {
  return request(`/api/recipes/plan/${sessionId}/skip`, { method: "POST" });
}

export function sendMealPlan(sessionId: string): Promise<MealPlanSendResult> {
  return request(`/api/recipes/plan/${sessionId}/send`, { method: "POST" });
}
