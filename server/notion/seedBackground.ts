// One-off data-population script — NOT part of the app itself, not wired
// into any route or build step. Populates the Notion workspace with
// detailed background-context Notes (tagged to Projects) so Chat/Q&A and
// the daily briefing have real substance to draw on from day one, instead
// of starting from an empty workspace.
//
// Run once with: npx tsx server/notion/seedBackground.ts
//
// Idempotency: re-running will create duplicate Notes (it doesn't check for
// existing ones by title) — safe to run again for content edits, but delete
// the previous batch first if you don't want doubles. Projects ARE looked
// up by name first, so re-running won't create duplicate "Side Projects"
// etc.
import { loadEnv } from "vite";
import type { Client } from "@notionhq/client";
import { createNotionClient } from "./client.js";
import { loadNotionEnv } from "./env.js";
import { NOTES_PROPS, PROJECTS_PROPS, PROJECT_STATUS, TITLE_PROP } from "./schema.js";

const title = (content: string) => [{ type: "text" as const, text: { content } }];

const bulletBlock = (content: string) => ({
  object: "block" as const,
  type: "bulleted_list_item" as const,
  bulleted_list_item: { rich_text: [{ type: "text" as const, text: { content } }] },
});

interface NoteSeed {
  title: string;
  bullets: string[];
}

interface ProjectSeed {
  project: string;
  notes: NoteSeed[];
}

