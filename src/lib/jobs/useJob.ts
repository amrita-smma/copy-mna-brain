'use client';

import { useEffect, useRef, useState } from 'react';
import type { Tables } from '@/lib/repositories';

export type Job = Tables<'jobs'>;
export type JobLog = Tables<'job_logs'>;
export type JobStatus = Job['status'];

export type JobWithLogs = Job & { logs: JobLog[] };

const TERMINAL_STATES: JobStatus[] = ['completed', 'failed', 'timed_out'];

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

const WORKFORCE_TERMINAL = new Set(['succeeded', 'failed', 'rejected', 'timed_out']);

/**
 * Wait for an AI workforce queue run to reach a terminal state by polling
 * GET /api/workforce-queue/:id.
 */
export async function waitForWorkforceRun(
  runId: string,
  opts: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<{ status: string; result: unknown; error: string | null }> {
  const intervalMs = opts.intervalMs ?? 2000;
  while (true) {
    if (opts.signal?.aborted) throw new Error('Aborted');
    const res = await fetch(`/api/workforce-queue/${runId}`, { signal: opts.signal });
    if (!res.ok) throw new Error(`Failed to load run ${runId}: ${res.status}`);
    const { item } = (await res.json()) as { item: { status: string; output?: unknown; error?: Record<string, unknown> | null } };
    if (WORKFORCE_TERMINAL.has(item.status)) {
      const errMsg = item.error
        ? (typeof item.error.message === 'string' ? item.error.message : JSON.stringify(item.error))
        : null;
      return { status: item.status, result: item.output ?? null, error: errMsg };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Wait for a single job to reach a terminal state by polling the
 * GET /api/jobs/:id endpoint.
 */
export async function waitForJob(
  jobId: string,
  opts: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<JobWithLogs> {
  const intervalMs = opts.intervalMs ?? 2000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (opts.signal?.aborted) throw new Error('Aborted');
    const res = await fetch(`/api/jobs/${jobId}`, { signal: opts.signal });
    if (!res.ok) throw new Error(`Failed to load job ${jobId}: ${res.status}`);
    const job = (await res.json()) as JobWithLogs;
    if (isTerminalStatus(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * React hook that polls a job until it reaches a terminal state.
 * Pass null to disable polling (e.g. before a job has been dispatched).
 */
export function useJob(
  jobId: string | null,
  opts: { intervalMs?: number } = {},
): { job: JobWithLogs | null; isTerminal: boolean; error: string | null } {
  const [job, setJob] = useState<JobWithLogs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intervalMs = opts.intervalMs ?? 2000;
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    setJob(null);
    setError(null);
    if (!jobId) return;

    const controller = new AbortController();

    const tick = async () => {
      if (!aliveRef.current) return;
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`Failed to load job: ${res.status}`);
        const data = (await res.json()) as JobWithLogs;
        if (!aliveRef.current) return;
        setJob(data);
        if (!isTerminalStatus(data.status)) {
          setTimeout(tick, intervalMs);
        }
      } catch (err) {
        if (!aliveRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    tick();

    return () => {
      aliveRef.current = false;
      controller.abort();
    };
  }, [jobId, intervalMs]);

  const isTerminal = !!job && isTerminalStatus(job.status);
  return { job, isTerminal, error };
}
