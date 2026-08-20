/**
 * Nanjing 金光紫金 lifecycle-ledger workbook parser.
 *
 * Pure Excel → structured asset extraction for Nanjing private fund lifecycle ledgers.
 * Propose-only: produces a fund_update_proposal payload for review before DB ingestion.
 *
 * Currency: source amounts in 万元 (10,000 RMB) are multiplied by 10,000 to CNY.
 */
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import type {
  ParsedAsset,
  ParsedTxn,
  SellProceedsDestination,
  TxnTypeEnum,
} from './startech_quarterly';
import type { FundUpdateStructuredResult } from '../types';

export const NANJING_TEMPLATE_ID = 'nanjing_fund_ledger_v1' as const;

// ---- Hardcoded CN -> EN Dictionary (Source of truth: Appendix of translation workbook) ----

export const ENTITY_TYPE_DICT: Record<string, string> = {
  '机构投资人': 'Institutional Investor',
  '基金': 'Fund',
  '个人投资人': 'Individual Investor',
};

export const ACTION_DICT: Record<string, string> = {
  '认缴': 'Subscription',
  '实缴': 'Paid-in Capital',
  '投资': 'Investment',
  '退出': 'Exit',
  '减资': 'Capital Reduction',
  '分配': 'Distribution',
  '实缴调整': 'Paid-in Capital Adjustment',
};

export const TARGET_TYPE_DICT: Record<string, string> = {
  '基金': 'Fund',
  '基金/合伙企业': 'Fund / Partnership',
  '企业': 'Corporate Entity',
  '机构投资人': 'Institutional Investor',
};

export const NATURE_DICT: Record<string, string> = {
  '新增额度': 'Additional Commitment',
  '实缴出资': 'Paid-in Contribution',
  '首次投资': 'Initial Investment',
  '追加投资': 'Additional Investment',
  '转让': 'Transfer',
  '退出分配': 'Exit Distribution',
  '认缴额度减少': 'Reduction in Subscription Commitment',
  '减资返还': 'Capital Reduction Refund',
  '损益核销': 'Profit and Loss Write-off',
  '受让额度': 'Transferred Commitment',
  '减资分配': 'Capital Reduction Distribution',
};

export const DIRECTION_DICT: Record<string, string> = {
  '认缴额度增加': 'Increase in Subscription Commitment',
  '资金流入基金': 'Cash Inflow to Fund',
  '资金流出基金': 'Cash Outflow from Fund',
  '认缴额度减少': 'Decrease in Subscription Commitment',
  '非现金调整': 'Non-Cash Adjustment',
};

export const DATA_STATUS_DICT: Record<string, string> = {
  '正常': 'Normal',
};

const IN_SCOPE_ACTIONS = new Set(['投资', '退出']);

// ---- Cell helpers ----

type CellVal = string | number | boolean | Date | null;

/** Unwraps ExcelJS's formula / error / rich-text cell shapes into a scalar. */
function cellValue(cell: ExcelJS.Cell): CellVal {
  const v = cell.value as unknown;
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('error' in o) return null; // #REF!, #VALUE!, ...
    if ('result' in o) {
      const r = o.result;
      if (r == null) return null;
      if (r instanceof Date) return r;
      if (typeof r === 'object') return null;
      return r as CellVal;
    }
    if ('richText' in o && Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? '').join('');
    }
    if ('text' in o) return String(o.text);
    return null;
  }
  return v as CellVal;
}

function asString(v: CellVal): string | null {
  if (v == null) return null;
  if (v instanceof Date) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

function asNumber(v: CellVal): number | null {
  if (v == null || v instanceof Date) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function asDate(v: CellVal): Date | null {
  return v instanceof Date && !Number.isNaN(v.getTime()) ? v : null;
}

/** Local-safe ISO date (YYYY-MM-DD) — the workbook stores dates at UTC midnight. */
function isoDate(d: Date | null): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

// ---- Bilingual splitting & code generation ----

/**
 * Splits bilingual Chinese/English cell content.
 * Splits at the first ASCII letter following a CJK character or closing parenthesis.
 * Returns { zh: s, en: null } when no CJK characters are present.
 */
export function splitBilingual(raw: string): { zh: string; en: string | null } {
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return { zh: '', en: null };
  if (!/[一-鿿]/.test(s)) return { zh: s, en: null };
  const m = s.match(/^(.*?[一-鿿）)])\s*([A-Za-z].*)$/);
  if (!m) return { zh: s, en: null };
  return { zh: m[1].trim(), en: m[2].trim() };
}

export const NANJING_ASSET_CODE_PREFIX = 'NJ-';

export function isNanjingAssetCode(code: string | null | undefined): boolean {
  return typeof code === 'string' && code.trim().toUpperCase().startsWith(NANJING_ASSET_CODE_PREFIX);
}

/**
 * Generates a stable short code for a Nanjing asset group.
 * Grouping key is (所属基金 zh, 对象 zh).
 */
export function generateNanjingAssetCode(fundZh: string, targetZh: string): string {
  const key = `${fundZh} ${targetZh}`.replace(/\s+/g, '');
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 10);
  return `${NANJING_ASSET_CODE_PREFIX}${hash}`;
}

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
}

