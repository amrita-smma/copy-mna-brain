import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import {
  FundAssetRepository,
  FundRepository,
  FundSourceRepository,
  HoldingEntityRepository,
} from '@/lib/repositories';
import { sourceOfFundsEnabled } from '@/lib/flags';
import { logger } from '../../logger';
import { fuzzySearch, matchLabel } from './fuzzySearch';

const fmtAmount = (n: number | null | undefined) =>
  n != null ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '-';
const fmtMult = (n: number | null | undefined) => (n != null ? `${n.toFixed(2)}x` : '-');
const fmtPct = (n: number | null | undefined) => (n != null ? `${(n * 100).toFixed(1)}%` : '-');

export type InvestmentEntityType = 'asset' | 'fund' | 'investor' | 'source';

const ENTITY_TYPES: readonly InvestmentEntityType[] = ['asset', 'fund', 'investor', 'source'];

const DEFAULT_LIMIT = 8;

/** How the agent should drill into each kind of hit once it has picked one. */
const NEXT_STEP: Record<InvestmentEntityType, string> = {
  asset: 'get_fund_asset_details with the `fund_asset_id` from the table',
  fund: 'query_fund_assets with `fund` set to the fund name (and query_funds for headline metrics)',
  investor: 'query_investors for the full LP table',
  source: 'query_fund_sources for the full capital-source table',
};

/**
 * Resolve a free-text name to the entities it could mean across the whole
 * investment portfolio — holdings, funds, investors (LPs), and sources of
 * capital — in ONE call.
 *
 * This is the entry point for "how is X doing?" style questions, where the
 * user has no idea (and no obligation to know) whether X is an asset, a fund,
 * an LP, or a capital pool. Matching is fuzzy (see ./fuzzySearch): legal
 * suffixes, partial words, acronyms, and typos all resolve.
 *
 * Read-only. Runs a fixed 5 queries regardless of portfolio size — four
 * findAll()s plus one batched asset→fund lookup — so there is no per-row
 * fan-out.
 */
