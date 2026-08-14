import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { loadEnv } from "vite";
import { handleApiRequest } from "./handleApiRequest.js";

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** Dev-only adapter: turns Vite's dev-server middleware (raw Node
 * IncomingMessage/ServerResponse) into calls against the shared,
 * transport-agnostic handleApiRequest.ts — the same handler api/[...path].ts
 * drives in production. All routing/business logic lives there; this file
 * only translates request/response shapes and env sourcing (Vite's
 * loadEnv() here vs. process.env in production). */
export function apiPlugin(): Plugin {
  return {
    name: "alfred-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();

        const url = new URL(req.url, "http://localhost");
        const method = req.method ?? "GET";
        // Re-read per request (not hoisted at server start) so a freshly
        // written .env value is picked up immediately, no restart required.
        const env = loadEnv("development", process.cwd(), "");

        const result = await handleApiRequest({
          method,
          pathname: url.pathname,
          searchParams: url.searchParams,
          readBody: () => readJsonBody(req),
          env,
          // Fine as fire-and-forget here: this dev process stays alive for
          // as long as `npm run dev` runs, unlike a serverless invocation.
          backgroundTask: (task) => {
            void task.catch((error) => console.error("[apiPlugin] background task failed:", error));
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
      });
    },
  };
}