// ---- Fingerprint ----

/**
 * Deterministic fingerprint check for Nanjing Fund lifecycle ledger workbooks.
 *
 * Returns false (never throws) unless:
 * 1. Worksheet `基金流水明细` exists.
 * 2. Worksheet `基金汇总` exists.
 * 3. On `基金流水明细`, R2 col 1 starts with `序号`, col 2 starts with `发生日期`,
 *    col 5 starts with `动作`, col 9 starts with `金额`, col 12 starts with `所属基金`.
 * 4. At least one data row (R3+) has non-empty col 1 and a valid Date in col 2.
 */
export async function fingerprintNanjingFundLedger(buffer: Buffer): Promise<boolean> {
  try {
    const wb = await loadWorkbook(buffer);
    const wsDetail = wb.getWorksheet('基金流水明细');
    const wsSummary = wb.getWorksheet('基金汇总');
    if (!wsDetail || !wsSummary) return false;

    const c1 = asString(cellValue(wsDetail.getCell(2, 1)))?.replace(/\s+/g, '') ?? '';
    const c2 = asString(cellValue(wsDetail.getCell(2, 2)))?.replace(/\s+/g, '') ?? '';
    const c5 = asString(cellValue(wsDetail.getCell(2, 5)))?.replace(/\s+/g, '') ?? '';
    const c9 = asString(cellValue(wsDetail.getCell(2, 9)))?.replace(/\s+/g, '') ?? '';
    const c12 = asString(cellValue(wsDetail.getCell(2, 12)))?.replace(/\s+/g, '') ?? '';

    if (
      !c1.startsWith('序号') ||
      !c2.startsWith('发生日期') ||
      !c5.startsWith('动作') ||
      !c9.startsWith('金额') ||
      !c12.startsWith('所属基金')
    ) {
      return false;
    }

    let hasValidDataRow = false;
    for (let r = 3; r <= wsDetail.rowCount; r++) {
      const orderVal = asString(cellValue(wsDetail.getCell(r, 1)));
      const dateVal = asDate(cellValue(wsDetail.getCell(r, 2)));
      if (orderVal && dateVal) {
        hasValidDataRow = true;
        break;
      }
    }

    return hasValidDataRow;
  } catch {
    return false;
  }
}

// ---- Fund Catalog ----

export interface NanjingFundCatalogItem {
  nameZh: string;
  filingCode: string | null;
  subscribedAmount: number | null;
  paidInAmount: number | null;
  investedAmount: number | null;
}

/**
 * Reads the `基金汇总` sheet from R4 until col 1 is empty or equals `合计`.
 * Amounts in source sheet are in 万元 -> converted to CNY (x10,000).
 *
 * Fund names are kept in Chinese — the Chinese name is the identity used
 * downstream, so no name is ever translated or hardcoded.
 */
