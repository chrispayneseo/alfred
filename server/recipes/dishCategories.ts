// The closed dish-category vocabulary, shared by the one-time Recipe Bank
// classification migration (server/notion/addRecipeCategory.ts) and the
// meal planner's candidate selection (planner.ts). A fixed enum, not
// freeform text — the planner does exact-match category exclusion
// ("no two curries in one plan"), which only works if the same dish always
// gets the same label.
export const DISH_CATEGORIES = [
  "curry",
  "soup",
  "stew-or-casserole",
  "pasta",
  "stir-fry",
  "salad",
  "roast",
  "traybake",
  "pizza",
  "sandwich-or-wrap",
  "rice-or-risotto",
  "noodles",
  "pie-or-bake",
  "grilled-or-bbq",
  "fritters-or-pancakes",
  "porridge-or-oats",
  "eggs",
  "baked-goods",
  "smoothie-or-drink",
  "other",
] as const;

export type DishCategory = (typeof DISH_CATEGORIES)[number];

export function isDishCategory(value: string): value is DishCategory {
  return (DISH_CATEGORIES as readonly string[]).includes(value);
}

type WeatherAffinity = "cold" | "warm" | "neutral";

/** Which weather a dish category reads as suited to — drives the meal
 * planner's deterministic (no LLM call per suggestion) weather weighting.
 * Categories that don't skew either way (pasta, traybake, ...) are
 * "neutral" and never penalized against either kind of day. */
export const CATEGORY_WEATHER_AFFINITY: Record<DishCategory, WeatherAffinity> = {
  curry: "cold",
  soup: "cold",
  "stew-or-casserole": "cold",
  "pie-or-bake": "cold",
  roast: "cold",
  salad: "warm",
  "grilled-or-bbq": "warm",
  "sandwich-or-wrap": "warm",
  "smoothie-or-drink": "warm",
  pasta: "neutral",
  "stir-fry": "neutral",
  traybake: "neutral",
  pizza: "neutral",
  "rice-or-risotto": "neutral",
  noodles: "neutral",
  "fritters-or-pancakes": "neutral",
  "porridge-or-oats": "neutral",
  eggs: "neutral",
  "baked-goods": "neutral",
  other: "neutral",
};
