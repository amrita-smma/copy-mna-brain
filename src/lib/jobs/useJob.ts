'use client';

import { useEffect, useRef, useState } from 'react';
import type { Tables } from '@/lib/repositories';
import { apiRequest } from '@/lib/api/client';
import { LIVE_TOPICS, type LiveTopic } from '@/lib/live/topics';
import { liveFallbackMs, waitForLiveEvent } from '@/lib/live/liveBus';

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
 * Read `id` until `isDone`, re-reading when the live stream names it on
 * `topic` (the server publishes every status move) and otherwise at
 * `intervalMs` only while the stream is down. The wait is armed before each
 * read so a frame landing during the read is not missed.
 */
async function readUntil<T>(
  topic: LiveTopic,
  id: string,
  read: (signal?: AbortSignal) => Promise<T>,
  isDone: (value: T) => boolean,
  opts: { intervalMs: number; signal?: AbortSignal },
): Promise<T> {
  while (true) {
    if (opts.signal?.aborted) throw new Error('Aborted');
    const next = waitForLiveEvent(topic, {
      id,
      timeoutMs: liveFallbackMs(opts.intervalMs),
      signal: opts.signal,
    });
    let value: T;
    try {
      value = await read(opts.signal);
    } catch (err) {
      next.cancel();
      throw err;
    }
    if (isDone(value)) {
      next.cancel();
      return value;
    }
    if ((await next.settled) === 'aborted') throw new Error('Aborted');
  }
}

/**
 * Wait for an AI workforce queue run to reach a terminal state
 * (GET /api/workforce-queue/:id, re-read on each `workforce` frame for it).
 */
export async function waitForWorkforceRun(
  runId: string,
  opts: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<{ status: string; result: unknown; error: string | null }> {
  type Item = { status: string; output?: unknown; error?: Record<string, unknown> | null };
  const { item } = await readUntil(
    LIVE_TOPICS.workforce,
    runId,
    (signal) => apiRequest<{ item: Item }>(`/api/workforce-queue/${runId}`, { signal }),
    ({ item }) => WORKFORCE_TERMINAL.has(item.status),
    { intervalMs: opts.intervalMs ?? 2000, signal: opts.signal },
  );
  const errMsg = item.error
    ? (typeof item.error.message === 'string' ? item.error.message : JSON.stringify(item.error))
    : null;
  return { status: item.status, result: item.output ?? null, error: errMsg };
}

/**
 * Wait for a single job to reach a terminal state (GET /api/jobs/:id,
 * re-read on each `jobs` frame for it).
 */
export async function waitForJob(
  jobId: string,
  opts: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<JobWithLogs> {
  return readUntil(
    LIVE_TOPICS.jobs,
    jobId,
    (signal) => apiRequest<JobWithLogs>(`/api/jobs/${jobId}`, { signal }),
    (job) => isTerminalStatus(job.status),
    { intervalMs: opts.intervalMs ?? 2000, signal: opts.signal },
  );
}

/**
 * React hook that follows a job until it reaches a terminal state, updating
 * on every status it passes through. Pass null to disable (e.g. before a job
 * has been dispatched).
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
    readUntil(
      LIVE_TOPICS.jobs,
      jobId,
      async (signal) => {
        const data = await apiRequest<JobWithLogs>(`/api/jobs/${jobId}`, { signal });
        if (aliveRef.current) setJob(data);
        return data;
      },
      (data) => isTerminalStatus(data.status),
      { intervalMs, signal: controller.signal },
    ).catch((err) => {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      aliveRef.current = false;
      controller.abort();
    };
  }, [jobId, intervalMs]);

  const isTerminal = !!job && isTerminalStatus(job.status);
  return { job, isTerminal, error };
}
