import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { createNotionClient } from "./client";
import { loadNotionEnv } from "./env";
import { NotionRepo } from "./queries";

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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** Dev-only API layer: keeps the Notion token server-side and sidesteps the
 * Notion API's lack of CORS support for browser calls. Gets replaced by
 * Supabase Edge Functions in a later step. */
export function notionApiPlugin(): Plugin {
  return {
    name: "alfred-notion-api",
    configureServer(server) {
      const env = loadNotionEnv();
      const repo = env.token ? new NotionRepo(createNotionClient(env.token), env) : undefined;

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();

        if (!repo) {
          sendJson(res, 503, { error: "Notion isn't configured yet — check NOTION_TOKEN and the *_DB_ID vars in .env." });
          return;
        }

        const url = new URL(req.url, "http://localhost");
        const method = req.method ?? "GET";

        try {
          if (method === "POST" && url.pathname === "/api/capture") {
            const body = await readJsonBody(req);
            const text = typeof body.text === "string" ? body.text.trim() : "";
            const source = body.source === "share-target" ? "share-target" : "manual";
            if (!text) return sendJson(res, 400, { error: "text is required" });

            const inbox = await repo.createInboxPage(text, source);
            const filed = await repo.classifyAndFile(inbox.id, text);
            return sendJson(res, 200, { inbox, filed });
          }

          if (method === "GET" && url.pathname === "/api/projects") {
            return sendJson(res, 200, await repo.listProjects());
          }

          if (method === "GET" && url.pathname === "/api/tasks") {
            const projectId = url.searchParams.get("project") ?? undefined;
            return sendJson(res, 200, await repo.listTasks(projectId));
          }

          if (method === "GET" && url.pathname === "/api/notes") {
            const projectId = url.searchParams.get("project") ?? undefined;
            return sendJson(res, 200, await repo.listNotes(projectId));
          }

          const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
          if (method === "PATCH" && taskMatch) {
            const body = await readJsonBody(req);
            if (typeof body.done === "boolean") await repo.updateTaskStatus(taskMatch[1], body.done);
            if (typeof body.projectId === "string") await repo.setTaskProject(taskMatch[1], body.projectId);
            return sendJson(res, 200, { ok: true });
          }

          const noteMatch = url.pathname.match(/^\/api\/notes\/([^/]+)$/);
          if (method === "PATCH" && noteMatch) {
            const body = await readJsonBody(req);
            if (typeof body.projectId === "string") await repo.setNoteProject(noteMatch[1], body.projectId);
            return sendJson(res, 200, { ok: true });
          }

          sendJson(res, 404, { error: "not found" });
        } catch (error) {
          console.error(error);
          sendJson(res, 500, { error: error instanceof Error ? error.message : "internal error" });
        }
      });
    },
  };
}
