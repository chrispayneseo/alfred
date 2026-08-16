// Pulls plain text out of a Candidate for Notion filing + classification.
// Never throws — extraction failures downgrade the file to "unsupported" so
// the interactive review can flag it instead of crashing the whole scan.
import fs from "node:fs/promises";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import type { Candidate } from "./discover.js";

const MIN_MEANINGFUL_CHARS = 20;
// A hard ceiling on how much of a single document gets written into its
// Notion page body — protects against a pathological giant text/CSV dump
// turning into a many-hundred-block page. The source file path is always
// included, so nothing is actually lost, just not mirrored in full.
const MAX_NOTE_CHARS = 100_000;

export interface Extraction {
  ok: true;
  text: string; // full text, capped at MAX_NOTE_CHARS (for the Notion body)
  truncated: boolean;
  totalChars: number; // untruncated length, for display
}

export interface ExtractionFailure {
  ok: false;
  reason: string;
}

/** Best-effort RTF control-word stripper — not a real RTF parser, just
 * enough to get readable text out of simple RTF files (TextEdit's default
 * "Rich Text" save format, most commonly). */
function stripRtf(raw: string): string {
  return raw
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "")
    .replace(/\\'\w\w/g, "")
    .trim();
}

async function extractRaw(candidate: Candidate): Promise<string> {
  switch (candidate.ext) {
    case ".pdf": {
      const buffer = await fs.readFile(candidate.absolutePath);
      const parser = new PDFParse({ data: buffer });
      try {
        return (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
    }
    case ".docx": {
      const result = await mammoth.extractRawText({ path: candidate.absolutePath });
      return result.value;
    }
    case ".rtf":
      return stripRtf(await fs.readFile(candidate.absolutePath, "utf8"));
    default:
      return fs.readFile(candidate.absolutePath, "utf8");
  }
}

export async function extractText(candidate: Candidate): Promise<Extraction | ExtractionFailure> {
  try {
    const raw = (await extractRaw(candidate)).replace(/\r\n/g, "\n").trim();
    if (raw.replace(/\s/g, "").length < MIN_MEANINGFUL_CHARS) {
      return { ok: false, reason: "no extractable text found" };
    }
    const truncated = raw.length > MAX_NOTE_CHARS;
    return { ok: true, text: truncated ? raw.slice(0, MAX_NOTE_CHARS) : raw, truncated, totalChars: raw.length };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "extraction failed" };
  }
}