export function parseFundCatalog(wb: ExcelJS.Workbook): NanjingFundCatalogItem[] {
  const ws = wb.getWorksheet('基金汇总');
  if (!ws) return [];
  const funds: NanjingFundCatalogItem[] = [];

  for (let r = 4; r <= ws.rowCount; r++) {
    const rawCol1 = asString(cellValue(ws.getCell(r, 1)));
    if (!rawCol1) break;
    const cleanCol1 = rawCol1.replace(/\s+/g, '');
    if (cleanCol1 === '合计' || cleanCol1.startsWith('合计')) break;

    const { zh: nameZh } = splitBilingual(rawCol1);

    const rawCol2 = asString(cellValue(ws.getCell(r, 2)));
    const filingCode = !rawCol2 || rawCol2.trim() === '未备案' ? null : rawCol2.trim();

    const subVal = asNumber(cellValue(ws.getCell(r, 3)));
    const paidVal = asNumber(cellValue(ws.getCell(r, 4)));
    const invVal = asNumber(cellValue(ws.getCell(r, 5)));

    const subscribedAmount = subVal != null ? subVal * 10_000 : null;
    const paidInAmount = paidVal != null ? paidVal * 10_000 : null;
    const investedAmount = invVal != null ? invVal * 10_000 : null;

    funds.push({
      nameZh,
      filingCode,
      subscribedAmount,
      paidInAmount,
      investedAmount,
    });
  }

  return funds;
}

// ---- Portfolio Ledger Parsing ----

interface AssetGroup {
  fundZh: string;
  targetZh: string;
  targetTypeRaw: string;
  txns: ParsedTxn[];
  rawRows: Array<{
    dateIso: string;
    actionRaw: string;
  }>;
}

export interface ParseLedgerAssetsResult {
  assets: ParsedAsset[];
  lpRowCount: number;
}

