import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { agentRunEvents } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

type Row = Tables<'agent_run_events'>;
type Kind = Row['kind'];

export class AgentRunEventsRepository {
  constructor(private readonly db: DbClient) {}

  // Append an event. seq is assigned monotonically per run via a coalesce
  // over the existing max — sufficient for serial-writer agents. If we ever
  // emit events from concurrent writers per run, switch to a sequence per
  // (run_id) or a partial unique index + retry.
  async append(input: {
    run_id: string;
    kind: Kind;
    payload: Record<string, unknown>;
    latency_ms?: number | null;
    tokens_in?: number | null;
    tokens_out?: number | null;
  }): Promise<Row> {
    const seqResult = await this.db.execute<{ next_seq: number }>(sql`
      SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
      FROM agent_run_events
      WHERE run_id = ${input.run_id}
    `);
    const nextSeq =
      (seqResult as unknown as Array<{ next_seq: number }>)[0]?.next_seq ?? 1;

    const [row] = await this.db
      .insert(agentRunEvents)
      .values({
        run_id: input.run_id,
        seq: nextSeq,
        kind: input.kind,
        payload: input.payload,
        latency_ms: input.latency_ms ?? null,
        tokens_in: input.tokens_in ?? null,
        tokens_out: input.tokens_out ?? null,
      } as TablesInsert<'agent_run_events'>)
      .returning();
    return row;
  }

  async listForRun(runId: string): Promise<Row[]> {
    return this.db
      .select()
      .from(agentRunEvents)
      .where(eq(agentRunEvents.run_id, runId))
      .orderBy(asc(agentRunEvents.seq));
  }

  // Used by the SSE handler to fetch only events newer than the client's
  // cursor. Returns rows in seq order.
  async listSinceSeq(runId: string, sinceSeq: number): Promise<Row[]> {
    return this.db
      .select()
      .from(agentRunEvents)
      .where(
        and(
          eq(agentRunEvents.run_id, runId),
          gt(agentRunEvents.seq, sinceSeq),
        ),
      )
      .orderBy(asc(agentRunEvents.seq));
  }
}
