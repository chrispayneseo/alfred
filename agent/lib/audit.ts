import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuditEvent } from "./contracts";
import { databaseConfigured, database } from "./database";

const auditPath = process.env.ALFRED_AUDIT_PATH ?? join(process.cwd(), "data", "audit.jsonl");

export async function writeAudit(event: Omit<AuditEvent, "id" | "at">): Promise<void> {
  const record: AuditEvent = { ...event, id: crypto.randomUUID(), at: new Date().toISOString() };
  if (databaseConfigured()) {
    await database().query(
      `insert into alfred_audit_events (id, occurred_at, event_type, request_id, conversation_id, data)
       values ($1, $2, $3, $4, $5, $6)`,
      [record.id, record.at, record.type, record.requestId ?? null, record.conversationId ?? null, record.data],
    );
    return;
  }
  await mkdir(dirname(auditPath), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
}
