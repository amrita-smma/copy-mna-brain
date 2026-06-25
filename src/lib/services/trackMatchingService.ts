import {
  runTrackMatching,
  TRACK_MATCHING_TIMEOUT_SECONDS,
  type TrackMatchingPayload,
} from '@/lib/jobs/handlers/trackMatching';
import type { JobDispatcher } from './jobDispatcher';

/**
 * Dispatches the agent-driven track-matching job. Called when a company enters
 * L0 so its matched theses ("Tracks") are evaluated and persisted exactly once.
 */
export class TrackMatchingService {
  constructor(private readonly jobDispatcher: JobDispatcher) {}

  dispatch(payload: TrackMatchingPayload): Promise<{ jobId: string }> {
    return this.jobDispatcher.dispatch({
      type: 'track_matching',
      payload: payload as unknown as Record<string, unknown>,
      timeoutSeconds: TRACK_MATCHING_TIMEOUT_SECONDS,
      work: ({ db: runDb }) => runTrackMatching(payload, { db: runDb }),
    });
  }
}
