// Vercel Node.js serverless entry point for everything under /api/*. All
// actual routing/business logic lives in server/handleApiRequest.ts, shared
// with local dev's server/apiPlugin.ts; this file only adapts Vercel's
// request/response shapes and env source (process.env here vs. Vite's
// loadEnv() locally).
//
// Deliberately NOT named with a [...path] bracket segment: that convention
// is Next.js-specific file routing and isn't honored by plain ("other"
// framework) Vercel Functions — a [...path].ts file there only matched a
// single path segment (and mangled it into a literal "...path" query key),
// so multi-segment routes like /api/google/accounts 404'd before ever
// reaching the function. Instead this is a single static function
// (api/index.ts) reached via an explicit rewrite in vercel.json that forwards
// every /api/* request here while leaving the original path intact.
//
// Uses the classic Node.js (req, res) callback signature, not the Web
// Standard Request/Response — confirmed live that this runtime actually
// invokes with a plain Node IncomingMessage/ServerResponse pair (req.headers
// is a plain object, not a Headers instance; req.url is a relative path, not
// an absolute URL), despite that being the currently-documented convention.
// Hand-typed rather than importing @vercel/node, which pulls in a large,
// vulnerable build-tooling dependency tree for two type imports.
import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import { handleApiRequest } from "../server/handleApiRequest.js";

interface VercelLikeRequest extends IncomingMessage {
  body?: unknown;
}

export default async function handler(req: VercelLikeRequest, res: ServerResponse): Promise<void> {
  const host = (req.headers.host as string | undefined) ?? "localhost";
  const url = new URL(req.url ?? "/", `https://${host}`);

  const result = await handleApiRequest({
    method: req.method ?? "GET",
    pathname: url.pathname,
    searchParams: url.searchParams,
    readBody: async () => {
      if (req.method === "GET" || req.method === "HEAD") return {};
      return (req.body ?? {}) as Record<string, unknown>;
    },
    env: process.env,
    // Lets a route (Gmail sync/scan) return its initial response immediately
    // while the actual work continues for up to the function's maxDuration
    // (see vercel.json) — see server/handleApiRequest.ts's backgroundTask doc.
    backgroundTask: (task) => {
      waitUntil(task.catch((error) => console.error("[api] background task failed:", error)));
    },
  });

  if (result.kind === "redirect") {
    res.writeHead(302, { Location: result.location });
    res.end();
    return;
  }

  res.statusCode = result.status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(result.body));
}
