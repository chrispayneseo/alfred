// Walks ~/Documents and ~/Desktop, sorting every file into a bucket before
// anything is read or extracted — clutter/media get skipped without ever
// being opened; everything else becomes a Candidate for extract.ts/classify.ts.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SCAN_ROOTS = [path.join(os.homedir(), "Documents"), path.join(os.homedir(), "Desktop")];

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB

const CLUTTER_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "__pycache__",
  ".cache",
  ".trash",
  ".trashes",
  "dist",
  "build",
  ".next",
  ".venv",
  "venv",
  ".pytest_cache",
  ".vscode",
  ".idea",
]);

const CLUTTER_FILE_NAMES = new Set(["thumbs.db", "desktop.ini", "icon\r"]);

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".rtf"]);
const PDF_EXTENSION = ".pdf";
const DOCX_EXTENSION = ".docx";
// .xlsx/.xls are flagged rather than parsed — the only maintained parser
// (xlsx/SheetJS) has an unpatched high-severity vuln (prototype pollution +
// ReDoS), not worth adding for a one-off script.
const UNSUPPORTED_FORMAT_EXTENSIONS = new Set([".doc", ".pages", ".numbers", ".key", ".odt", ".ods", ".xlsx", ".xls", ".zip", ".dmg", ".pkg"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif", ".gif", ".tiff", ".tif", ".bmp"]);
const MEDIA_SKIP_EXTENSIONS = new Set([".mp4", ".mov", ".mp3", ".wav", ".m4a", ".avi", ".mkv", ".flac", ".aiff", ".m4v"]);

// Screenshots/thumbnails/icons are near-certainly not genealogy material —
// silently skipped rather than flagged, so the image-review bucket stays
// meaningful instead of drowning in UI screenshots. A generic "IMG_1234.jpg"
// is deliberately NOT filtered here — that's exactly the filename an old
// scanned family photo would have.
const IMAGE_CLUTTER_NAME_RE = /^(screenshot|screen shot|favicon|logo(?!.*(family|tree|census))|thumbs?\b)/i;

export type CandidateKind = "text" | "unsupported-format" | "image" | "oversized";

export interface Candidate {
  absolutePath: string;
  relPath: string; // relative to $HOME, for display
  ext: string;
  sizeBytes: number;
  kind: CandidateKind;
}

export interface ScanTally {
  clutterSkipped: number;
  mediaSkipped: number;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // permission-denied or vanished mid-scan — just skip it
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // dotfiles/dotdirs — .git, .DS_Store, .cache, etc.
    if (entry.isSymbolicLink()) continue; // avoid loops / escaping the scan roots
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (CLUTTER_DIR_NAMES.has(entry.name.toLowerCase())) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function classifyKind(ext: string, sizeBytes: number, baseName: string): CandidateKind | "clutter" | "media" | null {
  if (sizeBytes > MAX_FILE_BYTES) return "oversized";
  if (TEXT_EXTENSIONS.has(ext) || ext === PDF_EXTENSION || ext === DOCX_EXTENSION) return "text";
  if (UNSUPPORTED_FORMAT_EXTENSIONS.has(ext)) return "unsupported-format";
  if (IMAGE_EXTENSIONS.has(ext)) return IMAGE_CLUTTER_NAME_RE.test(baseName) ? "clutter" : "image";
  if (MEDIA_SKIP_EXTENSIONS.has(ext)) return "media";
  return null; // unrecognized extension (code files, configs, etc.) — treated as clutter
}

// roots defaults to SCAN_ROOTS (~/Documents, ~/Desktop) — overridable so a
// verification pass can point this at a synthetic scratch directory instead
// of the real filesystem.
export async function discover(roots: string[] = SCAN_ROOTS): Promise<{ candidates: Candidate[]; tally: ScanTally }> {
  const home = os.homedir();
  const candidates: Candidate[] = [];
  const tally: ScanTally = { clutterSkipped: 0, mediaSkipped: 0 };

  for (const root of roots) {
    for await (const absolutePath of walk(root)) {
      const baseName = path.basename(absolutePath);
      if (CLUTTER_FILE_NAMES.has(baseName.toLowerCase())) {
        tally.clutterSkipped++;
        continue;
      }
      const ext = path.extname(absolutePath).toLowerCase();
      let sizeBytes: number;
      try {
        sizeBytes = (await fs.stat(absolutePath)).size;
      } catch {
        continue; // vanished between readdir and stat
      }
      const kind = classifyKind(ext, sizeBytes, baseName);
      if (kind === null || kind === "clutter") {
        tally.clutterSkipped++;
        continue;
      }
      if (kind === "media") {
        tally.mediaSkipped++;
        continue;
      }
      candidates.push({ absolutePath, relPath: path.relative(home, absolutePath), ext, sizeBytes, kind });
    }
  }

  return { candidates, tally };
}
