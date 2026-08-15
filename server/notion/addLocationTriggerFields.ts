// One-off, idempotent migration for location-tagged reminders: adds a
// "Location Trigger" rich_text property (the free-form place name, e.g.
// "home" or "the sports ground") and a "Location Triggered" checkbox
// (flips true once the webhook has fired the reminder, so it's a one-shot
// per Task) to the Tasks database only — location reminders are always
// Tasks, never Notes. Run with: npx tsx server/notion/addLocationTriggerFields.ts
import { loadEnv } from "vite";
import type { Client } from "@notionhq/client";
import { createNotionClient } from "./client.js";
import { loadNotionEnv } from "./env.js";
import { TASKS_PROPS } from "./schema.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDataSource = any;

async function ensureRichTextProperty(notion: Client, dataSourceId: string, propName: string): Promise<void> {
  const ds = (await notion.dataSources.retrieve({ data_source_id: dataSourceId } as never)) as AnyDataSource;
  if (ds.properties?.[propName]) {
    console.log(`  "${propName}" already exists — skipping`);
    return;
  }
  await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: { [propName]: { type: "rich_text", rich_text: {} } },
  } as never);
  console.log(`  added "${propName}"`);
}

async function ensureCheckboxProperty(notion: Client, dataSourceId: string, propName: string): Promise<void> {
  const ds = (await notion.dataSources.retrieve({ data_source_id: dataSourceId } as never)) as AnyDataSource;
  if (ds.properties?.[propName]) {
    console.log(`  "${propName}" already exists — skipping`);
    return;
  }
  await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: { [propName]: { type: "checkbox", checkbox: {} } },
  } as never);
  console.log(`  added "${propName}"`);
}

async function main() {
  const env = loadNotionEnv(loadEnv("development", process.cwd(), ""));
  if (!env.token) throw new Error("NOTION_TOKEN is missing from .env");
  const notion = createNotionClient(env.token);

  console.log("Tasks...");
  await ensureRichTextProperty(notion, env.tasksDbId, TASKS_PROPS.locationTrigger);
  await ensureCheckboxProperty(notion, env.tasksDbId, TASKS_PROPS.locationTriggered);

  console.log("\nDone.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
