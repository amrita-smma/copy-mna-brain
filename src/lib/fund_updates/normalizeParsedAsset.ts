/**
 * Canonical ParsedAsset / valuation / txn shape shared by fingerprint parsers
 * (STARTECH, Nanjing) and LLM / workbook-fallback extractors so the review UI
 * and apply path always see the same fields.
 */
import type { ParsedAsset, ParsedTxn, ParsedValuation } from './parsers/startech_quarterly';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_MONTH = /^\d{4}-\d{2}$/;

export function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && ISO_DATE.test(value.trim());
}

/** Calendar-quarter label ("Q4 2025") from an ISO as-of date. */
export function quarterPeriodLabel(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
}

export function earliestIsoDate(...dates: Array<string | null | undefined>): string | null {
  const valid = dates.filter(isIsoDate).map((d) => d.trim()).sort();
  return valid[0] ?? null;
}

/**
 * Position open date for apply: earliest of stated entry, selected cash dates,
 * and selected valuation as-of dates. Same rule for every parser.
 */
export function earliestFundUpdatePositionDate(input: {
  entryDate?: string | null;
  txnDates?: Array<string | null | undefined>;
  valuationDates?: Array<string | null | undefined>;
}): string | null {
  return earliestIsoDate(
    input.entryDate,
    ...(input.txnDates ?? []),
    ...(input.valuationDates ?? []),
  );
}

function canonicalPeriodLabel(iso: string, existing?: string | null): string {
  const e = existing?.trim() ?? '';
  if (!e || YEAR_MONTH.test(e)) return quarterPeriodLabel(iso);
  return e;
}

function normalizeTxn(t: ParsedTxn): ParsedTxn | null {
  if (!isIsoDate(t.date)) return null;
  return {
    ...t,
    date: t.date.trim(),
    subTypeLabel: t.subTypeLabel ?? null,
    pricePerShare: t.pricePerShare ?? null,
    shareCount: t.shareCount ?? null,
    valueAmount: t.valueAmount ?? null,
    fxRate: t.fxRate ?? null,
    notes: t.notes ?? null,
    sellProceedsDestination: t.sellProceedsDestination ?? null,
  };
}

function normalizeValuation(v: ParsedValuation): ParsedValuation | null {
  if (!isIsoDate(v.asOfDate)) return null;
  const asOfDate = v.asOfDate.trim();
  return {
    ...v,
    asOfDate,
    periodLabel: canonicalPeriodLabel(asOfDate, v.periodLabel),
    marketValue: v.marketValue ?? null,
    pricePerShare: v.pricePerShare ?? null,
    sharesOutstanding: v.sharesOutstanding ?? null,
    shareholdingPct: v.shareholdingPct ?? null,
    investedCapitalCum: v.investedCapitalCum ?? null,
    grossMoic: v.grossMoic ?? null,
    grossXirr: v.grossXirr ?? null,
    valuationMethod: v.valuationMethod ?? null,
    notes: v.notes ?? null,
  };
}

export function normalizeParsedAsset(asset: ParsedAsset): ParsedAsset {
  const txns = asset.txns.map(normalizeTxn).filter((t): t is ParsedTxn => t != null);
  txns.sort((a, b) => a.date.localeCompare(b.date));

  const valuations = asset.valuations
    .map(normalizeValuation)
    .filter((v): v is ParsedValuation => v != null);
  valuations.sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));

  let currentPricePerShare = asset.currentPricePerShare ?? null;
  if (currentPricePerShare == null) {
    for (let i = valuations.length - 1; i >= 0; i--) {
      if (valuations[i].pricePerShare != null) {
        currentPricePerShare = valuations[i].pricePerShare;
        break;
      }
    }
  }

  return {
    ...asset,
    holderKind: asset.holderKind ?? 'fund',
    group: asset.group ?? asset.fund,
    holderName: asset.holderName ?? asset.entity ?? null,
    entityIsComposite: asset.entityIsComposite ?? false,
    entityIsUnattributed: asset.entityIsUnattributed ?? false,
    legalName: asset.legalName ?? null,
    englishName: asset.englishName ?? null,
    fundEnglishName: asset.fundEnglishName ?? null,
    country: asset.country ?? null,
    entity: asset.entity ?? null,
    fundingSource: asset.fundingSource ?? null,
    fundingSourceRaw: asset.fundingSourceRaw ?? asset.fundingSource ?? null,
    entryDate: isIsoDate(asset.entryDate) ? asset.entryDate.trim() : null,
    stakePct: asset.stakePct ?? null,
    commitmentAmount: asset.commitmentAmount ?? null,
    dealType: asset.dealType ?? null,
    mgmtFeeRatePct: asset.mgmtFeeRatePct ?? null,
    sector: asset.sector ?? null,
    subSector: asset.subSector ?? null,
    instrument: asset.instrument ?? null,
    sharesOutstanding: asset.sharesOutstanding ?? null,
    sourceRef: asset.sourceRef ?? null,
    vintageYear: asset.vintageYear ?? null,
    currentPricePerShare,
    txns,
    valuations,
  };
}

export function normalizeParsedAssets(assets: ParsedAsset[]): ParsedAsset[] {
  return assets.map(normalizeParsedAsset);
}

/** The valuation ledger requires a market value; auxiliary-only tracker rows cannot be persisted. */
export function isPersistableFundUpdateValuation(v: ParsedValuation): boolean {
  return v.marketValue != null;
}
