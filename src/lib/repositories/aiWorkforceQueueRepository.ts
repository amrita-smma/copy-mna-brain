import { desc, eq, sql } from 'drizzle-orm';
import { aiWorkforceQueue } from '@/lib/db/schema';
import type { DbClient } from './types';

type TriggerSource = 'chat' | 'cron' | 'webhook' | 'api';
export type WorkforceStatus =
  | 'pending'
  | 'running'
  | 'waiting_for_human_input'
  | 'waiting_for_subagent'
  | 'resume_ready'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'timed_out';

export interface WorkforceQueueRow {
  id: string;
  parent_run_id: string | null;
  origin_routine_id: string | null;
  agent_name: string;
  trigger_source: TriggerSource;
  trigger_meta: Record<string, unknown>;
  status: WorkforceStatus;
  priority: number;
  input: Record<string, unknown>;
  idempotency_key: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface WorkforceQueueInsert {
  agent_name: string;
  trigger_source: TriggerSource;
  trigger_meta?: Record<string, unknown>;
  input: Record<string, unknown>;
  priority?: number;
  parent_run_id?: string | null;
  origin_routine_id?: string | null;
  idempotency_key?: string | null;
}

export class AiWorkforceQueueRepository {
  constructor(private readonly db: DbClient) {}

  async enqueue(data: WorkforceQueueInsert): Promise<WorkforceQueueRow> {
    const [row] = await this.db
      .insert(aiWorkforceQueue)
      .values({
        agent_name: data.agent_name,
        trigger_source: data.trigger_source,
        trigger_meta: data.trigger_meta ?? {},
        input: data.input,
        priority: data.priority ?? 0,
        parent_run_id: data.parent_run_id ?? null,
        origin_routine_id: data.origin_routine_id ?? null,
        idempotency_key: data.idempotency_key ?? null,
      })
      .returning();
    return row as WorkforceQueueRow;
  }

  async list({ limit = 100 }: { limit?: number } = {}): Promise<WorkforceQueueRow[]> {
    const rows = await this.db
      .select()
      .from(aiWorkforceQueue)
      .orderBy(desc(aiWorkforceQueue.created_at))
      .limit(limit);
    return rows as WorkforceQueueRow[];
  }

  async findById(id: string): Promise<WorkforceQueueRow | null> {
    const rows = await this.db
      .select()
      .from(aiWorkforceQueue)
      .where(eq(aiWorkforceQueue.id, id))
      .limit(1);
    return (rows[0] as WorkforceQueueRow | undefined) ?? null;
  }

  async findByToolCallId(toolCallId: string): Promise<WorkforceQueueRow | null> {
    const rows = await this.db
      .select()
      .from(aiWorkforceQueue)
      .where(sql`${aiWorkforceQueue.trigger_meta}->>'tool_call_id' = ${toolCallId}`)
      .orderBy(desc(aiWorkforceQueue.created_at))
      .limit(1);
    return (rows[0] as WorkforceQueueRow | undefined) ?? null;
  }
}
