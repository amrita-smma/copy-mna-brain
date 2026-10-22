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

export interface CompactionResult {
  checkpoints: number;
  writes: number;
  blobs: number;
}

function rowCount(result: unknown): number {
  return Number((result as { rowCount?: number | null })?.rowCount ?? 0);
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

  /**
   * Copilot chat threads with more than `keep` checkpoints that are safe to
   * compact: idle for `idleMinutes` and not holding a turn lock. Workforce
   * threads (`ai_workforce_queue` ids) never match, so a paused run keeps the
   * history its resume may need.
   */
  async listCompactableThreads(opts: {
    keep: number;
    idleMinutes: number;
    limit: number;
  }): Promise<string[]> {
    const result = await this.db.execute<{ thread_id: string }>(sql`
      SELECT c.thread_id
      FROM agent_states.checkpoints c
      JOIN copilot_chats ch ON ch.id::text = c.thread_id
      WHERE c.checkpoint_ns = ''
        AND ch.last_active_at < now() - make_interval(mins => ${opts.idleMinutes})
        AND (ch.busy_until IS NULL OR ch.busy_until < now())
      GROUP BY c.thread_id
      HAVING count(*) > ${opts.keep}
      LIMIT ${opts.limit}
    `);
    const rows = Array.isArray(result)
      ? result
      : (result as unknown as { rows?: { thread_id: string }[] })?.rows ?? [];
    return rows.map((r) => r.thread_id);
  }

  /**
   * Drop every checkpoint of a thread but the newest `keep`, with their
   * pending writes and every blob no remaining checkpoint references. The
   * newest checkpoint holds the thread's whole state, so the conversation is
   * untouched; only time-travel to older steps is lost. One transaction, so a
   * failure leaves the thread as it was.
   *
   * Checkpoint ids are time-ordered (uuid6), which is how LangGraph itself
   * finds the latest one. Only the root namespace ('') is compacted.
   */
  async compactThread(threadId: string, keep: number): Promise<CompactionResult> {
    if (!threadId || keep < 1) return { checkpoints: 0, writes: 0, blobs: 0 };
    return this.db.transaction(async (tx) => {
      const kept = sql`
        SELECT checkpoint_id FROM agent_states.checkpoints
        WHERE thread_id = ${threadId} AND checkpoint_ns = ''
        ORDER BY checkpoint_id DESC
        LIMIT ${keep}
      `;
      const writes = await tx.execute(sql`
        DELETE FROM agent_states.checkpoint_writes
        WHERE thread_id = ${threadId} AND checkpoint_ns = ''
          AND checkpoint_id NOT IN (${kept})
      `);
      const checkpoints = await tx.execute(sql`
        DELETE FROM agent_states.checkpoints
        WHERE thread_id = ${threadId} AND checkpoint_ns = ''
          AND checkpoint_id NOT IN (${kept})
      `);
      const blobs = await tx.execute(sql`
        DELETE FROM agent_states.checkpoint_blobs b
        WHERE b.thread_id = ${threadId} AND b.checkpoint_ns = ''
          AND NOT EXISTS (
            SELECT 1 FROM agent_states.checkpoints c
            WHERE c.thread_id = ${threadId} AND c.checkpoint_ns = ''
              AND c.checkpoint -> 'channel_versions' ->> b.channel = b.version
          )
      `);
      return {
        checkpoints: rowCount(checkpoints),
        writes: rowCount(writes),
        blobs: rowCount(blobs),
      };
    });
  }
}
