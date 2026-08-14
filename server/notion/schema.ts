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
} as const;

export const NOTES_PROPS = {
  project: "Project",
  fromInbox: "From Inbox",
  emailLink: "Email Link",
} as const;

export const PROJECTS_PROPS = {
  status: "Status",
} as const;

export const JOURNAL_PROPS = {
  date: "Date",
} as const;

export const INBOX_STATUS = { UNTRIAGED: "Untriaged", TRIAGED: "Triaged" } as const;
export const TASK_STATUS = { OPEN: "Open", DONE: "Done" } as const;
export const PROJECT_STATUS = { ACTIVE: "Active", PAUSED: "Paused", DONE: "Done" } as const;
export const CAPTURED_VIA = { MANUAL: "manual", SHARE_TARGET: "share-target", EMAIL: "email" } as const;

export const PROJECT_SEED_NAMES = ["Job", "Freelance", "Personal", "Football Coaching", "Unsorted"] as const;
export const UNSORTED_PROJECT = "Unsorted";
export const GENEALOGY_PARENT_PROJECT = "Personal";
