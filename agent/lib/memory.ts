import { database } from "./database";

export type MemoryKind = "profile" | "project" | "episodic" | "knowledge";

export async function searchMemories(input: {
  ownerId: string;
  query: string;
  scope?: string;
  kinds?: MemoryKind[];
  limit?: number;
}) {
  const limit = Math.min(input.limit ?? 8, 20);
  const result = await database().query<{
    id: string; kind: MemoryKind; scope: string; content: string; confidence: string; source: string; source_reference: string | null; rank: number;
  }>(
    `select id, kind, scope, content, confidence, source, source_reference,
            ts_rank(search_document, websearch_to_tsquery('english', $2)) as rank
       from alfred_memories
      where owner_id = $1
        and status = 'active'
        and ($3::text is null or scope = $3 or scope = 'global')
        and ($4::text[] is null or kind = any($4))
        and search_document @@ websearch_to_tsquery('english', $2)
      order by rank desc, updated_at desc
      limit $5`,
    [input.ownerId, input.query, input.scope ?? null, input.kinds ?? null, limit],
  );
  return result.rows.map((row) => ({ ...row, confidence: Number(row.confidence) }));
}
