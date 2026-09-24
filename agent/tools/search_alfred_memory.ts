import { defineTool } from "eve/tools";
import { z } from "zod";
import { databaseConfigured } from "../lib/database";
import { searchMemories } from "../lib/memory";

export default defineTool({
  description: "Search Alfred's Core-owned durable memory. This is read-only and only returns active memories in the owner's permitted scope.",
  inputSchema: z.object({
    query: z.string().min(2).max(500),
    scope: z.string().min(1).max(120).optional(),
    kinds: z.array(z.enum(["profile", "project", "episodic", "knowledge"])).max(4).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async execute(input, ctx) {
    if (!databaseConfigured()) {
      return { configured: false, memories: [], message: "Durable memory is not configured yet." };
    }
    const ownerId = process.env.ALFRED_OWNER_ID;
    if (!ownerId || ctx.session.auth.current?.principalId !== "chris") {
      throw new Error("Memory access is restricted to the configured Alfred owner.");
    }
    return { configured: true, memories: await searchMemories({ ownerId, ...input }) };
  },
});
