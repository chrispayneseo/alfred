import { Client } from "@notionhq/client";

export function createNotionClient(token: string): Client {
  if (!token) {
    throw new Error("NOTION_TOKEN is not set — add it to .env before making Notion API calls.");
  }
  return new Client({ auth: token });
}
