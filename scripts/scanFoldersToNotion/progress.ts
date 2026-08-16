// Write-through record of every file this script has already filed into
// Notion — checked on startup so re-running after a partial session (a "q"
// to quit, a crash, an interrupted terminal) never re-files the same file as
// a duplicate Note. Skipped/excluded decisions are deliberately NOT
// persisted here — only completed writes — so anything you skipped last
// time is simply asked about again, which is the safer default for a
// personal-review tool like this.
import fs from "node:fs/promises";
import path from "node:path";

const PROGRESS_PATH = path.join(import.meta.dirname, ".data", "progress.json");

export interface ProgressEntry {
  notionPageId: string;
  title: string;
  writtenAt: string;
}

export type ProgressMap = Record<string, ProgressEntry>;

export async function loadProgress(): Promise<ProgressMap> {
  try {
    const raw = await fs.readFile(PROGRESS_PATH, "utf8");
    return JSON.parse(raw) as ProgressMap;
  } catch {
    return {};
  }
}

export async function recordProgress(map: ProgressMap, absolutePath: string, entry: ProgressEntry): Promise<void> {
  map[absolutePath] = entry;
  await fs.mkdir(path.dirname(PROGRESS_PATH), { recursive: true });
  await fs.writeFile(PROGRESS_PATH, JSON.stringify(map, null, 2), "utf8");
}
