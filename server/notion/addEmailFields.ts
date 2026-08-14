// One-off, idempotent migration for Step 5: adds an "Email Link" URL property
// to Inbox/Tasks/Notes, and an "email" option to Inbox's Captured Via select.
// Run with: npm run notion:add-email-fields
import { loadEnv } from "vite";
import type { Client } from "@notionhq/client";
import { createNotionClient } from "./client";
import { loadNotionEnv } from "./env";
import { CAPTURED_VIA, INBOX_PROPS, NOTES_PROPS, TASKS_PROPS } from "./schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDataSource = any;

async function ensureUrlProperty(notion: Client, dataSourceId: string, propName: string): Promise<void> {
  const ds = (await notion.dataSources.retrieve({ data_source_id: dataSourceId } as never)) as AnyDataSource;
  if (ds.properties?.[propName]) {
    console.log(`  "${propName}" already exists — skipping`);
    return;
  }
  await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: { [propName]: { type: "url", url: {} } },
  } as never);
  console.log(`  added "${propName}"`);
}

async function ensureSelectOption(notion: Client, dataSourceId: string, propName: string, optionName: string): Promise<void> {
  const ds = (await notion.dataSources.retrieve({ data_source_id: dataSourceId } as never)) as AnyDataSource;
  const existing: Array<{ name: string }> = ds.properties?.[propName]?.select?.options ?? [];
  if (existing.some((o) => o.name === optionName)) {
    console.log(`  "${propName}" already has option "${optionName}" — skipping`);
    return;
  }
  await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: { [propName]: { type: "select", select: { options: [{ name: optionName }] } } },
  } as never);
  console.log(`  added option "${optionName}" to "${propName}"`);
}

async function main() {
  const env = loadNotionEnv(loadEnv("development", process.cwd(), ""));
  if (!env.token) throw new Error("NOTION_TOKEN is missing from .env");
  const notion = createNotionClient(env.token);

  console.log("Inbox...");
  await ensureUrlProperty(notion, env.inboxDbId, INBOX_PROPS.emailLink);
  await ensureSelectOption(notion, env.inboxDbId, INBOX_PROPS.capturedVia, CAPTURED_VIA.EMAIL);

  console.log("Tasks...");
  await ensureUrlProperty(notion, env.tasksDbId, TASKS_PROPS.emailLink);

  console.log("Notes...");
  await ensureUrlProperty(notion, env.notesDbId, NOTES_PROPS.emailLink);

  console.log("\nDone.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
