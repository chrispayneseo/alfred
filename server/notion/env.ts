import { loadEnv } from "vite";

export interface NotionEnv {
  token: string;
  parentPageId: string;
  inboxDbId: string;
  tasksDbId: string;
  notesDbId: string;
  journalDbId: string;
  projectsDbId: string;
}

export function loadNotionEnv(): NotionEnv {
  const env = loadEnv("development", process.cwd(), "");
  return {
    token: env.NOTION_TOKEN ?? "",
    parentPageId: env.NOTION_PARENT_PAGE_ID ?? "",
    inboxDbId: env.NOTION_INBOX_DB_ID ?? "",
    tasksDbId: env.NOTION_TASKS_DB_ID ?? "",
    notesDbId: env.NOTION_NOTES_DB_ID ?? "",
    journalDbId: env.NOTION_JOURNAL_DB_ID ?? "",
    projectsDbId: env.NOTION_PROJECTS_DB_ID ?? "",
  };
}