export function parseLedgerAssets(wb: ExcelJS.Workbook): ParseLedgerAssetsResult {
  const ws = wb.getWorksheet('基金流水明细');
  if (!ws) return { assets: [], lpRowCount: 0 };

  const groups = new Map<string, AssetGroup>();
  let lpRowCount = 0;

  for (let r = 3; r <= ws.rowCount; r++) {
    const orderVal = asString(cellValue(ws.getCell(r, 1)));
    if (!orderVal) break;

    const rawDate = asDate(cellValue(ws.getCell(r, 2)));
    const actionRaw = asString(cellValue(ws.getCell(r, 5)))?.trim() ?? '';
    const targetRaw = asString(cellValue(ws.getCell(r, 6)))?.trim() ?? '';
    const targetTypeRaw = asString(cellValue(ws.getCell(r, 7)))?.trim() ?? '';
    const natureRaw = asString(cellValue(ws.getCell(r, 8)))?.trim() ?? '';
    const amountVal = asNumber(cellValue(ws.getCell(r, 9)));
    const directionRaw = asString(cellValue(ws.getCell(r, 10)))?.trim() ?? '';
    const counterpartyRaw = asString(cellValue(ws.getCell(r, 11)))?.trim() ?? null;
    const fundRaw = asString(cellValue(ws.getCell(r, 12)))?.trim() ?? '';
    const dataStatusRaw = asString(cellValue(ws.getCell(r, 13)))?.trim() ?? '';
    const remarksRaw = asString(cellValue(ws.getCell(r, 14)))?.trim() ?? null;

    if (!IN_SCOPE_ACTIONS.has(actionRaw)) {
      lpRowCount++;
      continue;
    }

    if (!rawDate) continue;
    const dateIso = isoDate(rawDate)!;

    const { zh: targetZh } = splitBilingual(targetRaw);
    const { zh: fundZh } = splitBilingual(fundRaw);

    const type: TxnTypeEnum = actionRaw === '投资' ? 'contribution' : 'divestment';
    const subTypeLabel = NATURE_DICT[natureRaw] ?? (natureRaw || null);
    // Amount is stored in 万元 (10,000 RMB) -> multiply by 10,000 to convert to CNY
    const valueAmount = amountVal != null ? amountVal * 10_000 : null;

    const sellProceedsDestination: SellProceedsDestination | null =
      type === 'divestment'
        ? directionRaw === '资金流入基金'
          ? 'cash_in_fund'
          : 'distributed_to_investor'
        : null;

    const noteParts: string[] = [];
    if (counterpartyRaw) {
      noteParts.push(`Counterparty: ${counterpartyRaw}`);
    }
    if (remarksRaw) {
      noteParts.push(remarksRaw);
    }
    if (dataStatusRaw && dataStatusRaw !== '正常') {
      noteParts.push(dataStatusRaw === '待核实' ? '待核实' : dataStatusRaw);
    }
    const notes = noteParts.length > 0 ? noteParts.join('; ') : null;

    const txn: ParsedTxn = {
      date: dateIso,
      type,
      subTypeLabel,
      pricePerShare: null,
      shareCount: null,
      valueAmount,
      currency: 'CNY',
      fxRate: null,
      sellProceedsDestination,
      notes,
    };

    const groupKey = `${fundZh}:::${targetZh}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        fundZh,
        targetZh,
        targetTypeRaw,
        txns: [],
        rawRows: [],
      };
      groups.set(groupKey, group);
    }

    group.txns.push(txn);
    group.rawRows.push({
      dateIso,
      actionRaw,
    });
  }

  const assets: ParsedAsset[] = [];

  for (const group of groups.values()) {
    group.txns.sort((a, b) => a.date.localeCompare(b.date));

    // Entry date: earliest 投资 row date for group, or earliest txn date if no 投资 row
    const investRows = group.rawRows.filter((row) => row.actionRaw === '投资');
    let entryDate: string | null = null;
    if (investRows.length > 0) {
      entryDate = investRows.reduce(
        (min, r) => (min == null || r.dateIso < min ? r.dateIso : min),
        null as string | null,
      );
    } else {
      entryDate = group.rawRows.reduce(
        (min, r) => (min == null || r.dateIso < min ? r.dateIso : min),
        null as string | null,
      );
    }

    const isFof =
      group.targetTypeRaw.includes('基金') || group.targetTypeRaw.includes('合伙企业');
    const assetType: 'direct_investment' | 'fund_of_funds' = isFof
      ? 'fund_of_funds'
      : 'direct_investment';
    const investmentTypeLabel = isFof ? 'Fund of Funds' : 'Direct Investments';

    const code = generateNanjingAssetCode(group.fundZh, group.targetZh);
    // Chinese name is the identity downstream — never translated.
    const name = group.targetZh;

    assets.push({
      code,
      name,
      legalName: group.targetZh,
      country: 'China',
      investmentTypeLabel,
      assetType,
      fund: group.fundZh,
      entity: null,
      fundingSource: null,
      fundingSourceRaw: null,
      entryDate,
      stakePct: null,
      commitmentAmount: null,
      dealType: null,
      mgmtFeeRatePct: null,
      sector: null,
      subSector: null,
      instrument: null,
      sharesOutstanding: null,
      sourceRef: null,
      vintageYear: null,
      valuations: [],
      currentPricePerShare: null,
      currency: 'CNY',
      txns: group.txns,
    });
  }

  return { assets, lpRowCount };
}

export type CommitmentEventIntent = 'increase' | 'decrease';

export interface ParsedCommitmentEvent {
  /** 所属基金 (col 12), zh half. Matches ParsedAsset.fund. */
  fund: string;
  /** 主体 (col 3), zh half — the investor / LP. */
  investorName: string;
  /** 主体类型 (col 4) raw, e.g. 机构投资人. */
  investorTypeRaw: string | null;
  /** ENTITY_TYPE_DICT[investorTypeRaw] ?? null. */
  investorTypeLabel: string | null;
  /** ISO YYYY-MM-DD from col 2. */
  date: string;
  intent: CommitmentEventIntent;
  /** Positive CNY amount (abs(col 9) × 10_000). */
  amount: number;
  currency: 'CNY';
  /** 来源/交易对手方 (col 11), zh half, or null. Never used to create an entity. */
  counterpartyName: string | null;
  actionRaw: string;
  natureRaw: string | null;
  directionRaw: string;
  notes: string | null;
  /** 1-based worksheet row, for warnings and audit. */
  sourceRow: number;
}

export interface ParseLedgerCommitmentEventsResult {
  events: ParsedCommitmentEvent[];
  /** Rows on the sheet that are neither commitment events nor 投资/退出, keyed by 动作. */
  notAppliedByAction: Record<string, number>;
  warnings: string[];
}

/**
 * Reads investor commitment events from worksheet `基金流水明细`.
 *
 * Col 10 direction is the discriminator:
 * - 认缴额度增加 -> intent: 'increase'
 * - 认缴额度减少 -> intent: 'decrease'
 *
 * Subject (col 3) is the investor / LP. Target (col 6) is the fund.
 * Note: Transfers (受让额度) are modeled as commitment increases with the
 * counterparty preserved in notes; transferor side is not modeled.
 */
export function parseLedgerCommitmentEvents(wb: ExcelJS.Workbook): ParseLedgerCommitmentEventsResult {
  const ws = wb.getWorksheet('基金流水明细');
  if (!ws) return { events: [], notAppliedByAction: {}, warnings: [] };

  const events: ParsedCommitmentEvent[] = [];
  const notAppliedByAction: Record<string, number> = {};
  const warnings: string[] = [];

  for (let r = 3; r <= ws.rowCount; r++) {
    const orderVal = asString(cellValue(ws.getCell(r, 1)));
    if (!orderVal) break;

    const actionRaw = asString(cellValue(ws.getCell(r, 5)))?.trim() ?? '';
    if (IN_SCOPE_ACTIONS.has(actionRaw)) {
      continue;
    }

    const directionRaw = asString(cellValue(ws.getCell(r, 10)))?.trim() ?? '';

    if (directionRaw === '认缴额度增加' || directionRaw === '认缴额度减少') {
      const rawDate = asDate(cellValue(ws.getCell(r, 2)));
      const entityRaw = asString(cellValue(ws.getCell(r, 3)))?.trim() ?? '';
      const entityTypeRaw = asString(cellValue(ws.getCell(r, 4)))?.trim() ?? null;
      const natureRaw = asString(cellValue(ws.getCell(r, 8)))?.trim() ?? null;
      const amountVal = asNumber(cellValue(ws.getCell(r, 9)));
      const counterpartyRaw = asString(cellValue(ws.getCell(r, 11)))?.trim() ?? null;
      const fundRaw = asString(cellValue(ws.getCell(r, 12)))?.trim() ?? '';
      const dataStatusRaw = asString(cellValue(ws.getCell(r, 13)))?.trim() ?? '';
      const remarksRaw = asString(cellValue(ws.getCell(r, 14)))?.trim() ?? null;

      if (!rawDate) {
        warnings.push(`Row ${r}: missing or invalid date`);
        continue;
      }
      if (amountVal == null || Math.abs(amountVal) === 0) {
        warnings.push(`Row ${r}: missing or zero amount`);
        continue;
      }
      if (!entityRaw) {
        warnings.push(`Row ${r}: missing investor entity (主体)`);
        continue;
      }
      if (!fundRaw) {
        warnings.push(`Row ${r}: missing fund (所属基金)`);
        continue;
      }

      const dateIso = isoDate(rawDate)!;
      const { zh: investorName } = splitBilingual(entityRaw);
      const { zh: fund } = splitBilingual(fundRaw);
      const counterpartyName = counterpartyRaw ? splitBilingual(counterpartyRaw).zh || null : null;
      const investorTypeLabel = entityTypeRaw ? (ENTITY_TYPE_DICT[entityTypeRaw] ?? null) : null;
      const intent: CommitmentEventIntent = directionRaw === '认缴额度增加' ? 'increase' : 'decrease';
      const amount = Math.abs(amountVal) * 10_000;

      const noteParts: string[] = [];
      if (natureRaw) {
        const natureLabel = NATURE_DICT[natureRaw] ?? natureRaw;
        noteParts.push(natureLabel);
      }
      if (counterpartyRaw) {
        noteParts.push(`Counterparty: ${counterpartyRaw}`);
      }
      if (remarksRaw) {
        noteParts.push(remarksRaw);
      }
      if (dataStatusRaw && dataStatusRaw !== '正常') {
        noteParts.push(dataStatusRaw === '待核实' ? '待核实' : dataStatusRaw);
      }
      const notes = noteParts.length > 0 ? noteParts.join('; ') : null;

      events.push({
        fund,
        investorName,
        investorTypeRaw: entityTypeRaw,
        investorTypeLabel,
        date: dateIso,
        intent,
        amount,
        currency: 'CNY',
        counterpartyName,
        actionRaw,
        natureRaw,
        directionRaw,
        notes,
        sourceRow: r,
      });
    } else if (
      directionRaw === '资金流入基金' ||
      directionRaw === '资金流出基金' ||
      directionRaw === '非现金调整'
    ) {
      if (actionRaw) {
        notAppliedByAction[actionRaw] = (notAppliedByAction[actionRaw] ?? 0) + 1;
      }
    } else {
      warnings.push(`Row ${r}: unrecognised direction "${directionRaw}"`);
      if (actionRaw) {
        notAppliedByAction[actionRaw] = (notAppliedByAction[actionRaw] ?? 0) + 1;
      }
    }
  }

  return { events, notAppliedByAction, warnings };
}

// ---- Workbook Ingestion Projection ----

export async function parseNanjingWorkbookForIngestion(
  wb: ExcelJS.Workbook,
): Promise<FundUpdateStructuredResult | null> {
  const catalogItems = parseFundCatalog(wb);
  const { assets } = parseLedgerAssets(wb);

  if (assets.length === 0) return null;

  const { events: commitmentEvents, notAppliedByAction } = parseLedgerCommitmentEvents(wb);

  // The catalog gates which funds the apply step will accept, so it must cover
  // every fund the ledger actually references — a fund can appear in
  // 基金流水明细 before it is added to 基金汇总. Summary order first, then any
  // ledger-only funds, so the catalog stays deterministic.
  const fundCatalog: string[] = [];
  const seenFunds = new Set<string>();
  const addFund = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || seenFunds.has(trimmed)) return;
    seenFunds.add(trimmed);
    fundCatalog.push(trimmed);
  };
  for (const c of catalogItems) addFund(c.nameZh);
  for (const a of assets) if (a.fund) addFund(a.fund);
  for (const e of commitmentEvents) addFund(e.fund);

  const assetCount = assets.length;
  const directCount = assets.filter((a) => a.assetType === 'direct_investment').length;
  const fundOfFundsCount = assetCount - directCount;
  const txnCount = assets.reduce((n, a) => n + a.txns.length, 0);
  const commitmentEventCount = commitmentEvents.length;
  const notAppliedTotal = Object.values(notAppliedByAction).reduce((sum, n) => sum + n, 0);

  const stats = {
    asset_count: assetCount,
    direct_count: directCount,
    fund_of_funds_count: fundOfFundsCount,
    transaction_count: txnCount,
    valuation_count: 0,
    commitment_event_count: commitmentEventCount,
  };

  const assetNames = assets.map((a) => a.name);
  const uniqueFundsTouched = [...new Set(assets.map((a) => a.fund))].sort();
  const fundCount = uniqueFundsTouched.length;

  // Latest transaction date across all assets
  let fileDate: string | null = null;
  for (const a of assets) {
    for (const t of a.txns) {
      if (!fileDate || t.date > fileDate) fileDate = t.date;
    }
  }

  return {
    file_type: 'fund_updates',
    parser: NANJING_TEMPLATE_ID,
    summary: `Nanjing 金光紫金 lifecycle ledger: ${assetCount} portfolio holdings across ${fundCount} funds, ${txnCount} transactions (CNY), ${commitmentEventCount} investor commitment events. Investor cash-flow rows (${notAppliedTotal}) are not applied. Proposed only — pending review.`,
    key_points: [
      `Format: ${NANJING_TEMPLATE_ID}`,
      `Currency: CNY (source amounts in 万元, ×10,000 applied)`,
      `Funds touched: ${uniqueFundsTouched.join(', ') || '(none)'}`,
      `${assetCount} proposed asset updates`,
      `${txnCount} proposed ledger rows`,
      `${commitmentEventCount} proposed investor commitment events (CNY)`,
      `Rows not applied: ${Object.entries(notAppliedByAction).map(([a, n]) => `${a} ${n}`).join(', ')}`,
      'Commitment transfers are recorded as increases; the transferor side is not modeled',
    ],
    action_items: [
      'Review proposed asset changes in the Fund Updates review flow.',
      'Review proposed investor commitment events before approving.',
    ],
    tags: ['Fund Update', 'Nanjing', ...uniqueFundsTouched.slice(0, 8)],
    companies_detected: assetNames,
    company_notes: [],
    file_date: fileDate,
    suggested_track_ids: [],
    matched_companies: [],
    fund_update_proposal: {
      template_id: NANJING_TEMPLATE_ID,
      stats,
      assets,
      fund_catalog: fundCatalog,
      commitment_events: commitmentEvents,
    },
  };
}

// ---- Deterministic Parser Module Export ----

export const nanjingFundLedgerParser = {
  templateId: NANJING_TEMPLATE_ID,
  async parse(buffer: Buffer): Promise<FundUpdateStructuredResult | null> {
    if (!(await fingerprintNanjingFundLedger(buffer))) return null;
    const wb = await loadWorkbook(buffer);
    return parseNanjingWorkbookForIngestion(wb);
  },
};
