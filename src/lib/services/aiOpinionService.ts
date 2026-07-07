import type { CompanyRepository } from '@/lib/repositories';
import type { DbClient } from '@/lib/repositories';
import { AiWorkforceQueueRepository } from '@/lib/repositories';
import { getPostHogClient } from '@/lib/posthog-server';
import { enqueueAgentRun } from '@/lib/workforce';

/** agent_name recorded on the AI Workforce queue row for AI Opinion runs. */
export const AI_OPINION_AGENT_NAME = 'ai_opinion';

export interface AiOpinionDispatchResult {
  runId: string;
}

/**
 * Drives the right-most "AI Opinion" pipeline column.
 *
 * Clicking "Analyze AI Opinion" (or "Re-evaluate") enqueues an AI Workforce
 * run that researches the company, forms a FIRM pass/fail/tentative verdict,
 * and finishes by calling the `save_ai_opinion` tool — which writes the
 * verdict + ≤50-word rationale back onto the `companies` row. The pipeline
 * tables poll the companies list and swap the spinner for the verdict icon
 * once `ai_opinion_status` flips to 'completed'.
 *
 * The verdict lives on `companies` (not a side table) so it travels with the
 * existing companies fetch and shows in the table without per-row requests.
 */
export class AiOpinionService {
  constructor(
    private readonly companyRepo: CompanyRepository,
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  /**
   * Enqueue an AI Opinion workforce run for a company.
   *
   * Idempotent on an in-flight run: if a non-terminal `ai_opinion` run already
   * exists for this company we return it instead of stacking a duplicate.
   * Marks the company `ai_opinion_status = 'processing'` (and clears any prior
   * verdict) so the UI shows a spinner immediately — this is a re-evaluation
   * when a verdict already exists.
   *
   * `triggeredByUserId` is the logged-in user who clicked the button; it owns
   * the resulting workforce run so the task is attributed to them.
   */
  async dispatch(
    companyId: string,
    triggeredByUserId?: string | null,
  ): Promise<AiOpinionDispatchResult> {
    const id = companyId?.trim();
    if (!id) throw new Error('Missing required field: companyId');

    const queueRepo = new AiWorkforceQueueRepository(this.db, this.workspaceId);
    const active = await queueRepo.findActiveByCompanyId(
      AI_OPINION_AGENT_NAME,
      id,
    );
    if (active) {
      // A run is already in flight — make sure the row reflects 'processing'
      // and reuse it rather than enqueueing a duplicate.
      await this.companyRepo.update(id, { ai_opinion_status: 'processing' });
      return { runId: active.id };
    }

    const company = await this.companyRepo.findById(id);
    const companyName = company.target || company.project_name || 'the company';

    // Flip to processing up front (and clear any stale verdict) so the column
    // shows a spinner the instant the user clicks, before the run completes.
    await this.companyRepo.update(id, {
      ai_opinion_status: 'processing',
      ai_opinion_verdict: null,
      ai_opinion_summary: null,
    });

    const instruction =
      `Analyze the AI Opinion for "${companyName}" (company_id: ${id}). ` +
      `Research the company with the read tools, then form a FIRM investment view and ` +
      `call the save_ai_opinion tool with company_id "${id}", a verdict of exactly one of ` +
      `pass / fail / tentative, and a summary of AT MOST 50 words justifying it. ` +
      `Be decisive: even if the automated AI Screening criteria all fail, do not default to ` +
      `"tentative" — give a firm pass or fail unless the evidence is genuinely balanced. ` +
      `Use "tentative" only as a last resort. ` +
      `Form the view independently, on fundamentals: do NOT read any recorded drop reason before ` +
      `deciding — only if your verdict disagrees with an existing drop decision should you then ` +
      `evaluate the drop reason and note the disagreement in your summary. Matched investment ` +
      `tracks are organizational only: matching no track is not a negative signal, and track fit ` +
      `should carry little weight in the verdict. ` +
      `After the tool returns, briefly report the verdict you recorded.`;

    const { runId } = await enqueueAgentRun(this.db, {
      agentName: AI_OPINION_AGENT_NAME,
      triggerSource: 'api',
      triggerMeta: { company_id: id },
      input: {
        title: `AI Opinion: ${companyName}`,
        instruction,
        prompt: instruction,
        company_id: id,
      },
      triggeredByUserId: triggeredByUserId ?? null,
    });

    getPostHogClient()?.capture({
      distinctId: triggeredByUserId ?? 'server',
      event: 'ai_opinion_requested',
      properties: {
        company_id: id,
        company_name: companyName,
        run_id: runId,
      },
    });

    return { runId };
  }
}
