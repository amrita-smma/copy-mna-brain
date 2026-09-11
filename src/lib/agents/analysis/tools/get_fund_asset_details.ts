import { tool } from '@langchain/core/tools';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from 'zod';
import { logger } from '../../logger';
import { createDb } from '@/lib/server/db';
import {
  FlAssetRepository,
  FlFundRepository,
  FlInvestorRepository,
  FlPositionRepository,
  FlValuationRepository,
  type Tables,
} from '@/lib/repositories';
import { fuzzySearch, matchLabel } from './fuzzySearch';

const fmtAmount = (n: number | string | null | undefined) => {
  if (n == null) return 'N/A';
  const num = typeof n === 'string' ? parseFloat(n) : n;
  return !isNaN(num) ? num.toLocaleString('en-US', { maximumFractionDigits: 0 }) : 'N/A';
};
const fmtMult = (n: number | string | null | undefined) => {
  if (n == null) return 'N/A';
  const num = typeof n === 'string' ? parseFloat(n) : n;
  return !isNaN(num) ? `${num.toFixed(2)}x` : 'N/A';
};
const fmtPct = (n: number | string | null | undefined) => {
  if (n == null) return 'N/A';
  const num = typeof n === 'string' ? parseFloat(n) : n;
  return !isNaN(num) ? `${(num * 100).toFixed(1)}%` : 'N/A';
};
const fmtStakePct = (n: number | string | null | undefined) => {
  if (n == null) return 'N/A';
  const num = typeof n === 'string' ? parseFloat(n) : n;
  return !isNaN(num) ? `${num}%` : 'N/A';
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Get detailed information about a single fund holding using Fund Ledger v2.
 * Mirrors get_company_details for the funds domain.
 */
export const getFundAssetDetails = tool(
  async ({
    asset_id,
    fund_asset_id,
    asset_name,
  }: {
    asset_id?: string;
    fund_asset_id?: string;
    asset_name?: string;
  }) => {
    const rawId = (asset_id ?? fund_asset_id)?.trim() ?? '';
    const rawName = asset_name?.trim() ?? '';
    const id = rawId && UUID_RE.test(rawId) ? rawId : '';
    const name = rawName || (!id && rawId ? rawId : '');
    logger.debug(
      `🔧 TOOL CALLED: get_fund_asset_details(asset_id='${rawId}', asset_name='${rawName}')`,
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
      const assetRepo = new FlAssetRepository(db);
      const valuationRepo = new FlValuationRepository(db);
      const positionRepo = new FlPositionRepository(db);
      const fundRepo = new FlFundRepository(db);
      const investorRepo = new FlInvestorRepository(db);

      let asset = id ? await assetRepo.findById(workspaceId, id) : undefined;

      if (!asset && name) {
        const allAssets = await assetRepo.findByWorkspaceId(workspaceId);
        const matches = fuzzySearch(name, allAssets, (a) => [
          a.name,
          a.legal_name,
        ]);

        if (matches.length === 0) {
          return (
            `No fund asset found matching "${name}". ` +
            'Try search_investments to check whether the name is a fund, investor, or capital source instead, ' +
            'or query_fund_assets to browse available holdings.'
          );
        }

        const decisive =
          matches.length === 1 || matches[0].score - matches[1].score >= 0.15;

        if (!decisive) {
          let out =
            `Multiple holdings match "${name}" (${matches.length}). ` +
            'Call again with fund_asset_id to pick one:\n\n';
          out += `| Match | Fund Asset ID | Asset | Legal Name | Status |\n`;
          out += `| --- | --- | --- | --- | --- |\n`;
          for (const m of matches.slice(0, 15)) {
            out += `| ${matchLabel(m.score)} | ${m.item.id} | ${m.item.name ?? '-'} | ${
              m.item.legal_name ?? '-'
            } | active |\n`;
          }
          if (matches.length > 15) {
            out += `\n…and ${matches.length - 15} more. Narrow the name or pick an ID from query_fund_assets.`;
          }
          return out;
        }

        asset = matches[0].item;
      }

      if (!asset) {
        return (
          `No fund asset found for fund_asset_id "${id}". ` +
          'Use query_fund_assets to browse available holdings.'
        );
      }

      const terms = (asset.instrument_terms as Record<string, unknown>) ?? {};
      const aiOpinion = (terms.aiOpinion as Record<string, unknown>) ?? {};

      const [valuations, positions] = await Promise.all([
        valuationRepo.findSeriesByTarget(workspaceId, { assetId: asset.id }),
        positionRepo.findByAssetIds(workspaceId, [asset.id]),
      ]);

      const holdingFundIds = [
        ...new Set(positions.map((p) => p.holder_fund_id).filter((fid): fid is string => Boolean(fid))),
      ];
      const holdingInvestorIds = [
        ...new Set(positions.map((p) => p.holder_investor_id).filter((iid): iid is string => Boolean(iid))),
      ];

      const [funds, directInvestors] = await Promise.all([
        holdingFundIds.length > 0
          ? fundRepo.findByIds(workspaceId, holdingFundIds)
          : Promise.resolve<Tables<'fl_funds'>[]>([]),
        holdingInvestorIds.length > 0
          ? investorRepo.findByIds(workspaceId, holdingInvestorIds)
          : Promise.resolve<Tables<'fl_investors'>[]>([]),
      ]);

      const investorById = new Map<string, Tables<'fl_investors'>>();
      for (const inv of directInvestors) {
        investorById.set(inv.id, inv);
      }
      const missingParentIds = [
        ...new Set(
          directInvestors
            .map((inv) => inv.parent_investor_id)
            .filter((pid): pid is string => Boolean(pid) && !investorById.has(pid)),
        ),
      ];
      if (missingParentIds.length > 0) {
        const parentInvestors = await investorRepo.findByIds(workspaceId, missingParentIds);
        for (const pinv of parentInvestors) {
          investorById.set(pinv.id, pinv);
        }
      }

      const fundNameById = new Map<string, string>();
      for (const f of funds) {
        fundNameById.set(f.id, f.name);
      }
      const fundNames = holdingFundIds.map((fid) => fundNameById.get(fid) ?? fid);
      const investorLabels = holdingInvestorIds.map((iid) => {
        const inv = investorById.get(iid);
        if (!inv) return iid;
        if (inv.parent_investor_id) {
          const parent = investorById.get(inv.parent_investor_id);
          const parentName = parent?.name ?? inv.parent_investor_id;
          return `${inv.name} (${parentName})`;
        }
        return inv.name;
      });

      const allHolders = [...fundNames, ...investorLabels];
      const holderLabel = allHolders.length > 0 ? allHolders.join(', ') : '(unassigned)';

      const recent = valuations.slice(-8).reverse();
      const currency = valuations[0]?.currency ?? 'USD';

      let valuationSection = '### Valuation History\nNo valuation history on record.\n';
      if (recent.length > 0) {
        valuationSection =
          '### Valuation History (most recent first)\n' +
          '| As of | FMV | Price/Unit | Method |\n' +
          '| --- | --- | --- | --- |\n' +
          recent
            .map(
              (v) =>
                `| ${v.as_of_date} | ${fmtAmount(v.market_value ?? v.net_value)} ${v.currency ?? currency} | ${v.price_per_unit ?? '-'} | ${v.valuation_method ?? 'at_cost'} |`,
            )
            .join('\n') +
          '\n';
      }

      const opinionSection =
        aiOpinion.verdict || aiOpinion.status
          ? `### AI Opinion
- **Verdict:** ${aiOpinion.verdict ?? 'N/A'}
- **Confidence:** ${aiOpinion.confidence ?? 'N/A'}
- **Status:** ${aiOpinion.status ?? 'N/A'}
- **Updated:** ${aiOpinion.updated_at ?? 'N/A'}
${aiOpinion.summary ? `- **Summary:** ${aiOpinion.summary}\n` : ''}${
              aiOpinion.data_gaps
                ? `- **Data gaps:** ${aiOpinion.data_gaps}\n`
                : ''
            }`
          : '';

      const displayName = asset.name || asset.legal_name || 'Unknown';
      const result = `## Fund Asset Details: ${displayName}

### Identity
- **Fund Asset ID (UUID):** ${asset.id}
- **Asset Name:** ${asset.name ?? 'N/A'}
- **Legal Name:** ${asset.legal_name ?? 'N/A'}
- **Holders:** ${holderLabel}
- **Type:** ${asset.asset_kind ?? 'equity'}
- **Status:** active
- **Sector:** ${asset.sector ?? 'N/A'}${asset.sub_sector ? ` / ${asset.sub_sector}` : ''}
- **Country:** ${asset.country ?? 'N/A'}
- **Ownership stake:** ${fmtStakePct((terms.stakePct ?? terms.stake_pct) as any)}
- **Investment currency:** ${currency}
- **Report currency:** ${currency}

${terms.keyRights ?? terms.key_rights ? `### Key Rights\n${terms.keyRights ?? terms.key_rights}\n\n` : ''}${
        asset.description
          ? `### Description\n${asset.description}\n\n`
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
    description: `Get detailed information about a specific fund holding (fl_assets row) by UUID or name.

Use this when the user asks about a specific holding's metrics, description, rights, valuation marks, or AI Opinion — or when diving deeper into an existing Fund AI Opinion. Prefer \`fund_asset_id\` / \`asset_id\` when known; fall back to \`asset_name\`.

Args:
    asset_id: Optional UUID of the fl_assets row (preferred when known)
    fund_asset_id: Optional legacy alias for asset_id
    asset_name: Optional asset or legal name (partial match). Used when id is omitted.

Returns:
    Detailed holding profile including Fund Asset ID (UUID), fund membership, performance metrics, description/key rights, recent valuation history, and any stored AI Opinion.`,
    schema: z.object({
      asset_id: z
        .string()
        .optional()
        .describe('UUID of the fl_assets row (preferred when known)'),
      fund_asset_id: z
        .string()
        .optional()
        .describe('Legacy alias for asset_id'),
      asset_name: z
        .string()
        .optional()
        .describe('Asset or legal name (partial match) when id is unknown'),
    }),
  },
);
