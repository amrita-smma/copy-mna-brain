import { sql } from 'drizzle-orm';
import type { DbClient } from './types';

export interface CheckpointMessageWrite {
  ts: string;                                   // ISO
  kind: 'ai' | 'tool' | 'human' | 'other';
  id: string | null;                            // kwargs.id
  toolCallId: string | null;                    // kwargs.tool_call_id
}

interface RawCheckpointRow extends Record<string, unknown> {
  ts: string;
  cls: string | null;
  msg_id: string | null;
  tool_call_id: string | null;
}

function mapKind(cls: string | null | undefined): CheckpointMessageWrite['kind'] {
  if (cls === 'AIMessage' || cls === 'AIMessageChunk') return 'ai';
  if (cls === 'ToolMessage' || cls === 'ToolMessageChunk') return 'tool';
  if (cls === 'HumanMessage' || cls === 'HumanMessageChunk') return 'human';
  return 'other';
}

export class AgentCheckpointRepository {
  constructor(private readonly db: DbClient) {}

  async listMessageWrites(threadId: string): Promise<CheckpointMessageWrite[]> {
    if (!threadId) {
      return [];
    }

    // Hardcoded schema `agent_states` must match `CHECKPOINT_SCHEMA` in
    // `src/lib/agents/analysis/index.ts` — do not import that module.
    const result = await this.db.execute<RawCheckpointRow>(sql`
WITH thread_checkpoints AS (
  SELECT
    checkpoint_id,
    parent_checkpoint_id,
    checkpoint->>'ts' AS ts
  FROM agent_states.checkpoints
  WHERE thread_id = ${threadId}
    AND checkpoint_ns = ''
),
first_children AS (
  SELECT DISTINCT ON (parent_checkpoint_id)
    parent_checkpoint_id,
    ts
  FROM thread_checkpoints
  WHERE parent_checkpoint_id IS NOT NULL
  ORDER BY parent_checkpoint_id, checkpoint_id
)
SELECT
  COALESCE(ch.ts, c.ts)              AS ts,
  e.value->'id'->>2                  AS cls,
  e.value->'kwargs'->>'id'           AS msg_id,
  e.value->'kwargs'->>'tool_call_id' AS tool_call_id
FROM agent_states.checkpoint_writes w
JOIN thread_checkpoints c
  ON c.checkpoint_id = w.checkpoint_id
LEFT JOIN first_children ch
  ON ch.parent_checkpoint_id = w.checkpoint_id
CROSS JOIN LATERAL (
  SELECT convert_from(w.blob, 'UTF8')::jsonb AS parsed
) b
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(b.parsed) = 'array'
       THEN b.parsed
       ELSE '[]'::jsonb END
) WITH ORDINALITY AS e(value, ord)
WHERE w.thread_id = ${threadId}
  AND w.checkpoint_ns = ''
  AND w.channel = 'messages'
  AND w.type = 'json'
ORDER BY w.checkpoint_id, w.task_id, w.idx, e.ord
`);

    const rows = Array.isArray(result)
      ? result
      : (result as unknown as { rows?: RawCheckpointRow[] })?.rows ?? [];

    return rows.map((row) => ({
      ts: row.ts ?? '',
      kind: mapKind(row.cls),
      id: row.msg_id ?? null,
      toolCallId: row.tool_call_id ?? null,
    }));
  }
}
