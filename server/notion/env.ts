export interface NotionEnv {
  token: string;
  parentPageId: string;
  inboxDbId: string;
  tasksDbId: string;
  notesDbId: string;
  journalDbId: string;
  projectsDbId: string;
}

/** Takes a raw env source rather than loading one itself — see
 * google/env.ts for why (dev uses Vite's loadEnv(), prod uses process.env). */
export function loadNotionEnv(source: Record<string, string | undefined>): NotionEnv {
  return {
    token: source.NOTION_TOKEN ?? "",
    parentPageId: source.NOTION_PARENT_PAGE_ID ?? "",
    inboxDbId: source.NOTION_INBOX_DB_ID ?? "",
    tasksDbId: source.NOTION_TASKS_DB_ID ?? "",
    notesDbId: source.NOTION_NOTES_DB_ID ?? "",
    journalDbId: source.NOTION_JOURNAL_DB_ID ?? "",
    projectsDbId: source.NOTION_PROJECTS_DB_ID ?? "",
  };
}
