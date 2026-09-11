import type {
  DbClient,
  FlAssetRepository,
  FlPositionRepository,
  FlValuationRepository,
} from '@/lib/repositories';
import type { FlBalanceService } from './flBalanceService';
import { AiWorkforceQueueRepository } from '@/lib/repositories';
import { captureWorkspaceEvent } from '@/lib/posthog-server';
import { enqueueAgentRun } from '@/lib/workforce';
import { flSum } from './flDecimal';
import { EntityNotFoundError, InvalidMasterDataError } from './flErrors';
import {
  assessFundAiOpinionDataSufficiency,
  formatFundAiOpinionDataGaps,
} from './fundAiOpinionDataSufficiency';

/** agent_name recorded on the AI Workforce queue row for Fund AI Opinion runs. */
export const FUND_AI_OPINION_AGENT_NAME = 'fund_ai_opinion';

export interface FundAiOpinionDispatchResult {
  runId: string;
}

export interface FlAssetAiOpinion {
  verdict?: 'buy' | 'hold' | 'sell' | null;
  summary?: string | null;
  status?: 'processing' | 'completed' | 'failed' | null;
  updated_at?: string | null;
  confidence?: 'high' | 'medium' | 'low' | null;
  data_gaps?: string | null;
}

/**
 * Drives the right-most "AI Opinion" column on the Fund Management Asset
 * table using Fund Ledger v2 storage (fl_assets.instrument_terms.aiOpinion).
 *
 * Clicking "Analyze AI Opinion" (or "Re-evaluate") enqueues an AI Workforce
 * run — at HIGH effort (Opus) — that reviews the holding's metrics, takes a
 * FIRM buy/hold/sell verdict, and finishes by calling the `save_fund_ai_opinion`
 * tool, which writes the verdict + <=50-word rationale back onto the
 * `fl_assets.instrument_terms.aiOpinion` JSON object.
 */
export class FundAiOpinionService {
  constructor(
    private readonly assetRepo: FlAssetRepository,
    private readonly valuationRepo: FlValuationRepository,
    private readonly db: DbClient,
    private readonly workspaceId: string,
    private readonly positionRepo?: FlPositionRepository,
    private readonly balanceService?: FlBalanceService,
  ) {}

