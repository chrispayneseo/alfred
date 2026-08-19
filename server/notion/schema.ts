// Single source of truth for Notion property/select names, shared by the
// workspace setup script and the query layer so they can't drift apart.

export const TITLE_PROP = "Name";

export const INBOX_PROPS = {
  status: "Status",
  capturedVia: "Captured Via",
  emailLink: "Email Link",
} as const;

export const TASKS_PROPS = {
  status: "Status",
  dueDate: "Due Date",
  project: "Project",
  fromInbox: "From Inbox",
  emailLink: "Email Link",
  client: "Client",
  locationTrigger: "Location Trigger",
  locationTriggered: "Location Triggered",
} as const;

export const NOTES_PROPS = {
  project: "Project",
  fromInbox: "From Inbox",
  emailLink: "Email Link",
  client: "Client",
} as const;

// The Freelance client view (added alongside the "Client" select property
// on Tasks/Notes — see server/notion/addClientField.ts) is scoped to these
// three named clients specifically, not an open-ended list.
export const FREELANCE_CLIENTS = ["Active Health Hub", "Rafique Aesthetics", "Steadfast Collective"] as const;
export type FreelanceClient = (typeof FREELANCE_CLIENTS)[number];

export const PROJECTS_PROPS = {
  status: "Status",
} as const;

export const RECIPES_PROPS = {
  mealType: "Meal Type",
  cuisineType: "Cuisine/Type",
  prepTime: "Prep Time",
  cookTime: "Cook Time",
  source: "Source",
  ingredients: "Ingredients",
  method: "Method",
  tags: "Tags",
  rating: "Rating",
  category: "Category",
} as const;

export const MEAL_TYPES = ["Breakfast", "Lunch", "Dinner", "Snack", "Baking"] as const;
export type MealType = (typeof MEAL_TYPES)[number];

export const JOURNAL_PROPS = {
  date: "Date",
} as const;

export const INBOX_STATUS = { UNTRIAGED: "Untriaged", TRIAGED: "Triaged" } as const;
export const TASK_STATUS = { OPEN: "Open", DONE: "Done" } as const;
export const PROJECT_STATUS = { ACTIVE: "Active", PAUSED: "Paused", DONE: "Done" } as const;
export const CAPTURED_VIA = { MANUAL: "manual", SHARE_TARGET: "share-target", EMAIL: "email" } as const;

export const PROJECT_SEED_NAMES = ["Job", "Freelance", "Personal", "Football Coaching", "Unsorted"] as const;

// The weekly digest rolls up these five — everything except "Unsorted",
// which is a holding area rather than an active area of work.
export const DIGEST_PROJECTS = ["Job", "Freelance", "Personal", "Football Coaching", "Side Projects"] as const;
export const UNSORTED_PROJECT = "Unsorted";
export const GENEALOGY_PARENT_PROJECT = "Personal";

// Every project a capture can actually be classified into — PROJECT_SEED_NAMES
// above is specifically the one-time workspace-seeding list (predates "Side
// Projects", which was added later via a migration rather than a reseed) and
// was never the right constant for this; classify.ts previously used it by
// mistake, which meant a capture could never be classified into "Side
// Projects" even though the project has existed since the Freelance-view
// work.
export const CLASSIFY_PROJECT_NAMES = [...DIGEST_PROJECTS, UNSORTED_PROJECT] as const;
