import type { FundAssetRepository, FundAssetValuationRepository } from '@/lib/repositories';
import type { DbClient } from '@/lib/repositories';
import { AiWorkforceQueueRepository } from '@/lib/repositories';
import { captureWorkspaceEvent } from '@/lib/posthog-server';
import { enqueueAgentRun } from '@/lib/workforce';
import {
  assessFundAiOpinionDataSufficiency,
  formatFundAiOpinionDataGaps,
} from './fundAiOpinionDataSufficiency';

/** agent_name recorded on the AI Workforce queue row for Fund AI Opinion runs. */
export const FUND_AI_OPINION_AGENT_NAME = 'fund_ai_opinion';

export interface FundAiOpinionDispatchResult {
  runId: string;
}

/**
 * Drives the right-most "AI Opinion" column on the Fund Management Asset
 * table (MB-470). Clicking "Analyze AI Opinion" (or "Re-evaluate") enqueues
 * an AI Workforce run — at HIGH effort (Opus) — that reviews the holding's
 * metrics (inlined into the instruction) plus web research, takes a FIRM
 * buy/hold/sell verdict, and finishes by calling the `save_fund_ai_opinion`
 * tool, which writes the verdict + ≤50-word rationale back onto the
 * `fund_assets` row. The portfolio poll picks up the verdict once
 * `ai_opinion_status` flips to 'completed'.
 *
 * The verdict lives on `fund_assets` (not a side table) so it travels with
 * the existing portfolio fetch (`FundPortfolioService.getPortfolio`) without
 * a per-holding request.
 */
