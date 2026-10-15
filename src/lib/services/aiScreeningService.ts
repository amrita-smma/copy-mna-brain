import type { ScreeningRepository } from '@/lib/repositories';
import {
  runAIScreening,
  AI_SCREENING_TIMEOUT_SECONDS,
  type AIScreeningPayload,
} from '@/lib/jobs/handlers/aiScreening';
import type { JobDispatcher } from './jobDispatcher';

export class AIScreeningService {
  constructor(
    private readonly screeningRepo: ScreeningRepository,
    private readonly jobDispatcher: JobDispatcher,
  ) {}

  dispatch(payload: AIScreeningPayload): Promise<{ jobId: string }> {
    return this.jobDispatcher.dispatch({
      type: 'ai_screening',
      payload: payload as unknown as Record<string, unknown>,
      timeoutSeconds: AI_SCREENING_TIMEOUT_SECONDS,
      work: ({ db: runDb, job }) => runAIScreening(payload, { db: runDb, job }),
    });
  }

  /**
   * Screen one criterion and wait for the result, as its own `ai_screening`
   * job row. For the Pending Confirmation auto-scan, which runs inside a
   * background job of its own and needs every criterion finished before it
   * can decide to drop or promote.
   */
  runInline(payload: AIScreeningPayload): Promise<{ jobId: string }> {
    return this.jobDispatcher.runInline({
      type: 'ai_screening',
      payload: payload as unknown as Record<string, unknown>,
      timeoutSeconds: AI_SCREENING_TIMEOUT_SECONDS,
      work: ({ db: runDb, job }) => runAIScreening(payload, { db: runDb, job }),
    });
  }
}
