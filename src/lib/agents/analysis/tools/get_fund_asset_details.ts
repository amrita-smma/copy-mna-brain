import { tool } from '@langchain/core/tools';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from 'zod';
import { logger } from '../../logger';
import { createDb } from '@/lib/server/db';
import {
  FundAssetRepository,
  FundAssetTransactionRepository,
  FundAssetValuationRepository,
  FundRepository,
} from '@/lib/repositories';

const fmtAmount = (n: number | null | undefined) =>
  n != null ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : 'N/A';
const fmtMult = (n: number | null | undefined) => (n != null ? `${n.toFixed(2)}x` : 'N/A');
const fmtPct = (n: number | null | undefined) =>
  n != null ? `${(n * 100).toFixed(1)}%` : 'N/A';
/** stake_pct is stored as percent points (e.g. 12.5 = 12.5%), matching the UI. */
const fmtStakePct = (n: number | null | undefined) => (n != null ? `${n}%` : 'N/A');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Get detailed information about a single fund holding (fund_assets row).
 * Mirrors get_company_details for the funds domain: the list tool
 * (query_fund_assets) only returns a summary table; this tool returns the
 * full recorded profile + recent valuation history that Dive deeper / diligence
 * chats need.
 *
 * Prefer `fund_asset_id` when known (e.g. from a Dive deeper prompt). Fall back
 * to a case-insensitive partial match on asset_name / legal_name.
 */