export class FundAiOpinionService {
  constructor(
    private readonly fundAssetRepo: FundAssetRepository,
    private readonly valuationRepo: FundAssetValuationRepository,
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  /**
   * Enqueue a Fund AI Opinion workforce run for a holding.
   *
   * Idempotent on an in-flight run: if a non-terminal `fund_ai_opinion` run
   * already exists for this holding we return it instead of stacking a
   * duplicate. Marks the holding `ai_opinion_status = 'processing'` (and
   * clears any prior verdict) so the UI shows a spinner immediately — this
   * is a re-evaluation when a verdict already exists.
   */
  async dispatch(
    fundAssetId: string,
    triggeredByUserId?: string | null,
  ): Promise<FundAiOpinionDispatchResult> {
    const id = fundAssetId?.trim();
    if (!id) throw new Error('Missing required field: fundAssetId');

    const queueRepo = new AiWorkforceQueueRepository(this.db, this.workspaceId);
    const active = await queueRepo.findActiveByFundAssetId(
      FUND_AI_OPINION_AGENT_NAME,
      id,
    );
    if (active) {
      // A run is already in flight — make sure the row reflects 'processing'
      // and reuse it rather than enqueueing a duplicate.
      await this.fundAssetRepo.update(id, { ai_opinion_status: 'processing' });
      return { runId: active.id };
    }

    const asset = await this.fundAssetRepo.findById(id);
    if (!asset) throw new Error(`No fund asset found for id "${id}"`);
    const assetName = asset.asset_name || asset.legal_name || 'the holding';

    // Flip to processing up front (and clear any stale verdict) so the column
    // shows a spinner the instant the user clicks, before the run completes.
    await this.fundAssetRepo.update(id, {
      ai_opinion_status: 'processing',
      ai_opinion_verdict: null,
      ai_opinion_summary: null,
      ai_opinion_confidence: null,
      ai_opinion_data_gaps: null,
    });

    const fmt = (n: number | null | undefined) =>
      n != null ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : 'unknown';
    const fmtMult = (n: number | null | undefined) => (n != null ? `${n.toFixed(2)}x` : 'unknown');
    const fmtPct = (n: number | null | undefined) =>
      n != null ? `${(n * 100).toFixed(1)}%` : 'unknown';
    // stake_pct is stored as percent points (e.g. 12.5 = 12.5%), matching the UI.
    const fmtStakePct = (n: number | null | undefined) => (n != null ? `${n}%` : 'unknown');

    let runId: string;
    try {
      // Everything after the optimistic 'processing' flip must be in this try —
      // a thrown valuation fetch (or instruction build) would otherwise leave
      // the holding stuck with no queue row for failAiOpinionIfStillProcessing.
      const currency = asset.report_currency ?? 'USD';
      const valuations = await this.valuationRepo.findByFundAssetId(id);
      const recent = valuations.slice(0, 8);
      const valuationHistory =
        recent.length === 0
          ? 'No valuation history on record.'
          : 'Valuation history (most recent first): ' +
            recent
              .map(
                (v) =>
                  `${v.as_of_date}: FMV ${fmt(v.market_value_amount)} ${v.currency ?? currency}, ` +
                  `MOIC ${fmtMult(v.gross_moic)}, DPI ${fmtMult(v.dpi)}, IRR ${fmtPct(v.gross_xirr)}`,
              )
              .join('; ') +
            '.';

      const sufficiency = assessFundAiOpinionDataSufficiency(asset, valuations.length);
      const gapsNote = formatFundAiOpinionDataGaps(sufficiency.dataGaps);
      const sparseNote = sufficiency.isSparse
        ? ` NOTE: this holding has sparse recorded data` +
          (gapsNote ? ` (${gapsNote})` : '') +
          ` — be decisive about the verdict, but set confidence no higher than ` +
          `"${sufficiency.maxConfidence}" and reflect the thin basis honestly. `
        : ` Recorded data looks reasonably complete — you may use confidence up to ` +
          `"${sufficiency.maxConfidence}". `;

      const unfundedAmount =
        asset.commitment_amount != null && asset.invested_capital_amount != null
          ? asset.commitment_amount - asset.invested_capital_amount
          : null;
      // Omit when over-called / negative — a negative "unfunded" misleads the agent.
      const unfunded =
        unfundedAmount != null && unfundedAmount >= 0
          ? ` Unfunded commitment: ${fmt(unfundedAmount)} ${currency}.`
          : '';

      const metrics =
        `Type: ${asset.asset_type ?? 'unknown'}. Sector: ${asset.sector ?? 'unknown'}` +
        `${asset.sub_sector ? ` / ${asset.sub_sector}` : ''}. Status: ${asset.status}. ` +
        `Country: ${asset.country ?? 'unknown'}. ` +
        `Ownership stake: ${fmtStakePct(asset.stake_pct)}. ` +
        `Invested capital: ${fmt(asset.invested_capital_amount)} ${currency}. ` +
        `Commitment: ${fmt(asset.commitment_amount)} ${currency}.` +
        unfunded +
        ` Fair market value: ${fmt(asset.fmv_amount)} ${currency}. ` +
        `Net distributions (realized value): ${fmt(asset.net_distribution_amount)}. ` +
        `Gross MOIC: ${fmtMult(asset.gross_moic)}. Gross IRR: ${fmtPct(asset.gross_irr)}. ` +
        `DPI: ${fmtMult(asset.dpi)}. ` +
        `Entry date: ${asset.entry_date ?? 'unknown'}. ` +
        `Maturity date: ${asset.maturity_date ?? 'n/a'}.` +
        (asset.key_rights ? ` Key rights: ${asset.key_rights}.` : '') +
        (asset.investment_description ? ` Description: ${asset.investment_description}` : '') +
        ` ${valuationHistory}`;

      const instruction =
        `Analyze the AI Opinion for the fund holding "${assetName}" (fund_asset_id: ${id}). ` +
        `Here is the holding's recorded data: ${metrics} ` +
        sparseNote +
        `Weigh the direction of the valuation trend (rising, flat, or falling marks) in ` +
        `your buy/hold/sell call. Before web_search, check internal notes and records for ` +
        `this holding by name (query_files / get_company_details / query_companies) — fund ` +
        `holdings have no FK to the M&A pipeline, so name matches may miss or collide; only ` +
        `rely on a record you are confident is the same entity. ` +
        `Use web_search for external market context (industry trends, comparable valuations, ` +
        `sector outlook) as needed, then take a FIRM, decisive investment stance and call the ` +
        `save_fund_ai_opinion tool with fund_asset_id "${id}", a verdict of exactly one of ` +
        `buy / hold / sell, a confidence of exactly one of high / medium / low (not above ` +
        `"${sufficiency.maxConfidence}"), and a summary of AT MOST 50 words justifying it. ` +
        `Commit to a clear call: "buy" means the outlook is attractive (add exposure if you ` +
        `could — many PE/LP holdings are illiquid), "sell" if you'd exit it, ` +
        `"hold" only when the position is fairly valued and there is no strong signal either way — ` +
        `do NOT use "hold" as a way to avoid a decision when the evidence actually points to buy or sell. ` +
        `Be decisive about the verdict; be honest about the basis via confidence. ` +
        `In the summary, cite concrete figures from the recorded data (MOIC, FMV, IRR, marks). ` +
        `If web research found nothing reliable or the entity could not be confirmed, say so. ` +
        `Write the summary in direct language — state your verdict as a conclusion, not a ` +
        `possibility. Avoid hedging words such as "may", "might", "could", "possibly", "appears", or "seems". ` +
        `After the tool returns, briefly report the verdict you recorded.`;

      ({ runId } = await enqueueAgentRun(this.db, {
        agentName: FUND_AI_OPINION_AGENT_NAME,
        triggerSource: 'api',
        triggerMeta: { fund_asset_id: id },
        input: {
          title: `Fund AI Opinion: ${assetName}`,
          instruction,
          prompt: instruction,
          fund_asset_id: id,
          // Form the opinion at HIGH effort (Opus, the strongest model) so the
          // verdict is as firm and well-reasoned as possible. runAgent reads
          // input.effort ('medium' | 'high') to pick the workforce agent's model.
          effort: 'high',
        },
        triggeredByUserId: triggeredByUserId ?? null,
      }));
    } catch (err) {
      // Don't leave the holding stuck on 'processing' if valuation fetch or
      // enqueue fails after the optimistic status flip above.
      await this.fundAssetRepo.update(id, { ai_opinion_status: 'failed' });
      throw err;
    }

    captureWorkspaceEvent({
      workspaceId: this.workspaceId,
      distinctId: triggeredByUserId ?? 'server',
      event: 'fund_ai_opinion_requested',
      properties: {
        fund_asset_id: id,
        asset_name: assetName,
        run_id: runId,
      },
    });

    return { runId };
  }
}