  /**
   * Enqueue a Fund AI Opinion workforce run for a holding.
   *
   * Idempotent on an in-flight run: if a non-terminal `fund_ai_opinion` run
   * already exists for this holding we return it instead of stacking a
   * duplicate. Marks the holding `aiOpinion.status = 'processing'` (and
   * clears any prior verdict) so the UI shows a spinner immediately.
   */
  async dispatch(
    assetId: string,
    triggeredByUserId?: string | null,
  ): Promise<FundAiOpinionDispatchResult> {
    const id = assetId?.trim();
    if (!id) throw new InvalidMasterDataError('Missing required field: assetId');

    const queueRepo = new AiWorkforceQueueRepository(this.db, this.workspaceId);
    const active = await queueRepo.findActiveByFundAssetId(
      FUND_AI_OPINION_AGENT_NAME,
      id,
    );

    const asset = await this.assetRepo.findById(this.workspaceId, id);
    if (!asset) {
      throw new EntityNotFoundError(`No fund asset found for id "${id}" in workspace ${this.workspaceId}`);
    }

    const existingTerms = (asset.instrument_terms as Record<string, unknown>) ?? {};
    const existingOpinion = (existingTerms.aiOpinion as FlAssetAiOpinion) ?? {};

    if (active) {
      // A run is already in flight — make sure the row reflects 'processing'
      // and reuse it rather than enqueueing a duplicate.
      if (existingOpinion.status !== 'processing') {
        await this.assetRepo.update(this.workspaceId, id, {
          instrument_terms: {
            ...existingTerms,
            aiOpinion: {
              ...existingOpinion,
              status: 'processing',
            },
          },
        });
      }
      return { runId: active.id };
    }

    const assetName = asset.name || asset.legal_name || 'the holding';

    // Flip to processing up front (and clear any stale verdict) so the column
    // shows a spinner the instant the user clicks, before the run completes.
    await this.assetRepo.update(this.workspaceId, id, {
      instrument_terms: {
        ...existingTerms,
        aiOpinion: {
          ...existingOpinion,
          status: 'processing',
          verdict: null,
          summary: null,
          confidence: null,
          data_gaps: null,
          updated_at: new Date().toISOString(),
        },
      },
    });

    const fmt = (n: number | string | null | undefined) => {
      if (n == null) return 'unknown';
      const num = typeof n === 'string' ? parseFloat(n) : n;
      return !isNaN(num) ? num.toLocaleString('en-US', { maximumFractionDigits: 0 }) : 'unknown';
    };

    let runId: string;
    try {
      const valuations = await this.valuationRepo.findSeriesByTarget(this.workspaceId, { assetId: id });
      const recent = valuations.slice(-8).reverse();
      const latestValuation = valuations[valuations.length - 1];
      const currency = latestValuation?.currency ?? 'USD';
      const valuationHistory =
        recent.length === 0
          ? 'No valuation history on record.'
          : 'Valuation history (most recent first): ' +
            recent
              .map(
                (v) =>
                  `${v.as_of_date}: Market Value ${fmt(v.market_value ?? v.net_value)} ${v.currency ?? currency}, ` +
                  `Price/unit ${v.price_per_unit ?? '-'}, Method ${v.valuation_method ?? 'at_cost'}`,
              )
              .join('; ') +
            '.';

      let investedCapital: string | null = null;
      let quantity: string | null = null;
      if (this.positionRepo && this.balanceService) {
        const positions = await this.positionRepo.findByAssetIds(this.workspaceId, [id]);
        if (positions.length > 0) {
          const balances = await this.balanceService.getPositionBalances(
            this.workspaceId,
            positions.map((p) => p.id),
          );
          if (balances.length > 0) {
            investedCapital = flSum(balances.map((b) => b.contributed));
            quantity = flSum(balances.map((b) => b.quantity));
          }
        }
      }

      const fmvAmount = latestValuation ? (latestValuation.market_value ? parseFloat(latestValuation.market_value) : (latestValuation.net_value ? parseFloat(latestValuation.net_value) : null)) : null;
      const investedAmount = investedCapital ? parseFloat(investedCapital) : null;
      const grossMoic = investedAmount && investedAmount > 0 && fmvAmount != null ? fmvAmount / investedAmount : null;

      const sufficiency = assessFundAiOpinionDataSufficiency(
        {
          sector: asset.sector,
          country: asset.country,
          investment_description: asset.description,
          fmv_amount: fmvAmount,
          invested_capital_amount: investedAmount,
          gross_moic: grossMoic,
          gross_irr: null,
        },
        valuations.length,
      );
      const gapsNote = formatFundAiOpinionDataGaps(sufficiency.dataGaps);
      const sparseNote = sufficiency.isSparse
        ? ` NOTE: this holding has sparse recorded data` +
          (gapsNote ? ` (${gapsNote})` : '') +
          ` — be decisive about the verdict, but set confidence no higher than ` +
          `"${sufficiency.maxConfidence}" and reflect the thin basis honestly. `
        : ` Recorded data looks reasonably complete — you may use confidence up to ` +
          `"${sufficiency.maxConfidence}". `;

      const metrics =
        `Kind: ${asset.asset_kind ?? 'equity'}. Sector: ${asset.sector ?? 'unknown'}` +
        `${asset.sub_sector ? ` / ${asset.sub_sector}` : ''}. ` +
        `Country: ${asset.country ?? 'unknown'}. ` +
        (investedCapital ? `Invested capital: ${fmt(investedCapital)} ${currency}. ` : '') +
        (quantity ? `Quantity / units: ${quantity}. ` : '') +
        (latestValuation ? `Fair market value: ${fmt(latestValuation.market_value ?? latestValuation.net_value)} ${currency}. ` : '') +
        (asset.description ? ` Description: ${asset.description}. ` : '') +
        ` ${valuationHistory}`;

      const instruction =
        `Analyze the AI Opinion for the fund holding "${assetName}" (asset_id: ${id}). ` +
        `Here is the holding's recorded data: ${metrics} ` +
        sparseNote +
        `Weigh the direction of the valuation trend (rising, flat, or falling marks) in ` +
        `your buy/hold/sell call. Before web_search, check internal notes and records for ` +
        `this holding by name (query_files / get_company_details / query_companies). ` +
        `Use web_search for external market context (industry trends, comparable valuations, ` +
        `sector outlook) as needed, then take a FIRM, decisive investment stance and call the ` +
        `save_fund_ai_opinion tool with asset_id "${id}", a verdict of exactly one of ` +
        `buy / hold / sell, a confidence of exactly one of high / medium / low (not above ` +
        `"${sufficiency.maxConfidence}"), and a summary of AT MOST 50 words justifying it. ` +
        `Commit to a clear call: "buy" means the outlook is attractive (add exposure if you ` +
        `could), "sell" if you'd exit it, ` +
        `"hold" only when the position is fairly valued and there is no strong signal either way — ` +
        `do NOT use "hold" as a way to avoid a decision when the evidence actually points to buy or sell. ` +
        `Be decisive about the verdict; be honest about the basis via confidence. ` +
        `In the summary, cite concrete figures from the recorded data (FMV, marks). ` +
        `If web research found nothing reliable or the entity could not be confirmed, say so. ` +
        `Write the summary in direct language — state your verdict as a conclusion, not a ` +
        `possibility. Avoid hedging words such as "may", "might", "could", "possibly", "appears", or "seems". ` +
        `After the tool returns, briefly report the verdict you recorded.`;

      ({ runId } = await enqueueAgentRun(this.db, {
        agentName: FUND_AI_OPINION_AGENT_NAME,
        triggerSource: 'api',
        triggerMeta: { asset_id: id, fund_asset_id: id },
        input: {
          title: `Fund AI Opinion: ${assetName}`,
          instruction,
          prompt: instruction,
          asset_id: id,
          fund_asset_id: id,
          effort: 'high',
        },
        triggeredByUserId: triggeredByUserId ?? null,
      }));
    } catch (err) {
      const freshAsset = await this.assetRepo.findById(this.workspaceId, id);
      if (freshAsset) {
        const freshTerms = (freshAsset.instrument_terms as Record<string, unknown>) ?? {};
        const freshOpinion = (freshTerms.aiOpinion as FlAssetAiOpinion) ?? {};
        await this.assetRepo.update(this.workspaceId, id, {
          instrument_terms: {
            ...freshTerms,
            aiOpinion: {
              ...freshOpinion,
              status: 'failed',
            },
          },
        });
      }
      throw err;
    }

    captureWorkspaceEvent({
      workspaceId: this.workspaceId,
      distinctId: triggeredByUserId ?? 'server',
      event: 'fund_ai_opinion_requested',
      properties: {
        asset_id: id,
        asset_name: assetName,
        run_id: runId,
      },
    });

    return { runId };
  }

  async clear(assetId: string): Promise<{ success: boolean }> {
    const id = assetId?.trim();
    if (!id) throw new InvalidMasterDataError('Missing required field: assetId');
    const asset = await this.assetRepo.findById(this.workspaceId, id);
    if (!asset) {
      throw new EntityNotFoundError(`No fund asset found for id "${id}" in workspace ${this.workspaceId}`);
    }

    const existingTerms = (asset.instrument_terms as Record<string, unknown>) ?? {};
    const { aiOpinion: _, ...remainingTerms } = existingTerms;

    await this.assetRepo.update(this.workspaceId, id, {
      instrument_terms: remainingTerms,
    });

    return { success: true };
  }

  async getOpinion(assetId: string): Promise<FlAssetAiOpinion | null> {
    const id = assetId?.trim();
    if (!id) throw new InvalidMasterDataError('Missing required field: assetId');
    const asset = await this.assetRepo.findById(this.workspaceId, id);
    if (!asset) {
      throw new EntityNotFoundError(`No fund asset found for id "${id}" in workspace ${this.workspaceId}`);
    }

    const terms = (asset.instrument_terms as Record<string, unknown>) ?? {};
    return (terms.aiOpinion as FlAssetAiOpinion) ?? null;
  }
}
