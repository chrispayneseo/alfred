import { defineChannel, POST } from "eve/channels";
import { alfredRequestSchema, type NormalizedRequest } from "../lib/contracts";
import { assessPolicy } from "../lib/policy";
import { writeAudit } from "../lib/audit";

function authorized(request: Request): boolean {
  const token = process.env.ALFRED_CORE_API_TOKEN;
  return Boolean(token && request.headers.get("authorization") === `Bearer ${token}`);
}

export default defineChannel({
  routes: [POST("/alfred/v1/requests", async (request, { from }) => {
    if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const parsed = alfredRequestSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "invalid_request", details: parsed.error.issues }, { status: 400 });
    const normalized: NormalizedRequest = { ...parsed.data, requestId: parsed.data.requestId ?? crypto.randomUUID(), timestamp: parsed.data.timestamp ?? new Date().toISOString(), trustLevel: "owner" };
    const policy = assessPolicy(normalized);
    const address = normalized.conversationId ?? normalized.requestId;
    await writeAudit({ type: "request.received", requestId: normalized.requestId, conversationId: address, data: { channel: normalized.channel, user: normalized.user, policy, attachmentCount: normalized.attachments.length } });
    const session = await from(address).send(normalized.message, { auth: { authenticator: "alfred-core-api", principalType: "user", principalId: "chris", attributes: { trustLevel: "owner", requestId: normalized.requestId, channel: normalized.channel } } });
    return Response.json({ requestId: normalized.requestId, sessionId: session.id, policy, status: "accepted" }, { status: 202 });
  })],
});
