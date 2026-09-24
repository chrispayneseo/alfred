import { z } from "zod";

export const channelSchema = z.enum(["web", "whatsapp", "voice", "email", "api", "webhook"]);
export const trustLevelSchema = z.enum(["owner", "trusted", "untrusted", "service"]);
export const actionLevelSchema = z.enum(["read", "safe_write", "reversible", "external", "high_impact"]);

export const alfredRequestSchema = z.object({
  requestId: z.string().uuid().optional(),
  user: z.string().min(1).max(120),
  channel: channelSchema,
  message: z.string().min(1).max(20_000),
  conversationId: z.string().min(1).max(160).optional(),
  attachments: z.array(z.object({ name: z.string().min(1).max(255), mediaType: z.string().min(1).max(120), location: z.string().min(1).max(2_000) })).max(20).default([]),
  timestamp: z.string().datetime().optional(),
});

export type AlfredRequest = z.infer<typeof alfredRequestSchema>;
export type ActionLevel = z.infer<typeof actionLevelSchema>;
export type NormalizedRequest = AlfredRequest & { requestId: string; timestamp: string; trustLevel: z.infer<typeof trustLevelSchema> };
export type PolicyDecision = { level: ActionLevel; decision: "auto" | "confirm" | "deny"; reason: string };
export type AuditEvent = { id: string; at: string; type: string; requestId?: string; conversationId?: string; data: Record<string, unknown> };
