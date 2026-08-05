import type { DbClient } from '@/lib/repositories';
import { CompanyRepository, FundAssetRepository } from '@/lib/repositories';

/**
 * Queue `agent_name` values that own an entity's `ai_opinion_status` spinner.
 * Must stay in sync with `AI_OPINION_AGENT_NAME` / `FUND_AI_OPINION_AGENT_NAME`
 * on the dispatch services. Kept as literals here to avoid a services↔workforce
 * import cycle.
 */
const AI_OPINION_AGENT_NAMES = new Set(['ai_opinion', 'fund_ai_opinion']);

/**
 * When an AI Opinion workforce run ends without writing a verdict (agent
 * failure, cancel, reaper, or a "succeeded" run that never called
 * save_*_ai_opinion), flip the target entity out of `ai_opinion_status =
 * 'processing'` so the UI spinner / portfolio poll do not run forever.
 *
 * Only runs for `ai_opinion` / `fund_ai_opinion` queue rows — other agents
 * (e.g. `company_card`) also stash `company_id` in trigger_meta and must not
 * clear a concurrent opinion run's spinner.
 *
 * Only touches rows still in `'processing'` so a late successful tool write
 * is not clobbered by a subsequent terminal queue transition.
 */
export async function failAiOpinionIfStillProcessing(
  db: DbClient,
  workspaceId: string,
  triggerMeta: unknown,
  agentName: string | null | undefined,
): Promise<void> {
  if (!agentName || !AI_OPINION_AGENT_NAMES.has(agentName)) return;
  if (!triggerMeta || typeof triggerMeta !== 'object') return;
  const meta = triggerMeta as Record<string, unknown>;

  const fundAssetId =
    typeof meta.fund_asset_id === 'string' ? meta.fund_asset_id.trim() : '';
  if (fundAssetId) {
    try {
      const repo = new FundAssetRepository(db, workspaceId);
      await repo.markAiOpinionFailedIfProcessing(fundAssetId);
    } catch (err) {
      console.error(
        `[failAiOpinionIfStillProcessing] fund_asset ${fundAssetId}:`,
        err,
      );
    }
  }

  const companyId =
    typeof meta.company_id === 'string' ? meta.company_id.trim() : '';
  if (companyId) {
    try {
      const repo = new CompanyRepository(db, workspaceId);
      await repo.markAiOpinionFailedIfProcessing(companyId);
    } catch (err) {
      console.error(
        `[failAiOpinionIfStillProcessing] company ${companyId}:`,
        err,
      );
    }
  }
}