export const searchInvestments = tool(
  async ({
    query,
    types,
    limit,
  }: {
    query: string;
    types?: InvestmentEntityType[];
    limit?: number;
  }) => {
    const needle = (query ?? '').trim();
    logger.debug(
      `🔧 TOOL CALLED: search_investments(query='${needle}', types='${(types ?? []).join(',')}')`,
    );

    if (!needle) {
      return 'Please provide a `query` — the name (or partial name) of the fund, holding, investor, or capital source to look for.';
    }

    const wanted = new Set<InvestmentEntityType>(
      types && types.length > 0 ? types : ENTITY_TYPES,
    );
    const cap = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), 25);

    try {
      // Honor the source-of-funds gate: when that flag is off the Copilot is
      // built without query_fund_sources, so this tool must not surface capital
      // sources either.
      if (wanted.has('source') && !(await sourceOfFundsEnabled().then(Boolean))) {
        wanted.delete('source');
      }

      const workspaceId = await getActiveWorkspaceId();
      const db = createDb();
      const fundRepo = new FundRepository(db, workspaceId);
      const fundAssetRepo = new FundAssetRepository(db, workspaceId);
      const investorRepo = new HoldingEntityRepository(db, workspaceId);
      const sourceRepo = new FundSourceRepository(db, workspaceId);

      const [funds, assets, investors, sources] = await Promise.all([
        wanted.has('fund') || wanted.has('asset') ? fundRepo.findAll() : Promise.resolve([]),
        wanted.has('asset') ? fundAssetRepo.findAll() : Promise.resolve([]),
        wanted.has('investor') ? investorRepo.findAll() : Promise.resolve([]),
        wanted.has('source') ? sourceRepo.findAll() : Promise.resolve([]),
      ]);

      const assetHits = wanted.has('asset')
        ? fuzzySearch(needle, assets, (a) => [a.asset_name, a.legal_name], { limit: cap })
        : [];
      const fundHits = wanted.has('fund')
        ? fuzzySearch(needle, funds, (f) => [f.name], { limit: cap })
        : [];
      const investorHits = wanted.has('investor')
        ? fuzzySearch(needle, investors, (i) => [i.name], { limit: cap })
        : [];
      const sourceHits = wanted.has('source')
        ? fuzzySearch(needle, sources, (s) => [s.name], { limit: cap })
        : [];

      const total =
        assetHits.length + fundHits.length + investorHits.length + sourceHits.length;

      if (total === 0) {
        const browse = (
          [
            ['asset', 'query_fund_assets'],
            ['fund', 'query_funds'],
            ['investor', 'query_investors'],
            ['source', 'query_fund_sources'],
          ] as Array<[InvestmentEntityType, string]>
        )
          .filter(([t]) => wanted.has(t))
          .map(([, toolName]) => toolName)
          .join(' / ');
        return (
          `No fund, holding, investor, or capital source in this workspace matches "${needle}".\n\n` +
          `Next: browse with ${browse} to see what exists, ` +
          'or — if this is an external company rather than a portfolio entity — research it with valyu_search or web_search.'
        );
      }

      // One batched query maps every asset to the fund(s) it sits in — never a
      // per-asset lookup (see the N+1 rules in CLAUDE.md).
      const fundNamesByAssetId = new Map<string, string[]>();
      if (assetHits.length > 0 && funds.length > 0) {
        const fundNameById = new Map(funds.map((f) => [f.id, f.name]));
        for (const { fundId, asset } of await fundAssetRepo.findByFundIds(funds.map((f) => f.id))) {
          const list = fundNamesByAssetId.get(asset.id) ?? [];
          list.push(fundNameById.get(fundId) ?? fundId);
          fundNamesByAssetId.set(asset.id, list);
        }
      }

      // Flattened ranking across the four types, used only for the best-match hint.
      const [best] = [
        ...assetHits.map((h) => ({
          type: 'asset' as const,
          score: h.score,
          name: h.item.asset_name ?? h.item.legal_name ?? h.matchedOn,
        })),
        ...fundHits.map((h) => ({ type: 'fund' as const, score: h.score, name: h.item.name })),
        ...investorHits.map((h) => ({
          type: 'investor' as const,
          score: h.score,
          name: h.item.name,
        })),
        ...sourceHits.map((h) => ({ type: 'source' as const, score: h.score, name: h.item.name })),
      ].sort((a, b) => b.score - a.score);

      let out = `**Portfolio matches for "${needle}" (${total}):**\n\n`;

      if (assetHits.length > 0) {
        out += `### Holdings / fund assets (${assetHits.length})\n\n`;
        out += `| Match | Asset | Legal name | Fund(s) | Status | Sector | Invested | FMV | MOIC | DPI | IRR | fund_asset_id |\n`;
        out += `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
        for (const { item: a, score } of assetHits) {
          const fundLabel = (fundNamesByAssetId.get(a.id) ?? []).join(', ') || '(unassigned)';
          out += `| ${matchLabel(score)} | ${a.asset_name ?? '-'} | ${a.legal_name ?? '-'} | ${fundLabel} | ${
            a.status ?? '-'
          } | ${a.sector ?? '-'} | ${fmtAmount(a.invested_capital_amount)} | ${fmtAmount(
            a.fmv_amount,
          )} | ${fmtMult(a.gross_moic)} | ${fmtMult(a.dpi)} | ${fmtPct(a.gross_irr)} | ${a.id} |\n`;
        }
        out += '\n';
      }

      if (fundHits.length > 0) {
        out += `### Funds (${fundHits.length})\n\n`;
        out += `| Match | Fund | Vintage | Status | Commitment | Called | FMV | Realized | DPI | TVPI | IRR |\n`;
        out += `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
        for (const { item: f, score } of fundHits) {
          out += `| ${matchLabel(score)} | ${f.name} | ${f.vintage_year ?? '-'} | ${
            f.status ?? '-'
          } | ${fmtAmount(f.commitment_size_amount)} | ${fmtAmount(f.called_amount)} | ${fmtAmount(
            f.fmv_amount,
          )} | ${fmtAmount(f.realized_amount)} | ${fmtMult(f.dpi)} | ${fmtMult(f.tvpi)} | ${fmtPct(
            f.irr,
          )} |\n`;
        }
        out += '\n';
      }

      if (investorHits.length > 0) {
        out += `### Investors / LPs (${investorHits.length})\n\n`;
        out += `| Match | Investor | Type | Invested | Realized | FMV | DPI | MOIC | IRR |\n`;
        out += `| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
        for (const { item: i, score } of investorHits) {
          out += `| ${matchLabel(score)} | ${i.name} | ${i.entity_type ?? '-'} | ${fmtAmount(
            i.invested_amount,
          )} | ${fmtAmount(i.realized_amount)} | ${fmtAmount(i.fmv_amount)} | ${fmtMult(
            i.dpi,
          )} | ${fmtMult(i.moic)} | ${fmtPct(i.irr)} |\n`;
        }
        out += '\n';
      }

      if (sourceHits.length > 0) {
        out += `### Sources of capital (${sourceHits.length})\n\n`;
        out += `| Match | Source | Invested | Realized | FMV | DPI | MOIC | IRR |\n`;
        out += `| --- | --- | --- | --- | --- | --- | --- | --- |\n`;
        for (const { item: s, score } of sourceHits) {
          out += `| ${matchLabel(score)} | ${s.name} | ${fmtAmount(s.invested_amount)} | ${fmtAmount(
            s.realized_amount,
          )} | ${fmtAmount(s.fmv_amount)} | ${fmtMult(s.dpi)} | ${fmtMult(s.moic)} | ${fmtPct(
            s.irr,
          )} |\n`;
        }
        out += '\n';
      }

      out +=
        total === 1
          ? `Single match — treat it as the intended entity. Next: ${NEXT_STEP[best.type]}.\n`
          : `Best match: **${best.name}** (${best.type}, ${matchLabel(best.score)}). ` +
            `If one row is clearly what the user meant, proceed with it — ${NEXT_STEP[best.type]}. ` +
            `If two rows are genuinely ambiguous, ask the user which one they mean.\n`;
      out += '\nAmounts are in each entity\'s report/base currency.';

      logger.debug(`✓ search_investments returned ${total} match(es)`);
      return out;
    } catch (error) {
      logger.error(`search_investments error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'search_investments',
    description: `Fuzzy-search the ENTIRE investment portfolio by name in one call and find out what a name refers to: a holding (fund asset), a fund, an investor / LP, or a source of capital.

**Use this FIRST whenever the user names something and you don't already know which kind of entity it is** — e.g. "how is Acme doing?", "what's the story with Growth II?", "show me Tanaka's position". Only skip it when the user explicitly says which kind of entity they mean AND the name is unambiguous.

Matching is fuzzy and forgiving: it ignores case and punctuation, strips legal suffixes ("Acme Holdings Pte Ltd" matches "acme"), handles partial and out-of-order words, resolves acronyms ("GF II" → "Growth Fund II"), and tolerates typos ("acne" → "Acme").

Each hit comes back with its entity type, a match strength (exact / strong / partial / weak), headline metrics, and — for holdings — the \`fund_asset_id\` to pass to get_fund_asset_details.

Args:
    query: The name or partial name to resolve (required).
    types: Optional subset of entity types to search — any of "asset", "fund", "investor", "source". Omit to search all four.
    limit: Optional max hits per entity type (default 8, max 25).

Returns:
    Markdown sections (one per entity type that matched) plus a best-match hint, or a not-found message listing the browse tools to try next.`,
    schema: z.object({
      query: z
        .string()
        .describe(
          'Name or partial name to resolve — a holding, fund, investor/LP, or capital source',
        ),
      types: z
        .array(z.enum(['asset', 'fund', 'investor', 'source']))
        .optional()
        .describe(
          'Optional entity types to restrict the search to. Omit to search holdings, funds, investors, and capital sources together.',
        ),
      limit: z
        .number()
        .int()
        .optional()
        .describe('Optional max hits per entity type (default 8, max 25)'),
    }),
  },
);
