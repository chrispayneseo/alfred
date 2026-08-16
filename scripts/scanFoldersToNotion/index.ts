// One-off local script: scans ~/Documents and ~/Desktop, extracts readable
// text, classifies each document (excluding Future PLC/work content), and —
// after an interactive review checkpoint — files approved items as Notes in
// Alfred's existing Notion workspace. NOT part of the deployed app; run
// locally only, directly by you (the review prompts need your own judgment
// on work-vs-personal calls, not something to automate through).
//
// Run with: npx tsx scripts/scanFoldersToNotion/index.ts
import readline from "node:readline/promises";
import { loadEnv } from "vite";
import { createNotionClient } from "../../server/notion/client.js";
import { loadNotionEnv } from "../../server/notion/env.js";
import { NotionRepo } from "../../server/notion/queries.js";
import { FREELANCE_CLIENTS } from "../../server/notion/schema.js";
import { loadLlmEnv } from "../../server/llm/env.js";
import { discover, type Candidate } from "./discover.js";
import { extractText, type Extraction } from "./extract.js";
import { classifyDocument, type Classification } from "./classify.js";
import { createDocumentNote } from "./notionWrite.js";
import { loadProgress, recordProgress } from "./progress.js";

const PERSONAL_PROJECTS = ["Freelance", "Personal", "Side Projects", "Football Coaching"] as const;

interface ClassifiedItem {
  candidate: Candidate;
  extraction: Extraction;
  classification: Classification;
  flagReason?: string;
}

interface UnclassifiedItem {
  candidate: Candidate;
  reason: string;
}