export const getFundAssetDetails = tool(
  async ({
    fund_asset_id,
    asset_name,
  }: {
    fund_asset_id?: string;
    asset_name?: string;
  }) => {
    const rawId = fund_asset_id?.trim() ?? '';
    const rawName = asset_name?.trim() ?? '';
    // Agents sometimes put a name in fund_asset_id. Avoid Postgres UUID cast
    // errors by only treating well-formed UUIDs as ids; otherwise fall back
    // to name search using that string when asset_name was omitted.
    const id = rawId && UUID_RE.test(rawId) ? rawId : '';
    const name = rawName || (!id && rawId ? rawId : '');
    logger.debug(
      `🔧 TOOL CALLED: get_fund_asset_details(fund_asset_id='${rawId}', asset_name='${rawName}')`,
    );

    if (!id && !name) {
      return (
        'Please provide fund_asset_id or asset_name to look up. ' +
        'Use query_fund_assets to browse available holdings.'
      );
    }

    try {
      const workspaceId = await getActiveWorkspaceId();
      const db = createDb();
      const fundAssetRepo = new FundAssetRepository(db, workspaceId);
      const valuationRepo = new FundAssetValuationRepository(db, workspaceId);
      const txnRepo = new FundAssetTransactionRepository(db, workspaceId);
      const fundRepo = new FundRepository(db, workspaceId);

      let asset = id ? await fundAssetRepo.findById(id) : undefined;

      if (!asset && name) {
        const needle = name.toLowerCase();
        const matches = (await fundAssetRepo.findAll()).filter((a) => {
          const an = (a.asset_name ?? '').toLowerCase();
          const ln = (a.legal_name ?? '').toLowerCase();
          return an.includes(needle) || ln.includes(needle);
        });

        if (matches.length === 0) {
          return (
            `No fund asset found matching "${name}". ` +
            'Try a different search term or use query_fund_assets to browse available holdings.'
          );
        }

        if (matches.length > 1) {
          let out =
            `Multiple holdings match "${name}" (${matches.length}). ` +
            'Call again with fund_asset_id to pick one:\n\n';
          out += `| Fund Asset ID | Asset | Legal Name | Status |\n`;
          out += `| --- | --- | --- | --- |\n`;
          for (const m of matches.slice(0, 15)) {
            out += `| ${m.id} | ${m.asset_name ?? '-'} | ${m.legal_name ?? '-'} | ${m.status ?? '-'} |\n`;
          }
          if (matches.length > 15) {
            out += `\n…and ${matches.length - 15} more. Narrow the name or pick an ID from query_fund_assets.`;
          }
          return out;
        }

        asset = matches[0];
      }

      if (!asset) {
        return (
          `No fund asset found for fund_asset_id "${id}". ` +
          'Use query_fund_assets to browse available holdings.'
        );
      }

      const currency = asset.report_currency ?? asset.investment_currency ?? 'USD';
      const [valuations, txns, funds] = await Promise.all([
        valuationRepo.findByFundAssetId(asset.id),
        txnRepo.findByFundAssetId(asset.id),
        fundRepo.findAll(),
      ]);

      const fundNameById = new Map(funds.map((f) => [f.id, f.name]));
      const fundNames = [
        ...new Set(
          txns
            .map((t) => t.fund_id)
            .filter((fid): fid is string => Boolean(fid))
            .map((fid) => fundNameById.get(fid) ?? fid),
        ),
      ];
      const fundLabel =
        fundNames.length > 0 ? fundNames.join(', ') : '(unassigned)';

      const unfundedAmount =
        asset.commitment_amount != null && asset.invested_capital_amount != null
          ? asset.commitment_amount - asset.invested_capital_amount
          : null;
      const unfundedLabel =
        unfundedAmount != null && unfundedAmount >= 0
          ? `${fmtAmount(unfundedAmount)} ${currency}`
          : 'N/A';

      const recent = valuations.slice(0, 8);
      let valuationSection = '### Valuation History\nNo valuation history on record.\n';
      if (recent.length > 0) {
        valuationSection =
          '### Valuation History (most recent first)\n' +
          '| As of | FMV | MOIC | DPI | IRR |\n' +
          '| --- | --- | --- | --- | --- |\n' +
          recent
            .map(
              (v) =>
                `| ${v.as_of_date} | ${fmtAmount(v.market_value_amount)} ${v.currency ?? currency} | ${fmtMult(v.gross_moic)} | ${fmtMult(v.dpi)} | ${fmtPct(v.gross_xirr)} |`,
            )
            .join('\n') +
          '\n';
      }

      const opinionSection =
        asset.ai_opinion_verdict || asset.ai_opinion_status
          ? `### AI Opinion
- **Verdict:** ${asset.ai_opinion_verdict ?? 'N/A'}
- **Confidence:** ${asset.ai_opinion_confidence ?? 'N/A'}
- **Status:** ${asset.ai_opinion_status ?? 'N/A'}
- **Updated:** ${asset.ai_opinion_updated_at ?? 'N/A'}
${asset.ai_opinion_summary ? `- **Summary:** ${asset.ai_opinion_summary}\n` : ''}${
              asset.ai_opinion_data_gaps
                ? `- **Data gaps:** ${asset.ai_opinion_data_gaps}\n`
                : ''
            }`
          : '';

      const displayName = asset.asset_name || asset.legal_name || 'Unknown';
      const result = `## Fund Asset Details: ${displayName}

### Identity
- **Fund Asset ID (UUID):** ${asset.id}
- **Asset Name:** ${asset.asset_name ?? 'N/A'}
- **Legal Name:** ${asset.legal_name ?? 'N/A'}
- **Fund(s):** ${fundLabel}
- **Type:** ${asset.asset_type ?? 'N/A'}
- **Status:** ${asset.status ?? 'N/A'}
- **Sector:** ${asset.sector ?? 'N/A'}${asset.sub_sector ? ` / ${asset.sub_sector}` : ''}
- **Country:** ${asset.country ?? 'N/A'}
- **Ownership stake:** ${fmtStakePct(asset.stake_pct)}
- **Entry date:** ${asset.entry_date ?? 'N/A'}
- **Maturity date:** ${asset.maturity_date ?? 'N/A'}
- **Investment currency:** ${asset.investment_currency ?? 'N/A'}
- **Report currency:** ${asset.report_currency ?? 'N/A'}

### Performance
- **Invested capital:** ${fmtAmount(asset.invested_capital_amount)} ${currency}
- **Commitment:** ${fmtAmount(asset.commitment_amount)} ${currency}
- **Unfunded commitment:** ${unfundedLabel}
- **Fair market value (FMV):** ${fmtAmount(asset.fmv_amount)} ${currency}
- **Net distributions (realized):** ${fmtAmount(asset.net_distribution_amount)} ${currency}
- **Gross MOIC:** ${fmtMult(asset.gross_moic)}
- **Gross IRR:** ${fmtPct(asset.gross_irr)}
- **DPI:** ${fmtMult(asset.dpi)}
- **Share count:** ${asset.share_count != null ? String(asset.share_count) : 'N/A'}
- **Current price / share:** ${asset.current_price_per_share != null ? String(asset.current_price_per_share) : 'N/A'}

${asset.key_rights ? `### Key Rights\n${asset.key_rights}\n\n` : ''}${
        asset.investment_description
          ? `### Description\n${asset.investment_description}\n\n`
          : ''
      }${valuationSection}
${opinionSection}`;

      logger.debug(`✓ get_fund_asset_details retrieved for ${asset.id}`);
      return result.trim();
    } catch (error) {
      logger.error(`get_fund_asset_details error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'get_fund_asset_details',
    description: `Get detailed information about a specific fund holding (fund_assets row) by UUID or name.

Use this when the user asks about a specific holding's metrics, description, rights, valuation marks, or AI Opinion — or when diving deeper into an existing Fund AI Opinion. Prefer \`fund_asset_id\` when known (e.g. supplied in a Dive deeper prompt); fall back to \`asset_name\` for a case-insensitive partial match on asset_name / legal_name.

For browsing many holdings, use query_fund_assets instead.

Args:
    fund_asset_id: Optional UUID of the fund_assets row (preferred when known)
    asset_name: Optional asset or legal name (partial match). Used when fund_asset_id is omitted.

Returns:
    Detailed holding profile including Fund Asset ID (UUID), fund membership, performance metrics, description/key rights, recent valuation history, and any stored AI Opinion.`,
    schema: z.object({
      fund_asset_id: z
        .string()
        .optional()
        .describe('UUID of the fund_assets row (preferred when known)'),
      asset_name: z
        .string()
        .optional()
        .describe('Asset or legal name (partial match) when fund_asset_id is unknown'),
    }),
  },
);
