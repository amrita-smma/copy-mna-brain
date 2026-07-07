import {
  runTrackMatching,
  TRACK_MATCHING_TIMEOUT_SECONDS,
  type TrackMatchingPayload,
  type TrackMatchingResult,
} from '@/lib/jobs/handlers/trackMatching';
import type { DbClient } from '@/lib/repositories';
import type { JobDispatcher } from './jobDispatcher';

/**
 * Dispatches or synchronously runs the agent-driven track-matching job.
 * Called when a company enters L0 so its matched theses ("Tracks") are
 * evaluated and persisted exactly once.
 */
export class TrackMatchingService {
  constructor(
    private readonly jobDispatcher: JobDispatcher,
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  dispatch(payload: TrackMatchingPayload): Promise<{ jobId: string }> {
    return this.jobDispatcher.dispatch({
      type: 'track_matching',
      payload: payload as unknown as Record<string, unknown>,
      timeoutSeconds: TRACK_MATCHING_TIMEOUT_SECONDS,
      work: ({ db: runDb, job }) => runTrackMatching(payload, { db: runDb, workspaceId: job.workspace_id }),
    });
  }

  /** Run track matching inline (blocking). Use before an L0 stage change so
   *  the track is assigned before the company lands in L0. */
  runSync(payload: TrackMatchingPayload): Promise<TrackMatchingResult> {
    return runTrackMatching(payload, { db: this.db, workspaceId: this.workspaceId });
  }
}