const SEED: ProjectSeed[] = [
  {
    project: "Job",
    notes: [
      {
        title: "Role & Team Context",
        bullets: [
          "Technical SEO Manager at Future PLC, working from the Bath office",
          "Works across SEO, Product, Engineering, BI/data, CMS, and editorial teams — thinks in systems rather than isolated page fixes",
          "Day-to-day spans technical audits, migration support, CMS improvements, automation, tooling, large datasets, alerting, and prioritisation",
        ],
      },
      {
        title: "FY26 Goals",
        bullets: [
          "Technical SEO audits, CMS automation, BI-led technical alerts, and supporting a GoCompare migration while minimising traffic loss",
          "Interested in AI/rule-driven CMS features to flag missing topics/entities, intent gaps, internal linking gaps, weak metadata, declining CTR, missing H1s, and pages needing refreshing",
        ],
      },
      {
        title: "Buying Guide Audit Project",
        bullets: [
          "Combines SOLR, GSC, revenue, internal linking, review links, freshness, and RPM data into scoring models (Balanced / Revenue Focus / SEO Focus)",
          "Classifies pages as Keep / Update / Remove / Mis-Categorized",
          "Has safeguards to only evaluate genuine SOLR-sourced buying guides",
        ],
      },
      {
        title: "404 Master Audit Project",
        bullets: [
          "Large-scale project combining Oncrawl crawl data with Googlebot log data (tens of thousands of URLs, 100k+ hits)",
          "Uses a Critical/High/lower-priority impact framework",
          "Separate from the smaller 404 redirect-suggestion Sheets tool (a Google Sheets tool with GSC integration and multi-domain dropdown)",
        ],
      },
      {
        title: "Google Discover Analysis",
        bullets: [
          "Compares Discover performance across Live Science, Tom's Guide, Homes & Gardens, Guitar Player, and Digital Camera World",
          "Focused on term-level shifts",
        ],
      },
      {
        title: "Core Toolkit",
        bullets: ["Screaming Frog, Oncrawl, Looker Studio, Sheets, Apps Script, Solr, GSC, internal-link datasets, author/article exports"],
      },
    ],
  },
  {
    project: "Freelance",
    notes: [
      {
        title: "Peacock Search — Positioning & Branding",
        bullets: [
          "Website: peacocksearch.co.uk",
          "Positioned as an independent SEO specialist rather than a generic agency, targeting SMBs, ecommerce, publishers, and startups",
          "Local focus: Romsey, Hampshire, Southampton, Winchester, Salisbury, Portsmouth, plus wider UK work",
          "Primary goal is qualified enquiries rather than raw traffic growth",
          "Branding has subtle Leeds United/Leeds culture inspiration (drawing on the independent/editorial tone of The Square Ball), but deliberately avoids looking football-themed — favours modern, characterful branding over corporate; particular about logo alignment and consistency",
          "Has worked on GBP, Instagram, LinkedIn, local directories, social bios, local landing pages, service graphics, Instagram carousels, reusable templates, favicon/app icon work",
        ],
      },
      {
        title: "Visibility Review Service",
        bullets: [
          "Core service offering: works out which services/locations are worth targeting, competitor activity, technical/content/local SEO opportunities, GBP issues, AI/GEO visibility, and authority/backlink gaps — not just assessing a client-provided keyword list",
          "Has explored a retainer model around £300 for four hours per month",
          "On retainers, personally covers technical SEO, on-page, local SEO, and GBP work; when a client has dev support, tickets up dev-implementation items and personally supports through delivery",
        ],
      },
      {
        title: "Client — Active Health Hub",
        bullets: [
          "activehealthhub.co.uk, a chiropractic practice site on WordPress",
          "Work done: author bio updates, About Us page updates via WordPress admin",
        ],
      },
      {
        title: "Client — Rafique Aesthetics",
        bullets: [
          "Built their site on Next.js, Sanity, and Vercel",
          "Chosen to be easy for Claude to develop and easy for the site owner to manage",
          "Priorities: EEAT, services, products, structured content, SEO-friendly architecture",
        ],
      },
      {
        title: "Client — Steadfast Collective",
        bullets: ["Freelance client — minimal detail on file yet. TODO: add more detail here once available."],
      },
    ],
  },
  {
    project: "Personal",
    notes: [
      {
        title: "Family",
        bullets: [
          "Partner works as a respiratory nurse, enjoys outdoor activities — walking, woods, lidos, wild swimming",
          "Two children: a younger daughter (around 7) and a 16-year-old son",
        ],
      },
      {
        title: "Home Lab & Smart Home",
        bullets: [
          "Raspberry Pi 5 with NVMe SSD and an AI+ hat, running Debian with Docker/Docker Compose",
          "Runs Home Assistant, Uptime Kuma, and Portainer in containers, with Pi-hole planned",
          "Has an Aeotec Zigbee stick",
          "Home network uses a Virgin Media Wi-Fi 6 router",
          "Comfortable with SSH and Docker over GUIs",
          "Smart home devices: Alexa Echo devices, a VIDAA TV, Fire TV, multi-room audio",
          "Also owns a FlashForge Finder 3D printer",
          "Interested in running local AI models, has explored Ollama on the Raspberry Pi 5",
        ],
      },
      {
        title: "Interests",
        bullets: [
          "Music: The Cure (attended their Blackweir Fields, Cardiff concert, late June 2026, VIP Garden ticket)",
          "Football, and supports Leeds United",
          "Also enjoys cooking and travel",
        ],
      },
      {
        title: "Genealogy Research",
        bullets: [
          "Researching the Payne family, particularly the paternal line",
          "Focus on relatives with military service: WWI Hampshire Regiment, Gloucestershire Regiment, Royal Marine Artillery, with postings in India/Mesopotamia",
          "Has reconstructed a 1911 census household for the family in Romsey",
          "Cares about context — unit movements and where someone actually was, not just names and dates",
          "Connected to an idea for a GEDCOM cleaner tool (ingests GEDCOM files, flags/standardises inconsistencies in place names/dates/formats, applies safe auto-corrections) — still weighing market fit against tools like Ancestry",
        ],
      },
    ],
  },
  {
    project: "Side Projects",
    notes: [
      {
        title: "CoachPlan",
        bullets: [
          "Sports/grassroots coaching PWA — React, Vite, Supabase, Tailwind, deployed on Vercel",
          "Targets the 5–16 age range",
          "Core features: player availability, training sessions, matches, formations, lineups, player development",
          "Viewed as a realistic small/medium side-income product, not a VC play",
          "Has also done branding/imagery work for it",
          "Has researched publishing/monetisation pipelines (Lemon Squeezy, Tauri/Electron)",
        ],
      },
      {
        title: "GlassDesk",
        bullets: [
          "A physical monitor/desk setup project (not an app) — sit-stand desk rebuild with cable management and a decluttered surface philosophy",
        ],
      },
      {
        title: "Tasklists",
        bullets: ["A webapp project for tracking tasks"],
      },
      {
        title: "Setlist-to-Spotify Converter",
        bullets: ["Idea for a web app that converts concert setlists into Spotify playlists"],
      },
      {
        title: "Home Dashboard",
        bullets: [
          'Raspberry Pi touchscreen (10–13") project with a Spotify-like "Now Playing" screen spanning Spotify/vinyl/podcasts (vinyl ID via USB mic + AudD + Discogs)',
          "Also planned: calendar/weather/Home Assistant/notes/photos/website-monitoring screens, with day/night modes",
        ],
      },
    ],
  },
  {
    project: "Football Coaching",
    notes: [
      {
        title: "Coaching Philosophy & Drills",
        bullets: [
          "Grassroots girls' football, coaching children around his daughter's age",
          "Sessions built around Ball Tag, Traffic Light Relays, Shoot on Sight, and small-sided games",
          "Philosophy: maximum engagement/touches, minimal standing around; prioritises enjoyment, participation, age-appropriate coaching",
          "Carries roughly a dozen size-3 footballs for sessions",
        ],
      },
    ],
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPage = any;

function getTitleText(page: AnyPage): string {
  return (page.properties?.[TITLE_PROP]?.title ?? []).map((t: AnyPage) => t.plain_text).join("");
}

async function loadProjectIdsByName(notion: Client, projectsDbId: string): Promise<Map<string, string>> {
  const res = await notion.dataSources.query({ data_source_id: projectsDbId } as never);
  const map = new Map<string, string>();
  for (const page of res.results as AnyPage[]) {
    map.set(getTitleText(page), page.id);
  }
  return map;
}

async function createProject(notion: Client, projectsDbId: string, name: string): Promise<string> {
  console.log(`Creating "${name}" project (not found in existing workspace)...`);
  const page = await notion.pages.create({
    parent: { type: "data_source_id", data_source_id: projectsDbId },
    properties: {
      [TITLE_PROP]: { title: title(name) },
      [PROJECTS_PROPS.status]: { select: { name: PROJECT_STATUS.ACTIVE } },
    },
  } as never);
  return page.id;
}

async function main() {
  const env = loadNotionEnv(loadEnv("development", process.cwd(), ""));
  if (!env.token) throw new Error("NOTION_TOKEN is missing from .env");
  if (!env.notesDbId) throw new Error("NOTION_NOTES_DB_ID is missing from .env");
  if (!env.projectsDbId) throw new Error("NOTION_PROJECTS_DB_ID is missing from .env");

  const notion = createNotionClient(env.token);

  const projectIds = await loadProjectIdsByName(notion, env.projectsDbId);

  const neededProjects = [...new Set(SEED.map((g) => g.project))];
  for (const name of neededProjects) {
    if (!projectIds.has(name)) {
      const id = await createProject(notion, env.projectsDbId, name);
      projectIds.set(name, id);
    }
  }

  let created = 0;
  for (const group of SEED) {
    const projectId = projectIds.get(group.project);
    if (!projectId) throw new Error(`No project id resolved for "${group.project}"`);

    for (const note of group.notes) {
      console.log(`Creating note "${note.title}" (${group.project})...`);
      await notion.pages.create({
        parent: { type: "data_source_id", data_source_id: env.notesDbId },
        properties: {
          [TITLE_PROP]: { title: title(note.title) },
          [NOTES_PROPS.project]: { relation: [{ id: projectId }] },
        },
        children: note.bullets.map(bulletBlock),
      } as never);
      created++;
    }
  }

  console.log(`\nDone. Created ${created} notes across ${neededProjects.length} projects.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
