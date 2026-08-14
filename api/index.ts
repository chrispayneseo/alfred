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
// Uses the Web Standard Request/Response signature — Vercel's current
// documented convention for non-Next.js Functions. request.url here is not
// guaranteed to be a full absolute URL, so it's parsed against the request's
// own Host header rather than passed to `new URL()` directly.
import { waitUntil } from "@vercel/functions";
import { handleApiRequest } from "../server/handleApiRequest.js";

export default async function handler(request: Request): Promise<Response> {
  const host = request.headers.get("host") ?? "localhost";
  const url = new URL(request.url, `https://${host}`);

  const result = await handleApiRequest({
    method: request.method,
    pathname: url.pathname,
    searchParams: url.searchParams,
    readBody: async () => {
      if (request.method === "GET" || request.method === "HEAD") return {};
      try {
        return (await request.json()) as Record<string, unknown>;
      } catch {
        return {};
      }
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
    return new Response(null, { status: 302, headers: { Location: result.location } });
  }

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  });
}
