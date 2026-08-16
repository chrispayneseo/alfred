// Creates the actual Notion Note page for an approved item. Deliberately
// separate from server/notion/queries.ts's fileClassifiedItem() — that
// function only ever sets the title property (the capture text goes in the
// page *title*, never the body), which is fine for short captures but wrong
// here: the user explicitly wants the extracted document text readable in
// the page body, not crammed into a title field.
import type { Client } from "@notionhq/client";
import { FREELANCE_CLIENTS, NOTES_PROPS, TITLE_PROP } from "../../server/notion/schema.js";
import type { Candidate } from "./discover.js";
import type { Classification } from "./classify.js";

const richText = (content: string) => [{ type: "text" as const, text: { content } }];

// Notion caps a single rich_text segment at 2000 characters and a single
// pages.create/blocks.append call at 100 blocks — chunk the body into
// paragraph blocks under both limits, appending in further batches of 100
// for anything longer (a big document body easily exceeds one call's worth).
const CHARS_PER_BLOCK = 1800;
const BLOCKS_PER_CALL = 100;

function paragraphBlocks(text: string): unknown[] {
  const blocks: unknown[] = [];
  for (let i = 0; i < text.length; i += CHARS_PER_BLOCK) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: richText(text.slice(i, i + CHARS_PER_BLOCK)) },
    });
  }
  return blocks;
}

function sourceReferenceBlock(absolutePath: string, truncated: boolean, totalChars: number): unknown {
  const note = truncated ? ` (content truncated below — showing the first ${totalChars.toLocaleString()} characters' worth)` : "";
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: `📁 Source: ${absolutePath}${note}` }, annotations: { italic: true } }],
    },
  };
}

async function appendInBatches(notion: Client, pageId: string, blocks: unknown[]): Promise<void> {
  for (let i = 0; i < blocks.length; i += BLOCKS_PER_CALL) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: blocks.slice(i, i + BLOCKS_PER_CALL),
    } as never);
  }
}

export interface NoteBody {
  text: string;
  truncated: boolean;
  totalChars: number;
}

export async function createDocumentNote(
  notion: Client,
  notesDbId: string,
  projectIdByName: Map<string, string>,
  candidate: Candidate,
  classification: Classification,
  title: string,
  body: NoteBody
): Promise<{ id: string; url: string }> {
  const projectId = classification.project ? projectIdByName.get(classification.project) : undefined;
  const clientProp =
    classification.client && !classification.isNewClient && (FREELANCE_CLIENTS as readonly string[]).includes(classification.client)
      ? { [NOTES_PROPS.client]: { select: { name: classification.client } } }
      : {};

  const allBlocks = [sourceReferenceBlock(candidate.absolutePath, body.truncated, body.totalChars), ...paragraphBlocks(body.text)];
  const firstBatch = allBlocks.slice(0, BLOCKS_PER_CALL);
  const rest = allBlocks.slice(BLOCKS_PER_CALL);

  const page = await notion.pages.create({
    parent: { type: "data_source_id", data_source_id: notesDbId },
    properties: {
      [TITLE_PROP]: { title: richText(title) },
      ...(projectId ? { [NOTES_PROPS.project]: { relation: [{ id: projectId }] } } : {}),
      ...clientProp,
    },
    children: firstBatch,
  } as never);

  if (rest.length > 0) await appendInBatches(notion, page.id, rest);

  const url = "url" in page && typeof page.url === "string" ? page.url : `https://notion.so/${page.id.replace(/-/g, "")}`;
  return { id: page.id, url };
}
