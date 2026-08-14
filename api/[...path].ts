// Vercel Node.js serverless catch-all — the production entry point for
// everything under /api/*. All actual routing/business logic lives in
// server/handleApiRequest.ts, shared with local dev's server/apiPlugin.ts;
// this file only adapts Vercel's request/response shapes and env source
// (process.env here vs. Vite's loadEnv() locally).
import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import { handleApiRequest } from "../server/handleApiRequest.js";

// Vercel's Node.js runtime adds `body` (auto-parsed for application/json,
// which every POST in this app sends) and `query` on top of the raw
// IncomingMessage — hand-typed here rather than depending on @vercel/node
// just for these two fields (that package pulls in a large, largely
// unrelated build-tooling dependency tree).
interface VercelRequest extends IncomingMessage {
  body?: unknown;
}

export default async function handler(req: VercelRequest, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";

  const result = await handleApiRequest({
    method,
    pathname: url.pathname,
    searchParams: url.searchParams,
    // Vercel has already parsed the JSON body before this handler runs —
    // re-reading req as a stream (what the local dev adapter does) would
    // hang, since the stream is already consumed.
    readBody: async () => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {}),
    env: process.env,
    // Lets a route (Gmail sync/scan) return its initial response immediately
    // while the actual work continues for up to the function's maxDuration
    // (see vercel.json) — see server/handleApiRequest.ts's backgroundTask doc.
    backgroundTask: (task) => {
      waitUntil(task.catch((error) => console.error("[api] background task failed:", error)));
    },
  });

  if (result.kind === "redirect") {
    res.statusCode = 302;
    res.setHeader("Location", result.location);
    res.end();
    return;
  }

  res.statusCode = result.status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(result.body));
}
