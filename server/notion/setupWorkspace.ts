// One-off script that provisions the Alfred Notion workspace structure.
// Run with: npm run notion:setup
//
// Note: this targets Notion's multi-source-database API. Every "database"
// we create has exactly one data source, and it's that data source's id
// (not the outer database id) that relations, page creation, and queries
// all key off — see server/notion/env.ts.
import path from "node:path";
import type { Client } from "@notionhq/client";
import { createNotionClient } from "./client";
import { loadNotionEnv } from "./env";
import { updateEnvFile } from "./envFile";
import {
  GENEALOGY_PARENT_PROJECT,
  INBOX_PROPS,
  INBOX_STATUS,
  JOURNAL_PROPS,
  NOTES_PROPS,
  PROJECTS_PROPS,
  PROJECT_SEED_NAMES,
  PROJECT_STATUS,
  TASKS_PROPS,
  TASK_STATUS,
  TITLE_PROP,
} from "./schema";

const title = (content: string) => [{ type: "text" as const, text: { content } }];

async function createDataSourceDb(
  notion: Client,
  parentPageId: string,
  name: string,
  properties: Record<string, unknown>
): Promise<string> {
  const db = await notion.databases.create({
    parent: { type: "page_id", page_id: parentPageId },
    title: title(name),
    initial_data_source: { properties },
  } as never);
  if (!("data_sources" in db) || db.data_sources.length === 0) {
    throw new Error(`Created database "${name}" but got no data source back`);
  }
  return db.data_sources[0].id;
}

async function main() {
  const env = loadNotionEnv();
  if (!env.token) throw new Error("NOTION_TOKEN is missing from .env");
  if (!env.parentPageId) throw new Error("NOTION_PARENT_PAGE_ID is missing from .env");

  const notion = createNotionClient(env.token);

  console.log("Creating Projects database...");
  const projectsId = await createDataSourceDb(notion, env.parentPageId, "Projects", {
    [TITLE_PROP]: { title: {} },
    [PROJECTS_PROPS.status]: {
      select: {
        options: [
          { name: PROJECT_STATUS.ACTIVE, color: "green" },
          { name: PROJECT_STATUS.PAUSED, color: "yellow" },
          { name: PROJECT_STATUS.DONE, color: "gray" },
        ],
      },
    },
  });

  console.log("Creating Inbox database...");
  const inboxId = await createDataSourceDb(notion, env.parentPageId, "Inbox", {
    [TITLE_PROP]: { title: {} },
    [INBOX_PROPS.status]: {
      select: {
        options: [
          { name: INBOX_STATUS.UNTRIAGED, color: "orange" },
          { name: INBOX_STATUS.TRIAGED, color: "gray" },
        ],
      },
    },
    [INBOX_PROPS.capturedVia]: {
      select: {
        options: [
          { name: "manual", color: "blue" },
          { name: "share-target", color: "purple" },
        ],
      },
    },
  });

  console.log("Creating Tasks database...");
  const tasksId = await createDataSourceDb(notion, env.parentPageId, "Tasks", {
    [TITLE_PROP]: { title: {} },
    [TASKS_PROPS.status]: {
      select: {
        options: [
          { name: TASK_STATUS.OPEN, color: "blue" },
          { name: TASK_STATUS.DONE, color: "green" },
        ],
      },
    },
    [TASKS_PROPS.dueDate]: { date: {} },
    [TASKS_PROPS.project]: {
      relation: {
        data_source_id: projectsId,
        type: "dual_property",
        dual_property: { synced_property_name: "Tasks" },
      },
    },
    [TASKS_PROPS.fromInbox]: {
      relation: {
        data_source_id: inboxId,
        type: "dual_property",
        dual_property: { synced_property_name: "Linked Task" },
      },
    },
  });

  console.log("Creating Notes database...");
  const notesId = await createDataSourceDb(notion, env.parentPageId, "Notes", {
    [TITLE_PROP]: { title: {} },
    [NOTES_PROPS.project]: {
      relation: {
        data_source_id: projectsId,
        type: "dual_property",
        dual_property: { synced_property_name: "Notes" },
      },
    },
    [NOTES_PROPS.fromInbox]: {
      relation: {
        data_source_id: inboxId,
        type: "dual_property",
        dual_property: { synced_property_name: "Linked Note" },
      },
    },
  });

  console.log("Creating Journal database...");
  const journalId = await createDataSourceDb(notion, env.parentPageId, "Journal", {
    [TITLE_PROP]: { title: {} },
    [JOURNAL_PROPS.date]: { date: {} },
  });

  console.log("Seeding Projects...");
  let personalPageId: string | undefined;
  for (const name of PROJECT_SEED_NAMES) {
    const page = await notion.pages.create({
      parent: { type: "data_source_id", data_source_id: projectsId },
      properties: {
        [TITLE_PROP]: { title: title(name) },
        [PROJECTS_PROPS.status]: { select: { name: PROJECT_STATUS.ACTIVE } },
      },
    } as never);
    if (name === GENEALOGY_PARENT_PROJECT) personalPageId = page.id;
  }

  if (personalPageId) {
    console.log("Creating Genealogy page under Personal...");
    await notion.pages.create({
      parent: { type: "page_id", page_id: personalPageId },
      properties: { title: title("Genealogy") },
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: { content: "Placeholder area for genealogy notes — wired up in a later step." },
              },
            ],
          },
        },
      ],
    } as never);
  }

  const envPath = path.join(process.cwd(), ".env");
  updateEnvFile(envPath, {
    NOTION_PROJECTS_DB_ID: projectsId,
    NOTION_INBOX_DB_ID: inboxId,
    NOTION_TASKS_DB_ID: tasksId,
    NOTION_NOTES_DB_ID: notesId,
    NOTION_JOURNAL_DB_ID: journalId,
  });

  console.log("\nDone. Data source IDs written to .env:");
  console.log({ projects: projectsId, inbox: inboxId, tasks: tasksId, notes: notesId, journal: journalId });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
