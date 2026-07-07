import {
  runMarketScreening,
  MARKET_SCREENING_TIMEOUT_SECONDS,
  type MarketScreeningPayload,
} from '@/lib/jobs/handlers/marketScreening';
import type { JobDispatcher } from './jobDispatcher';

export class MarketScreeningService {
  constructor(private readonly jobDispatcher: JobDispatcher) {}

  dispatch(payload: MarketScreeningPayload): Promise<{ jobId: string }> {
    return this.jobDispatcher.dispatch({
      type: 'market_screening',
      payload: payload as unknown as Record<string, unknown>,
      timeoutSeconds: MARKET_SCREENING_TIMEOUT_SECONDS,
      work: ({ db: runDb, job }) => runMarketScreening(payload, { db: runDb, workspaceId: job.workspace_id }),
    });
  }
}
