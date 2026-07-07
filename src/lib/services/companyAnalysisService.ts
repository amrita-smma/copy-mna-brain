import type { CompanyAnalysisRepository, CompanyRepository } from '@/lib/repositories';
import type { Tables } from '@/lib/repositories';
import type { DbClient } from '@/lib/repositories';
import { AiWorkforceQueueRepository } from '@/lib/repositories';
import type { CompanyAnalysisPayload } from '@/lib/jobs/handlers/companyAnalysis';
import { enqueueAgentRun } from '@/lib/workforce';

/** agent_name recorded on the AI Workforce queue row for card-generation runs. */
export const COMPANY_CARD_AGENT_NAME = 'company_card';

export class CompanyAnalysisService {
  constructor(
    private readonly companyAnalysisRepo: CompanyAnalysisRepository,
    private readonly companyRepo: CompanyRepository,
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  findByCompanyId(companyId: string) {
    return this.companyAnalysisRepo.findByCompanyId(companyId);
  }

  /**
   * Generate the AI Company Card via the AI Workforce.
   *
   * Previously a `company_analysis` job; now enqueues a workforce run that
   * drives the `generate_company_card` tool. The tool both persists the card
   * (which the Company Card UI polls for via findByCompanyId) and links the
   * company's related companies into the relationship graph.
   *
   * Idempotent on a *completed* card: if one already exists we return it
   * without enqueueing. Regeneration deletes the row first (see delete), so a
   * fresh run is enqueued.
   *
   * `triggeredByUserId` is the logged-in user who clicked "Generate Company
   * Card". It owns the resulting AI Workforce run so the task is attributed to
   * them (not "System") in the UI and the completion email goes to them.
   */
  async dispatch(
    payload: CompanyAnalysisPayload,
    triggeredByUserId?: string | null,
  ): Promise<{ runId: string } | { existing: Tables<'company_analyses'> }> {
    const existing = await this.companyAnalysisRepo.findCompletedByCompanyId(payload.companyId);
    if (existing) return { existing };

    const company = await this.companyRepo.findById(payload.companyId);
    const companyName = company?.target || company?.project_name || 'the company';

    const instruction =
      `Generate the AI Company Card for "${companyName}" (company_id: ${payload.companyId}). ` +
      `Call the generate_company_card tool with company_id "${payload.companyId}". ` +
      `It researches the company, produces and saves the structured Company Card, and links the company's ` +
      `related companies (suppliers, partners, investors) into the relationship graph — creating any unknown ` +
      `company at the "discovered" stage. After it returns, briefly summarise what was produced and which ` +
      `related companies were linked.`;

    const { runId } = await enqueueAgentRun(this.db, {
      agentName: COMPANY_CARD_AGENT_NAME,
      triggerSource: 'api',
      triggerMeta: { company_id: payload.companyId, source: payload.source ?? null },
      input: {
        title: `Company card: ${companyName}`,
        instruction,
        prompt: instruction,
        company_id: payload.companyId,
      },
      triggeredByUserId: triggeredByUserId ?? null,
    });

    return { runId };
  }

  /**
   * Cancel an in-flight Company Card generation for a company.
   *
   * Finds the non-terminal AI Workforce run for this company (matched on
   * trigger_meta.company_id, so it works even when the client doesn't hold the
   * runId — e.g. after a reload) and flips it to a terminal cancelled state.
   * Also clears the `company_analyses` row so the UI resets back to the
   * "Generate AI Company Card" state.
   *
   * Returns whether a running queue row was found and cancelled.
   */
  async cancelDispatch(
    companyId: string,
    cancelledByUserId?: string | null,
  ): Promise<{ cancelled: boolean }> {
    const queueRepo = new AiWorkforceQueueRepository(this.db, this.workspaceId);
    const active = await queueRepo.findActiveByCompanyId(
      COMPANY_CARD_AGENT_NAME,
      companyId,
    );

    let cancelled = false;
    if (active) {
      const row = await queueRepo.cancelById(active.id, {
        userId: cancelledByUserId ?? null,
        reason: 'Company Card generation cancelled by user',
      });
      cancelled = row != null;
    }

    // Drop any in-progress analysis row so the UI returns to the pre-generation
    // state. A completed card is left untouched.
    const existing = await this.companyAnalysisRepo.findByCompanyId(companyId);
    if (existing && existing.status !== 'completed') {
      await this.companyAnalysisRepo.deleteByCompanyId(companyId);
    }

    return { cancelled };
  }

  delete(companyId: string) {
    return this.companyAnalysisRepo.deleteByCompanyId(companyId);
  }
}
