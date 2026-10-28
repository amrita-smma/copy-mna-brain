import type { DbClient } from '@/lib/repositories';
import { ScreeningRepository } from '@/lib/repositories';
import { publishLiveEvent } from '@/lib/server/liveEvents';
import { LIVE_TOPICS } from '@/lib/live/topics';

/**
 * Queue `agent_name` of the per-company AI screening task. Must stay in sync
 * with `AI_SCREENING_AGENT_NAME` in `aiScreeningService.ts`; a literal here
 * avoids a services↔workforce import cycle.
 */
const AI_SCREENING_AGENT_NAME = 'ai_screening';

function companyIdFromAiScreeningRow(
  triggerMeta: unknown,
  queueInput?: unknown,
): string {
  if (triggerMeta && typeof triggerMeta === 'object') {
    const raw = (triggerMeta as Record<string, unknown>).company_id;
    const fromMeta = typeof raw === 'string' ? raw.trim() : '';
    if (fromMeta) return fromMeta;
  }
  if (queueInput && typeof queueInput === 'object') {
    const raw = (queueInput as Record<string, unknown>).company_id;
    return typeof raw === 'string' ? raw.trim() : '';
  }
  return '';
}

/**
 * When an AI screening task ends (failure, cancel, reaper, or a "succeeded"
 * run that never finished `run_ai_screening`), fail the company's screenings
 * still at `pending` so the Pipeline's AI Screening tab doesn't show them in
 * progress forever. A forced run resets them to pending at enqueue time.
 *
 * Only touches rows still `pending`, so results the tool did write survive.
 * Never throws — it runs inside terminal queue transitions.
 */
export async function failScreeningsIfStillPending(
  db: DbClient,
  workspaceId: string,
  triggerMeta: unknown,
  agentName: string | null | undefined,
  queueInput?: unknown,
): Promise<void> {
  if (agentName !== AI_SCREENING_AGENT_NAME) return;
  const companyId = companyIdFromAiScreeningRow(triggerMeta, queueInput);
  if (!companyId) return;
  try {
    const failed = await new ScreeningRepository(db, workspaceId).markPendingFailedForCompany(
      companyId,
      'The AI screening task ended before this criterion was screened',
    );
    if (failed > 0) await publishLiveEvent(workspaceId, LIVE_TOPICS.screenings);
  } catch (err) {
    console.error(`[failScreeningsIfStillPending] company ${companyId}:`, err);
  }
}