async function main() {
  const envSource = loadEnv("development", process.cwd(), "");
  const notionEnv = loadNotionEnv(envSource);
  const llmEnv = loadLlmEnv(envSource);
  if (!notionEnv.token) throw new Error("NOTION_TOKEN is missing from .env");
  if (!notionEnv.notesDbId) throw new Error("NOTION_NOTES_DB_ID is missing from .env");
  if (!llmEnv.anthropicApiKey && !llmEnv.openaiApiKey) throw new Error("Neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set in .env");

  const notion = createNotionClient(notionEnv.token);
  const notionRepo = new NotionRepo(notion, notionEnv);
  const progress = await loadProgress();

  console.log("Scanning ~/Documents and ~/Desktop...");
  const { candidates, tally } = await discover();
  console.log(`Found ${candidates.length} candidate file(s) (${tally.clutterSkipped} clutter/system files and ${tally.mediaSkipped} media files skipped silently, never read).`);

  const alreadyDone = candidates.filter((c) => progress[c.absolutePath]);
  const toProcess = candidates.filter((c) => !progress[c.absolutePath]);
  if (alreadyDone.length > 0) console.log(`${alreadyDone.length} file(s) already filed in a previous run of this script — skipping.`);

  const textCandidates = toProcess.filter((c) => c.kind === "text");
  const otherCandidates = toProcess.filter((c) => c.kind !== "text");

  const excludedWork: Candidate[] = [];
  const classified: ClassifiedItem[] = [];
  const unclassified: UnclassifiedItem[] = otherCandidates.map((candidate) => ({
    candidate,
    reason: candidate.kind === "oversized" ? "file too large to process automatically (>25MB)" : "unsupported file format",
  }));

  console.log(`\nReading and classifying ${textCandidates.length} text-bearing file(s)...`);
  const queue = [...textCandidates];
  let done = 0;

  async function worker() {
    for (;;) {
      const candidate = queue.shift();
      if (!candidate) return;
      const extraction = await extractText(candidate);
      done++;
      if (done % 5 === 0 || done === textCandidates.length) process.stdout.write(`\r  ${done}/${textCandidates.length}`);
      if (!extraction.ok) {
        unclassified.push({ candidate, reason: extraction.reason });
        continue;
      }
      const classification = await classifyDocument(llmEnv, candidate, extraction.text, extraction.totalChars);
      if (!classification) {
        unclassified.push({ candidate, reason: "classification failed" });
        continue;
      }
      if (classification.verdict === "work_exclude") {
        excludedWork.push(candidate);
        continue;
      }
      const flagReason =
        classification.verdict === "unclear"
          ? classification.reason
          : classification.isNewClient
            ? `mentions a client not yet in Notion: "${classification.client}"`
            : undefined;
      classified.push({ candidate, extraction, classification, flagReason });
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log("");

  const flagged = classified.filter((i) => i.flagReason);
  const confident = classified.filter((i) => !i.flagReason);

  console.log("\n=== Summary ===");
  console.log(`Excluded as work-related: ${excludedWork.length}`);
  console.log(`Flagged for manual review: ${flagged.length + unclassified.length}`);
  console.log(`  - ambiguous / new client (will be reviewed interactively below): ${flagged.length}`);
  console.log(`  - images / unsupported formats / too large (not handled by this script — listed for you to check by hand): ${unclassified.length}`);
  console.log(`Ready to file with confident classification: ${confident.length}`);
  const byProject = new Map<string, number>();
  for (const i of confident) {
    const key = i.classification.project + (i.classification.client ? ` / ${i.classification.client}` : "");
    byProject.set(key, (byProject.get(key) ?? 0) + 1);
  }
  for (const [key, count] of byProject) console.log(`  - ${key}: ${count}`);

  if (excludedWork.length > 0) {
    console.log("\nExcluded as work-related (sanity-check these — nothing further happens to them):");
    for (const c of excludedWork) console.log(`  - ${c.relPath}`);
  }

  if (unclassified.length > 0) {
    console.log("\nNot handled by this script — check these by hand if relevant:");
    for (const { candidate, reason } of unclassified) console.log(`  - ${candidate.relPath} (${reason})`);
  }

  if (classified.length === 0) {
    console.log("\nNothing left to review or file. Done.");
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const projects = await notionRepo.listProjects();
  const projectIdByName = new Map(projects.map((p) => [p.name, p.id]));

  let filed = 0;
  let skipped = 0;
  let quit = false;
  let acceptAllRemaining = false;

  async function writeItem(item: ClassifiedItem): Promise<void> {
    let title = item.classification.suggestedTitle;
    if (item.classification.project === "Personal" && item.classification.genealogyRelated) title = `Genealogy: ${title}`;
    try {
      const { id, url } = await createDocumentNote(notion, notionEnv.notesDbId, projectIdByName, item.candidate, item.classification, title, item.extraction);
      await recordProgress(progress, item.candidate.absolutePath, { notionPageId: id, title, writtenAt: new Date().toISOString() });
      filed++;
      console.log(`  ✓ Filed: ${url}`);
    } catch (error) {
      console.log(`  ✗ Failed to write to Notion: ${error instanceof Error ? error.message : error}`);
    }
  }

  async function reviewItem(item: ClassifiedItem, forceExplicit: boolean): Promise<void> {
    const { candidate, classification, extraction } = item;
    console.log(`\n[${classification.project}${classification.client ? " / " + classification.client : ""}] ${candidate.relPath}`);
    if (item.flagReason) console.log(`  ⚠ ${item.flagReason}`);
    console.log(`  Title: ${classification.suggestedTitle}`);
    console.log(`  Preview: ${extraction.text.slice(0, 220).replace(/\n/g, " ")}...`);

    if (!forceExplicit && acceptAllRemaining) {
      await writeItem(item);
      return;
    }

    const prompt = forceExplicit
      ? "  [i]nclude  [s]kip  [e]dit project/client  [x] actually work — exclude  [q]uit: "
      : "  Enter=include  [s]kip  [e]dit  [a]ccept all remaining  [q]uit: ";
    const answer = (await rl.question(prompt)).trim().toLowerCase();

    if (answer === "q") {
      quit = true;
      return;
    }
    if (answer === "s") {
      skipped++;
      return;
    }
    if (answer === "x") {
      console.log("  Marked as work-related — not filed.");
      skipped++;
      return;
    }
    if (answer === "a" && !forceExplicit) {
      acceptAllRemaining = true;
      await writeItem(item);
      return;
    }
    if (answer === "e") {
      const newProject = (await rl.question(`  Project [${PERSONAL_PROJECTS.join("/")}] (Enter to keep "${classification.project}"): `)).trim();
      if (newProject && (PERSONAL_PROJECTS as readonly string[]).includes(newProject)) {
        classification.project = newProject as (typeof PERSONAL_PROJECTS)[number];
      } else if (newProject) {
        console.log(`  "${newProject}" isn't a valid project — keeping "${classification.project}".`);
      }
      const newClient = (await rl.question(`  Client (Enter to keep "${classification.client ?? "none"}", "none" to clear): `)).trim();
      if (newClient.toLowerCase() === "none") classification.client = null;
      else if (newClient) {
        classification.client = newClient;
        classification.isNewClient = !(FREELANCE_CLIENTS as readonly string[]).includes(newClient);
      }
      await writeItem(item);
      return;
    }
    if (forceExplicit && answer !== "i") {
      console.log("  Not understood — treating as skip.");
      skipped++;
      return;
    }
    await writeItem(item);
  }

  if (flagged.length > 0) {
    console.log(`\n--- Reviewing ${flagged.length} flagged item(s) — these need an explicit decision ---`);
    for (const item of flagged) {
      if (quit) break;
      await reviewItem(item, true);
    }
  }

  if (!quit && confident.length > 0) {
    console.log(`\n--- Reviewing ${confident.length} confidently-classified item(s) — Enter to accept, "a" to accept the rest at once ---`);
    for (const item of confident) {
      if (quit) break;
      await reviewItem(item, false);
    }
  }

  rl.close();
  console.log(`\n=== Done ===\nFiled: ${filed}  Skipped: ${skipped}${quit ? "  (stopped early — re-run the script to continue with what's left)" : ""}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
