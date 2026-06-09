import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { jobs, jobLogs } from '@/lib/db/schema';
import { DEFAULT_STUCK_BUFFER_SECONDS, isStuckJob } from '@/lib/jobs/stuck';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

type Job = Tables<'jobs'>;
type JobLog = Tables<'job_logs'>;
type JobStatus = Job['status'];
type JobType = Job['type'];

export type JobWithLogs = Job & { logs: JobLog[] };

export class JobRepository {
  constructor(private readonly db: DbClient) {}

  async create(input: TablesInsert<'jobs'>): Promise<Job> {
    const [row] = await this.db.insert(jobs).values(input).returning();
    return row;
  }

  async findById(id: string): Promise<Job | null> {
    const [row] = await this.db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    return row ?? null;
  }

  async findByIdWithLogs(id: string): Promise<JobWithLogs | null> {
    const job = await this.findById(id);
    if (!job) return null;

    const logs = await this.db
      .select()
      .from(jobLogs)
      .where(eq(jobLogs.job_id, id))
      .orderBy(asc(jobLogs.created_at));

    return { ...job, logs };
  }

  async markRunning(id: string): Promise<Job> {
    return this.updateStatus(id, {
      status: 'running',
      started_at: new Date().toISOString(),
    });
  }

  async markCompleted(id: string, result: unknown): Promise<Job> {
    return this.updateStatus(id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      result: (result ?? null) as Job['result'],
      error: null,
    });
  }

  async markFailed(id: string, error: string): Promise<Job> {
    return this.updateStatus(id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error,
    });
  }

  async markTimedOut(id: string, error: string): Promise<Job> {
    return this.updateStatus(id, {
      status: 'timed_out',
      completed_at: new Date().toISOString(),
      error,
    });
  }

  async findMostRecentByType(type: JobType, sinceIso: string): Promise<Job | null> {
    const [row] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, type), gte(jobs.created_at, sinceIso)))
      .orderBy(desc(jobs.created_at))
      .limit(1);
    return row ?? null;
  }

  /**
   * Most recent job of `type` in the given status, regardless of how long ago
   * it ran. Used by the CRM insights bar to surface "last successful sync".
   */
  async findLatestByTypeAndStatus(
    type: JobType,
    status: JobStatus,
  ): Promise<Job | null> {
    const [row] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, type), eq(jobs.status, status)))
      .orderBy(desc(jobs.completed_at))
      .limit(1);
    return row ?? null;
  }

  /**
   * Find every job of `type` whose JSONB `payload` matches each key/value in
   * `payloadFilter`. Returns all statuses — caller decides how to react (e.g.
   * 409 on running/completed, allow retry on failed).
   *
   * Values are compared as text via `payload->>key`, which is the safest cast
   * for primitive JSON values. Keep payload shapes primitive (number, string).
   */
  async findByTypeAndPayload(
    type: JobType,
    payloadFilter: Record<string, string | number>,
  ): Promise<Job[]> {
    const conditions = [eq(jobs.type, type)];
    for (const [key, value] of Object.entries(payloadFilter)) {
      conditions.push(sql`${jobs.payload}->>${key} = ${String(value)}`);
    }
    return this.db
      .select()
      .from(jobs)
      .where(and(...conditions))
      .orderBy(desc(jobs.created_at));
  }

  async findStuck(bufferSeconds: number = DEFAULT_STUCK_BUFFER_SECONDS): Promise<Job[]> {
    const rows = await this.db
      .select()
      .from(jobs)
      .where(inArray(jobs.status, ['pending', 'running']));
    const now = Date.now();
    return rows.filter((row) => isStuckJob(row, now, bufferSeconds));
  }

  async markStuckAsTimedOut(id: string, reason: string): Promise<Job> {
    const existing = await this.findById(id);
    if (!existing) throw new Error(`Job ${id} not found`);

    const updated = await this.updateStatus(id, {
      status: 'timed_out',
      completed_at: new Date().toISOString(),
      error: reason,
    });

    await this.db.insert(jobLogs).values({
      job_id: id,
      from_status: existing.status,
      to_status: 'timed_out',
      message: reason,
      metadata: { reason: 'stuck_cleanup' } as JobLog['metadata'],
    } as TablesInsert<'job_logs'>);

    return updated;
  }

  async appendLog(
    jobId: string,
    entry: { message?: string | null; metadata?: unknown },
  ): Promise<void> {
    const job = await this.findById(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    await this.db.insert(jobLogs).values({
      job_id: jobId,
      from_status: job.status,
      to_status: job.status,
      message: entry.message ?? null,
      metadata: (entry.metadata ?? null) as JobLog['metadata'],
    } as TablesInsert<'job_logs'>);
  }

  private async updateStatus(
    id: string,
    patch: {
      status: JobStatus;
      started_at?: string;
      completed_at?: string;
      result?: Job['result'];
      error?: string | null;
    },
  ): Promise<Job> {
    const [row] = await this.db
      .update(jobs)
      .set(patch as TablesUpdate<'jobs'>)
      .where(eq(jobs.id, id))
      .returning();
    if (!row) throw new Error(`Job ${id} not found`);
    return row;
  }
}
