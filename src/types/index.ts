export type ModelSource = "claude" | "chatgpt";
export type Confidence = "direct" | "inferred";

export interface EventProposal {
  title: string;
  date: string;
  startTime?: string;
  endTime?: string;
  account: string;
}

export type EventProposalStatus = "pending" | "created" | "cancelled" | "error";

export interface LocationReminderProposal {
  text: string;
  locationTrigger: string;
  project: string;
}

export type LocationReminderProposalStatus = "pending" | "created" | "cancelled" | "error";

export type MealType = "Breakfast" | "Lunch" | "Dinner" | "Snack" | "Baking";

export interface RecipeProposal {
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

export type RecipeProposalStatus = "pending" | "created" | "cancelled" | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  model?: ModelSource;
  confidence?: Confidence;
  note?: string;
  isError?: boolean;
  createdAt: string;
  eventProposal?: EventProposal;
  eventProposalStatus?: EventProposalStatus;
  eventProposalError?: string;
  locationReminderProposal?: LocationReminderProposal;
  locationReminderProposalStatus?: LocationReminderProposalStatus;
  locationReminderProposalError?: string;
  recipeProposal?: RecipeProposal;
  recipeProposalStatus?: RecipeProposalStatus;
  recipeProposalError?: string;
  /** Editable meal-type pick shown alongside the proposal card — starts at
   * the extracted guess (or "Dinner" if the extraction couldn't tell), but
   * the user can correct it before confirming. */
  recipeProposalMealType?: MealType;
}
