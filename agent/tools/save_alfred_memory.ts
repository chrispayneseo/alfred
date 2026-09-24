import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { databaseConfigured, database } from "../lib/database";

const memorySchema = z.object({
  kind: z.enum(["profile", "project", "episodic", "knowledge"]),
  scope: z.string().min(1).max(120).default("global"),
  content: z.string().min(3).max(10_000),
  confidence: z.number().min(0).max(1).default(0.8),
  source: z.string().min(1).max(240),
  sourceReference: z.string().max(1_000).optional(),
});

export default defineTool({
  description: "Propose a durable Alfred memory. This is a Core-owned write and always requires Chris's explicit approval before saving.",
  inputSchema: memorySchema,
  approval: always(),
  async execute(input, ctx) {
    if (!databaseConfigured()) throw new Error("Durable memory is not configured yet.");
    const ownerId = process.env.ALFRED_OWNER_ID;
    if (!ownerId || ctx.session.auth.current?.principalId !== "chris") {
      throw new Error("Only the configured Alfred owner may save memory.");
    }
    const id = crypto.randomUUID();
    await database().query(
      `insert into alfred_memories
        (id, owner_id, kind, scope, content, confidence, source, source_reference, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'active')`,
      [id, ownerId, input.kind, input.scope, input.content, input.confidence, input.source, input.sourceReference ?? null],
    );
    return { id, status: "saved", kind: input.kind, scope: input.scope };
  },
});
