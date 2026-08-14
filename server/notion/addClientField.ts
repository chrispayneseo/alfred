// One-off, idempotent migration for the Freelance client view: adds a
// "Client" select property (options = FREELANCE_CLIENTS) to Tasks and
// Notes, then tags the existing "Client — <name>" notes (created by
// seedBackground.ts) with their matching client. Run with:
// npx tsx server/notion/addClientField.ts
import { loadEnv } from "vite";
import type { Client } from "@notionhq/client";
import { createNotionClient } from "./client.js";
import { loadNotionEnv } from "./env.js";
import { FREELANCE_CLIENTS, NOTES_PROPS, TASKS_PROPS, TITLE_PROP } from "./schema.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDataSource = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPage = any;

async function ensureClientSelectOptions(notion: Client, dataSourceId: string, propName: string): Promise<void> {
  const ds = (await notion.dataSources.retrieve({ data_source_id: dataSourceId } as never)) as AnyDataSource;
  const existingProp = ds.properties?.[propName];
  const existingOptions: string[] = existingProp?.select?.options?.map((o: { name: string }) => o.name) ?? [];
  const missing = FREELANCE_CLIENTS.filter((name) => !existingOptions.includes(name));

  if (existingProp && missing.length === 0) {
    console.log(`  "${propName}" already has all client options — skipping`);
    return;
  }

  await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: { [propName]: { type: "select", select: { options: missing.map((name) => ({ name })) } } },
  } as never);
  console.log(existingProp ? `  added missing options to "${propName}": ${missing.join(", ")}` : `  created "${propName}"`);
}

function getTitleText(page: AnyPage): string {
  return (page.properties?.[TITLE_PROP]?.title ?? []).map((t: AnyPage) => t.plain_text).join("");
}

/** Tags the "Client — <name>" notes seedBackground.ts already created with
 * the matching Client select value, so the client view has real linked
 * data immediately rather than starting empty. */
async function tagExistingClientNotes(notion: Client, notesDbId: string): Promise<void> {
  const res = await notion.dataSources.query({ data_source_id: notesDbId } as never);
  for (const page of res.results as AnyPage[]) {
    const titleText = getTitleText(page);
    const match = FREELANCE_CLIENTS.find((c) => titleText === `Client — ${c}`);
    if (!match) continue;
    if (page.properties?.[NOTES_PROPS.client]?.select?.name === match) {
      console.log(`  "${titleText}" already tagged — skipping`);
      continue;
    }
    await notion.pages.update({
      page_id: page.id,
      properties: { [NOTES_PROPS.client]: { select: { name: match } } },
    } as never);
    console.log(`  tagged "${titleText}" -> ${match}`);
  }
}

async function main() {
  const env = loadNotionEnv(loadEnv("development", process.cwd(), ""));
  if (!env.token) throw new Error("NOTION_TOKEN is missing from .env");
  const notion = createNotionClient(env.token);

  console.log("Tasks...");
  await ensureClientSelectOptions(notion, env.tasksDbId, TASKS_PROPS.client);

  console.log("Notes...");
  await ensureClientSelectOptions(notion, env.notesDbId, NOTES_PROPS.client);

  console.log("Tagging existing client notes...");
  await tagExistingClientNotes(notion, env.notesDbId);

  console.log("\nDone.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
