import { defineHook } from "eve/hooks";
import { writeAudit } from "../lib/audit";

export default defineHook({
  events: {
    async "action.result"(event, ctx) {
      try {
        const result = event.data.result;
        await writeAudit({
          type: "action.completed",
          conversationId: ctx.session.id,
          data: {
            eventId: event.meta.id,
            kind: result.kind,
            isError: result.isError ?? false,
            name: result.kind === "tool-result" ? result.toolName : null,
          },
        });
      }
      catch (error) { console.error("Alfred audit write failed", error); }
    },
    async "turn.completed"(event, ctx) {
      try { await writeAudit({ type: "turn.completed", conversationId: ctx.session.id, data: { eventId: event.meta.id, turnId: event.data.turnId } }); }
      catch (error) { console.error("Alfred audit write failed", error); }
    },
  },
});
