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
import { normalizeParsedAsset } from '../normalizeParsedAsset';
import {
  buildManagedFundNameKeys,
  managedFundCrossBookWarnings,
  summarizeManagedFundCrossBook,
} from '../managedFundCrossBook';
import type {
  FundCatalogItem,
  FundUpdateStructuredResult,
  LegacyAssetProposal,
  NanjingParserOptions,
  ReconciliationResult,
  ReviewItemCategory,
  ReviewProposalItem,
  TransferPairingMetadata,
  TransferPairingStatus,
} from '../types';

export type {
  FundCatalogItem,
  NanjingParserOptions,
  ReconciliationResult,
  ReviewItemCategory,
  ReviewProposalItem,
  TransferPairingMetadata,
  TransferPairingStatus,
};

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

function asSourceString(v: CellVal): string | null {
  if (v == null || v instanceof Date) return null;
  const source = String(v);
  return source.trim() === '' ? null : source;
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

import {
  isSameBusinessIdentity,
  normalizeCanonicalName,
  normalizeInvestorName,
  splitBilingual,
} from '@/lib/fundLedger/normalizeIdentity';

export {
  isSameBusinessIdentity,
  normalizeCanonicalName,
  normalizeInvestorName,
  splitBilingual,
};

export interface CounterpartyValidationResult {
  valid: boolean;
  reason?: string;
  isMultiParty?: boolean;
  isIncomplete?: boolean;
}

/**
 * Extracts the first counterparty token from column 11 by splitting on multi-party delimiters.
 */
export function extractFirstCounterpartyToken(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const clean = raw.trim();
  const placeholders = new Set([
    '未知', '待定', 'tbd', 'n/a', 'na', '-', '--', '---', '?', '？',
    '待确认', '暂无', '无', 'none', 'null', 'undefined', '待核实', '待查',
  ]);
  if (placeholders.has(clean.toLowerCase())) {
    return clean;
  }
  const tokens = clean.split(/[;；,，、+＋&]+/);
  for (const token of tokens) {
    const trimmed = token.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return clean;
}

/**
 * Validates a transfer counterparty string read from column 11 of the ledger.
 * Identifies incomplete, placeholder, tentative, or multi-party strings that must
 * remain review-required and non-postable without creating composite entities.
 */
export function validateTransferCounterparty(raw: string | null | undefined): CounterpartyValidationResult {
  if (!raw || !raw.trim()) {
    return { valid: false, isIncomplete: true, reason: 'Missing transferor counterparty in column 11' };
  }

  const { zh } = splitBilingual(raw);
  const clean = zh.trim() || raw.trim();
  if (!clean) {
    return { valid: false, isIncomplete: true, reason: 'Missing or empty transferor counterparty in column 11' };
  }

  const cleanLower = clean.toLowerCase();

  // Check placeholder words
  const placeholders = new Set([
    '未知', '待定', 'tbd', 'n/a', 'na', '-', '--', '---', '?', '？',
    '待确认', '暂无', '无', 'none', 'null', 'undefined', '待核实', '待查',
  ]);
  if (placeholders.has(cleanLower)) {
    return {
      valid: false,
      isIncomplete: true,
      reason: `Incomplete or placeholder counterparty string "${clean}" in column 11; manual review required`,
    };
  }

  // Check incomplete / tentative annotations
  if (
    clean.includes('待确认') ||
    clean.includes('待定') ||
    clean.includes('待核实') ||
    clean.includes('待查') ||
    clean.includes('暂定')
  ) {
    return {
      valid: false,
      isIncomplete: true,
      reason: `Counterparty string "${clean}" contains tentative/unverified annotation; manual review required`,
    };
  }

  // Check multi-party indicators
  // 1. Explicit multi-party punctuation: 、 , ， ; ； + ＋ & / \
  if (/[、,，;；+＋&/\\]/.test(clean)) {
    return {
      valid: false,
      isMultiParty: true,
      reason: `Multi-party counterparty string "${clean}" in column 11 contains delimiters; cannot create composite entity`,
    };
  }

  // 2. Chinese conjunctions between entities: 及, 与, 和, 以及, or ending with 等
  if (
    clean.includes('以及') ||
    /[一-鿿][及与和][一-鿿]/.test(clean) ||
    clean.endsWith('等')
  ) {
    return {
      valid: false,
      isMultiParty: true,
      reason: `Multi-party counterparty string "${clean}" in column 11 contains conjunctions; cannot create composite entity`,
    };
  }

  // 3. English conjunctions
  if (/\b(and|or)\b/i.test(clean)) {
    return {
      valid: false,
      isMultiParty: true,
      reason: `Multi-party counterparty string "${clean}" in column 11 contains conjunctions; cannot create composite entity`,
    };
  }

  return { valid: true };
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
  nameEn?: string | null;
  filingCode: string | null;
  subscribedAmount: number | null;
  paidInAmount: number | null;
  investedAmount: number | null;
  netCashFlowAmount?: number | null;
}

/**
 * Reads the `基金汇总` sheet from R4 until col 1 is empty or equals `合计`.
 * Amounts in source sheet are in 万元 -> converted to CNY (x10,000).
 *
 * Bilingual fund names are split into native Chinese (nameZh) and English (nameEn).
 */
export function parseFundCatalog(wb: ExcelJS.Workbook): NanjingFundCatalogItem[] {
  const ws = wb.getWorksheet('基金汇总');
  if (!ws) return [];
  const funds: NanjingFundCatalogItem[] = [];

  for (let r = 4; r <= ws.rowCount; r++) {
    const rawCol1 = asSourceString(cellValue(ws.getCell(r, 1)));
    if (!rawCol1) break;
    const cleanCol1 = rawCol1.replace(/\s+/g, '');
    if (cleanCol1 === '合计' || cleanCol1.startsWith('合计')) break;

    const { zh: nameZh, en: nameEn } = splitBilingual(rawCol1);

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
      nameEn,
      filingCode,
      subscribedAmount,
      paidInAmount,
      investedAmount,
    });
  }

  return funds;
}

// 基金汇总 col L: 基金净现金流 = 实缴流入 + 退出回款 − 投资支出 − 向投资人分配.
const NET_CASH_FLOW_SIGN_BY_ACTION: Record<string, 1 | -1> = {
  实缴: 1,
  退出: 1,
  投资: -1,
  分配: -1,
};

/**
 * Evaluates the `基金汇总` net cash-flow column per book fund (col 12 of
 * `基金流水明细`). The summary's SUMIFS columns are saved without cached values,
 * so they are re-derived from the rows they sum. Keyed by normalized fund name;
 * 万元 -> CNY.
 */
export function parseCatalogNetCashFlows(wb: ExcelJS.Workbook): Map<string, number> {
  const out = new Map<string, number>();
  const ws = wb.getWorksheet('基金流水明细');
  if (!ws) return out;

  for (let r = 3; r <= ws.rowCount; r++) {
    const orderVal = asString(cellValue(ws.getCell(r, 1)));
    if (!orderVal) break;

    const actionRaw = asString(cellValue(ws.getCell(r, 5)))?.trim() ?? '';
    const sign = NET_CASH_FLOW_SIGN_BY_ACTION[actionRaw];
    if (!sign) continue;
    const amountVal = asNumber(cellValue(ws.getCell(r, 9)));
    if (amountVal == null) continue;
    const { zh: fundZh } = splitBilingual(asSourceString(cellValue(ws.getCell(r, 12))) ?? '');
    const key = normalizeInvestorName(fundZh);
    if (!key) continue;

    out.set(key, (out.get(key) ?? 0) + sign * amountVal * 10_000);
  }

  // Summing float 万元 amounts drifts below a fen; state the totals to the fen.
  for (const [key, value] of out) out.set(key, Math.round(value * 100) / 100);
  return out;
}

// ---- Portfolio Ledger Parsing ----

interface AssetGroup {
  fundZh: string;
  fundEn: string | null;
  targetZh: string;
  targetEn: string | null;
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
    const targetRaw = asSourceString(cellValue(ws.getCell(r, 6))) ?? '';
    const targetTypeRaw = asString(cellValue(ws.getCell(r, 7)))?.trim() ?? '';
    const natureRaw = asString(cellValue(ws.getCell(r, 8)))?.trim() ?? '';
    const amountVal = asNumber(cellValue(ws.getCell(r, 9)));
    const directionRaw = asString(cellValue(ws.getCell(r, 10)))?.trim() ?? '';
    const counterpartyRaw = asString(cellValue(ws.getCell(r, 11)))?.trim() ?? null;
    const fundRaw = asSourceString(cellValue(ws.getCell(r, 12))) ?? '';
    const dataStatusRaw = asString(cellValue(ws.getCell(r, 13)))?.trim() ?? '';
    const remarksRaw = asString(cellValue(ws.getCell(r, 14)))?.trim() ?? null;

    if (!IN_SCOPE_ACTIONS.has(actionRaw)) {
      lpRowCount++;
      continue;
    }

    if (!rawDate) continue;
    const dateIso = isoDate(rawDate)!;

    const { zh: targetZh, en: targetEn } = splitBilingual(targetRaw);
    const { zh: fundZh, en: fundEn } = splitBilingual(fundRaw);

    const type: TxnTypeEnum = actionRaw === '投资' ? 'contribution' : 'divestment';
    const subTypeLabel = NATURE_DICT[natureRaw] ?? (natureRaw || null);
    // Amount is stored in 万元 (10,000 RMB) -> multiply by 10,000 to convert to CNY
    const valueAmount = amountVal != null ? amountVal * 10_000 : null;

    const sellProceedsDestination: SellProceedsDestination | null =
      type === 'divestment'
        ? directionRaw === '留存资金' || directionRaw === '资金流入基金'
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
      sourceSheet: ws.name,
      sourceRow: r,
      dataStatus: dataStatusRaw && dataStatusRaw !== '正常' ? 'needs_verification' : 'verified',
    };

    const groupKey = `${fundZh}:::${targetZh}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        fundZh,
        fundEn,
        targetZh,
        targetEn,
        targetTypeRaw,
        txns: [],
        rawRows: [],
      };
      groups.set(groupKey, group);
    } else {
      if (!group.targetEn && targetEn) group.targetEn = targetEn;
      if (!group.fundEn && fundEn) group.fundEn = fundEn;
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
    const name = group.targetZh;
    const englishName = group.targetEn ?? null;

    assets.push({
      code,
      name,
      legalName: group.targetZh,
      englishName,
      country: 'China',
      investmentTypeLabel,
      assetType,
      fund: group.fundZh,
      fundEnglishName: group.fundEn ?? null,
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

  return { assets: assets.map(normalizeParsedAsset), lpRowCount };
}

export type CommitmentEventIntent =
  | 'increase'
  | 'decrease'
  | 'paid_in'
  | 'distribution'
  | 'transfer_in';

export interface ParsedCommitmentEvent {
  /** 所属基金 (col 12), zh half. Matches ParsedAsset.fund. */
  fund: string;
  fundEnglishName?: string | null;
  /** 主体 (col 3), zh half — the investor / LP. */
  investorName: string;
  investorEnglishName?: string | null;
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
  sourceSheet?: string;
  dataStatus?: 'verified' | 'needs_verification';
  /** Deterministic counterparty pairing metadata for transfer events. */
  transferPairing?: TransferPairingMetadata;
  /** Original submitted review ID when threading approval decisions through apply. */
  submittedId?: string;
}

export interface ParseLedgerCommitmentEventsResult {
  events: ParsedCommitmentEvent[];
  /** Structured review-required items (e.g. non-cash adjustments, write-offs). */
  reviewItems: ReviewProposalItem[];
  /** Rows on the sheet that are neither commitment events nor 投资/退出, keyed by 动作. */
  notAppliedByAction: Record<string, number>;
  warnings: string[];
}

/**
 * Reads the investor-side fund lifecycle from worksheet `基金流水明细`.
 *
 * Col 10 direction and nature are the discriminators:
 * - 认缴额度增加 + 受让额度/转让 -> intent: 'transfer_in' with deterministic pairing metadata
 * - 认缴额度增加 (other nature) -> intent: 'increase'
 * - 认缴额度减少 -> intent: 'decrease'
 * - 实缴 + 资金流入基金 -> intent: 'paid_in'
 * - 分配 + 资金流出基金 -> intent: 'distribution'
 * - 实缴调整 / 损益核销 / 非现金调整 -> surfaced as structured ReviewProposalItem
 */
export function parseLedgerCommitmentEvents(
  wb: ExcelJS.Workbook,
  options?: NanjingParserOptions,
): ParseLedgerCommitmentEventsResult {
  const ws = wb.getWorksheet('基金流水明细');
  if (!ws) return { events: [], reviewItems: [], notAppliedByAction: {}, warnings: [] };

  const events: ParsedCommitmentEvent[] = [];
  const reviewItems: ReviewProposalItem[] = [];
  const notAppliedByAction: Record<string, number> = {};
  const warnings: string[] = [];

  for (let r = 3; r <= ws.rowCount; r++) {
    const orderVal = asString(cellValue(ws.getCell(r, 1)));
    if (!orderVal) break;

    const actionRaw = asString(cellValue(ws.getCell(r, 5)))?.trim() ?? '';
    if (IN_SCOPE_ACTIONS.has(actionRaw)) {
      continue;
    }

    const rawDate = asDate(cellValue(ws.getCell(r, 2)));
    const entityRaw = asSourceString(cellValue(ws.getCell(r, 3))) ?? '';
    const entityTypeRaw = asString(cellValue(ws.getCell(r, 4)))?.trim() ?? null;
    const targetRaw = asSourceString(cellValue(ws.getCell(r, 6))) ?? '';
    const targetTypeRaw = asString(cellValue(ws.getCell(r, 7)))?.trim() ?? null;
    const natureRaw = asString(cellValue(ws.getCell(r, 8)))?.trim() ?? null;
    const amountVal = asNumber(cellValue(ws.getCell(r, 9)));
    const directionRaw = asString(cellValue(ws.getCell(r, 10)))?.trim() ?? '';
    const counterpartyRaw = asString(cellValue(ws.getCell(r, 11)))?.trim() ?? null;
    const fundRaw = asSourceString(cellValue(ws.getCell(r, 12))) ?? '';
    const dataStatusRaw = asString(cellValue(ws.getCell(r, 13)))?.trim() ?? '';
    const remarksRaw = asString(cellValue(ws.getCell(r, 14)))?.trim() ?? null;

    const { zh: fundZh, en: fundEn } = splitBilingual(fundRaw);
    const { zh: entityZh, en: entityEn } = splitBilingual(entityRaw);
    const { zh: targetZh, en: targetEn } = splitBilingual(targetRaw);

    // Check for non-cash adjustments / write-offs (实缴调整 / 损益核销 / 非现金调整)
    const isNonCashAdjustment =
      actionRaw === '实缴调整' ||
      natureRaw === '损益核销' ||
      directionRaw === '非现金调整';

    if (isNonCashAdjustment) {
      const isEntityFund =
        entityTypeRaw === '基金' ||
        (fundZh && normalizeInvestorName(entityZh) === normalizeInvestorName(fundZh)) ||
        entityZh === fundZh;
      const investorZh = isEntityFund ? (targetZh || entityZh) : (entityZh || targetZh);
      const investorEn = isEntityFund ? (targetEn || entityEn) : (entityEn || targetEn);
      const investorTypeRawResolved = isEntityFund ? (targetTypeRaw || entityTypeRaw) : entityTypeRaw;
      const dateIso = isoDate(rawDate);
      const amount = amountVal != null ? Math.abs(amountVal) * 10_000 : null;

      const actionDisplay = actionRaw || '实缴调整';
      const explanation = `Non-cash adjustment (${actionDisplay}${natureRaw ? ` / ${natureRaw}` : ''}) requires manual review; adjusts paid-in capital by the row amount without changing cash or commitment.`;

      reviewItems.push({
        sourceRow: r,
        fund: fundZh || fundRaw,
        fundEnglishName: fundEn ?? null,
        investorName: investorZh || null,
        investorEnglishName: investorEn ?? null,
        investorTypeRaw: investorTypeRawResolved,
        date: dateIso,
        amount,
        currency: 'CNY',
        action: actionDisplay,
        nature: natureRaw,
        direction: directionRaw || null,
        explanation,
        isPostable: false,
        requiresReview: true,
        category: 'non_cash_adjustment',
        counterpartyRaw,
        targetRaw,
        entityRaw,
      });

      if (actionRaw) {
        notAppliedByAction[actionRaw] = (notAppliedByAction[actionRaw] ?? 0) + 1;
      }
      continue;
    }

    const isTransferIn =
      (directionRaw === '认缴额度增加' || actionRaw === '认缴') &&
      (natureRaw === '受让额度' || natureRaw === '转让');
    const isCommitmentIncrease = directionRaw === '认缴额度增加' && !isTransferIn;
    const isCommitmentDecrease =
      directionRaw === '认缴额度减少' || (actionRaw === '减资' && directionRaw === '认缴额度减少');
    const isPaidIn = actionRaw === '实缴' && directionRaw === '资金流入基金';
    const isDistribution = actionRaw === '分配' && directionRaw === '资金流出基金';

    if (isTransferIn || isCommitmentIncrease || isCommitmentDecrease || isPaidIn || isDistribution) {
      if (!rawDate) {
        warnings.push(`Row ${r}: missing or invalid date`);
        continue;
      }
      if (amountVal == null || Math.abs(amountVal) === 0) {
        warnings.push(`Row ${r}: missing or zero amount`);
        continue;
      }
      const investorZh = isDistribution ? targetZh : entityZh;
      const investorEn = isDistribution ? targetEn : entityEn;
      if (!investorZh) {
        warnings.push(`Row ${r}: missing investor entity (主体)`);
        continue;
      }
      if (!fundZh) {
        warnings.push(`Row ${r}: missing fund (所属基金)`);
        continue;
      }

      const dateIso = isoDate(rawDate)!;
      const investorName = investorZh;
      const investorEnglishName = investorEn ?? null;
      const fund = fundZh;
      const fundEnglishName = fundEn ?? null;
      const counterpartyName = counterpartyRaw;
      const investorTypeLabel = entityTypeRaw ? (ENTITY_TYPE_DICT[entityTypeRaw] ?? null) : null;
      const intent: CommitmentEventIntent = isPaidIn
        ? 'paid_in'
        : isDistribution
          ? 'distribution'
          : isTransferIn
            ? 'transfer_in'
            : isCommitmentDecrease
              ? 'decrease'
              : 'increase';
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
        fundEnglishName,
        investorName,
        investorEnglishName,
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
        sourceSheet: ws.name,
        dataStatus: dataStatusRaw && dataStatusRaw !== '正常' ? 'needs_verification' : 'verified',
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

  // ---- Deterministic Transfer Pairing ----
  // Known investor names: workbook entities + optional master data
  const knownInvestorMap = new Map<string, string>(); // normalizedKey -> canonicalName
  const registerKnownInvestor = (rawName: string | null | undefined) => {
    if (!rawName) return;
    const canonical = rawName.trim();
    const norm = normalizeInvestorName(canonical);
    if (norm && !knownInvestorMap.has(norm)) {
      knownInvestorMap.set(norm, canonical);
    }
  };

  for (const ev of events) {
    registerKnownInvestor(ev.investorName);
  }
  for (const ri of reviewItems) {
    registerKnownInvestor(ri.investorName);
  }
  if (options?.knownMasterInvestors) {
    for (const masterName of options.knownMasterInvestors) {
      registerKnownInvestor(masterName);
    }
  }

  const decreaseEvents = events.filter((e) => e.intent === 'decrease');

  for (const ev of events) {
    if (ev.intent !== 'transfer_in') continue;

    const firstToken = extractFirstCounterpartyToken(ev.counterpartyName);
    if (!firstToken) {
      ev.transferPairing = {
        status: 'missing_counterparty',
        transferorName: null,
        counterpartyRaw: ev.counterpartyName,
        matchedReductionSourceRow: null,
        eligibleForTransferOut: false,
        requiresReview: true,
        reviewReason: 'Missing transferor counterparty in column 11',
      };
      continue;
    }

    const valResult = validateTransferCounterparty(firstToken);
    if (!valResult.valid) {
      const status: TransferPairingStatus = valResult.isMultiParty
        ? 'ambiguous'
        : 'unknown_counterparty';
      ev.transferPairing = {
        status,
        transferorName: null,
        counterpartyRaw: ev.counterpartyName,
        matchedReductionSourceRow: null,
        eligibleForTransferOut: false,
        requiresReview: true,
        reviewReason: valResult.reason ?? 'Invalid transfer counterparty in column 11',
      };
      continue;
    }

    const { zh: counterpartyZh } = splitBilingual(firstToken);
    const canonicalCp = counterpartyZh.trim() || firstToken.trim();
    const normCp = normalizeInvestorName(canonicalCp);
    const canonicalFromMap = knownInvestorMap.get(normCp);
    const canonicalTransferor = canonicalFromMap ?? canonicalCp;

    // Check for candidate reciprocal decrease rows in the workbook
    const candidateReductions = decreaseEvents.filter((dec) => {
      const fundMatch = dec.fund === ev.fund;
      const dateMatch = dec.date === ev.date;
      const amountMatch = Math.abs(dec.amount - ev.amount) < 0.01;
      const investorMatch = normalizeInvestorName(dec.investorName) === normCp;
      let counterpartyMatch = true;
      if (dec.counterpartyName) {
        counterpartyMatch =
          normalizeInvestorName(dec.counterpartyName) === normalizeInvestorName(ev.investorName);
      }
      return fundMatch && dateMatch && amountMatch && investorMatch && counterpartyMatch;
    });

    if (candidateReductions.length === 1) {
      const matchedRow = candidateReductions[0];
      const competingTransfers = events.filter((other) => {
        if (other.intent !== 'transfer_in' || !other.counterpartyName) return false;
        const otherNormCp = normalizeInvestorName(other.counterpartyName);
        return (
          other.fund === matchedRow.fund &&
          other.date === matchedRow.date &&
          Math.abs(other.amount - matchedRow.amount) < 0.01 &&
          otherNormCp === normalizeInvestorName(matchedRow.investorName)
        );
      });

      if (competingTransfers.length > 1) {
        ev.transferPairing = {
          status: 'ambiguous',
          transferorName: canonicalTransferor,
          counterpartyRaw: ev.counterpartyName,
          matchedReductionSourceRow: null,
          eligibleForTransferOut: false,
          requiresReview: true,
          reviewReason: `Multiple transfer_in events (${competingTransfers.map((t) => `Row ${t.sourceRow}`).join(', ')}) compete for reciprocal reduction Row ${matchedRow.sourceRow}.`,
        };
      } else {
        ev.transferPairing = {
          status: 'reciprocal_reduction_found',
          transferorName: canonicalTransferor,
          counterpartyRaw: ev.counterpartyName,
          matchedReductionSourceRow: matchedRow.sourceRow,
          eligibleForTransferOut: false,
          requiresReview: false,
          reviewReason: `Matching reciprocal reduction row found in workbook (Row ${matchedRow.sourceRow}).`,
        };
      }
    } else if (candidateReductions.length > 1) {
      ev.transferPairing = {
        status: 'ambiguous',
        transferorName: canonicalTransferor,
        counterpartyRaw: ev.counterpartyName,
        matchedReductionSourceRow: null,
        eligibleForTransferOut: false,
        requiresReview: true,
        reviewReason: `Multiple matching reciprocal reduction rows found (${candidateReductions.map((r) => `Row ${r.sourceRow}`).join(', ')}).`,
      };
    } else {
      // Eligible transferor leg with no reciprocal row in workbook
      if (canonicalFromMap) {
        ev.transferPairing = {
          status: 'paired',
          transferorName: canonicalTransferor,
          counterpartyRaw: ev.counterpartyName,
          matchedReductionSourceRow: null,
          eligibleForTransferOut: true,
          requiresReview: false,
        };
      } else {
        // Unknown counterparty to be surfaced in Investor catalog tab for review/matching/creation
        ev.transferPairing = {
          status: 'unknown_counterparty',
          transferorName: canonicalTransferor,
          counterpartyRaw: ev.counterpartyName,
          matchedReductionSourceRow: null,
          eligibleForTransferOut: true,
          requiresReview: false,
        };
      }
    }
  }

  return { events, reviewItems, notAppliedByAction, warnings };
}

// ---- Advisory Per-Fund Reconciliation ----

/**
 * Produces advisory per-fund reconciliation results comparing calculated ledger totals
 * against the `基金汇总` summary sheet. Differences are advisory and do not block approval.
 */
export function reconcileNanjingFundLedger(
  catalogItems: NanjingFundCatalogItem[],
  assets: ParsedAsset[],
  commitmentEvents: ParsedCommitmentEvent[],
  reviewItems: ReviewProposalItem[] = [],
): ReconciliationResult[] {
  const results: ReconciliationResult[] = [];

  const fundMap = new Map<
    string,
    { displayName: string; catalogItem: NanjingFundCatalogItem | null }
  >();
  const addFund = (name: string, catalogItem: NanjingFundCatalogItem | null = null) => {
    const key = normalizeInvestorName(name);
    if (!key) return;
    const existing = fundMap.get(key);
    if (!existing) {
      fundMap.set(key, { displayName: name, catalogItem });
      return;
    }
    if (name.length > existing.displayName.length) existing.displayName = name;
    if (catalogItem) existing.catalogItem = catalogItem;
  };
  for (const item of catalogItems) {
    if (item.nameZh) addFund(item.nameZh, item);
  }
  for (const a of assets) {
    if (a.fund) addFund(a.fund);
  }
  for (const e of commitmentEvents) {
    if (e.fund) addFund(e.fund);
  }
  for (const r of reviewItems) {
    if (r.fund) addFund(r.fund);
  }

  for (const [fundKey, { displayName: fundName, catalogItem }] of fundMap.entries()) {
    // 1. Net commitment vs Subscribed
    const fundCommitments = commitmentEvents.filter(
      (e) => normalizeInvestorName(e.fund) === fundKey,
    );
    const totalIncreases = fundCommitments
      .filter((e) => e.intent === 'increase' || e.intent === 'transfer_in')
      .reduce((sum, e) => sum + e.amount, 0);
    // A 受让额度 row adds to fund size: the workbook never records the
    // transferor's commitment or a reduction for it, and the import posts no
    // transferor debit, so only explicit 减资 rows reduce commitment.
    const totalDecreases = fundCommitments
      .filter((e) => e.intent === 'decrease')
      .reduce((sum, e) => sum + e.amount, 0);
    const calculatedNetCommitment = totalIncreases - totalDecreases;

    const sourceSubscribed = catalogItem?.subscribedAmount ?? null;
    const hasSourceSubscribed = sourceSubscribed != null;
    const subSourceVal = sourceSubscribed ?? 0;
    const subDiff = calculatedNetCommitment - subSourceVal;
    const subDiffPct =
      hasSourceSubscribed && subSourceVal !== 0
        ? Math.abs(subDiff / subSourceVal) * 100
        : subDiff === 0
          ? 0
          : 100;
    const subReconciled = hasSourceSubscribed && Math.abs(subDiff) < 0.01;

    results.push({
      metricName: 'Net Commitment vs Subscribed',
      fund: fundName,
      targetEventType: 'commitment',
      sourceValue: subSourceVal,
      calculatedValue: calculatedNetCommitment,
      diff: subDiff,
      diffPct: Math.round(subDiffPct * 100) / 100,
      currency: 'CNY',
      unit: 'CNY',
      isReconciled: subReconciled,
      sheet: '基金汇总 / 基金流水明细',
      notes: hasSourceSubscribed
        ? `Calculated net commitment = ${calculatedNetCommitment.toLocaleString()} CNY (Increases/Transfers: ${totalIncreases.toLocaleString()} - Decreases: ${totalDecreases.toLocaleString()}), Summary subscribed = ${subSourceVal.toLocaleString()} CNY, Diff = ${subDiff.toLocaleString()} CNY.`
        : `Calculated net commitment = ${calculatedNetCommitment.toLocaleString()} CNY. No summary subscribed amount found in 基金汇总.`,
    });

    // 2. Paid-in vs Summary
    const fundPaidInEvents = fundCommitments.filter((e) => e.intent === 'paid_in');
    const calculatedPaidIn = fundPaidInEvents.reduce((sum, e) => sum + e.amount, 0);
    const sourcePaidIn = catalogItem?.paidInAmount ?? null;
    const hasSourcePaidIn = sourcePaidIn != null;
    const paidInSourceVal = sourcePaidIn ?? 0;
    const paidInDiff = calculatedPaidIn - paidInSourceVal;
    const paidInDiffPct =
      hasSourcePaidIn && paidInSourceVal !== 0
        ? Math.abs(paidInDiff / paidInSourceVal) * 100
        : paidInDiff === 0
          ? 0
          : 100;
    const paidInReconciled = hasSourcePaidIn && Math.abs(paidInDiff) < 0.01;

    const fundReviewItems = reviewItems.filter(
      (r) => normalizeInvestorName(r.fund) === fundKey,
    );
    const reviewTotal = fundReviewItems.reduce((sum, r) => sum + (r.amount ?? 0), 0);

    let paidInNotes: string;
    if (hasSourcePaidIn) {
      if (fundReviewItems.length > 0) {
        paidInNotes = `Calculated paid-in cash = ${calculatedPaidIn.toLocaleString()} CNY. Note: ${fundReviewItems.length} non-cash adjustment item(s) (实缴调整/损益核销) totaling ${reviewTotal.toLocaleString()} CNY surfaced for review and excluded from cash total. Summary paid-in = ${paidInSourceVal.toLocaleString()} CNY, Diff = ${paidInDiff.toLocaleString()} CNY.`;
      } else {
        paidInNotes = `Calculated paid-in cash = ${calculatedPaidIn.toLocaleString()} CNY, Summary paid-in = ${paidInSourceVal.toLocaleString()} CNY, Diff = ${paidInDiff.toLocaleString()} CNY.`;
      }
    } else {
      paidInNotes = `Calculated paid-in cash = ${calculatedPaidIn.toLocaleString()} CNY. No summary paid-in amount found in 基金汇总.`;
    }

    results.push({
      metricName: 'Paid-in Capital vs Summary',
      fund: fundName,
      targetEventType: 'paid_in',
      sourceValue: paidInSourceVal,
      calculatedValue: calculatedPaidIn,
      diff: paidInDiff,
      diffPct: Math.round(paidInDiffPct * 100) / 100,
      currency: 'CNY',
      unit: 'CNY',
      isReconciled: paidInReconciled,
      sheet: '基金汇总 / 基金流水明细',
      notes: paidInNotes,
    });

    // 3. Invested vs Summary
    const fundAssets = assets.filter((a) => normalizeInvestorName(a.fund) === fundKey);
    const calculatedInvested = fundAssets.reduce((sum, a) => {
      const assetInvested = a.txns
        .filter((t) => t.type === 'contribution')
        .reduce((s, t) => s + (t.valueAmount ?? 0), 0);
      return sum + assetInvested;
    }, 0);
    const sourceInvested = catalogItem?.investedAmount ?? null;
    const hasSourceInvested = sourceInvested != null;
    const investedSourceVal = sourceInvested ?? 0;
    const investedDiff = calculatedInvested - investedSourceVal;
    const investedDiffPct =
      hasSourceInvested && investedSourceVal !== 0
        ? Math.abs(investedDiff / investedSourceVal) * 100
        : investedDiff === 0
          ? 0
          : 100;
    const investedReconciled = hasSourceInvested && Math.abs(investedDiff) < 0.01;

    results.push({
      metricName: 'Invested Amount vs Summary',
      fund: fundName,
      targetEventType: 'investment',
      sourceValue: investedSourceVal,
      calculatedValue: calculatedInvested,
      diff: investedDiff,
      diffPct: Math.round(investedDiffPct * 100) / 100,
      currency: 'CNY',
      unit: 'CNY',
      isReconciled: investedReconciled,
      sheet: '基金汇总 / 基金流水明细',
      notes: hasSourceInvested
        ? `Calculated invested amount = ${calculatedInvested.toLocaleString()} CNY, Summary invested = ${investedSourceVal.toLocaleString()} CNY, Diff = ${investedDiff.toLocaleString()} CNY.`
        : `Calculated invested amount = ${calculatedInvested.toLocaleString()} CNY. No summary invested amount found in 基金汇总.`,
    });
  }

  // 4. Managed fund -> managed fund flows: the payer's 投资/退出 total against the
  // receiver's 实缴/分配 total. Only the receiver's rows post, so a gap here is
  // money that one book records and the other does not.
  const managedKeys = buildManagedFundNameKeys([
    ...catalogItems.map((c) => c.nameZh),
    ...assets.filter((a) => a.holderKind !== 'investor').map((a) => a.fund),
    ...commitmentEvents.map((e) => e.fund),
    ...reviewItems.map((r) => r.fund),
  ]);
  for (const pair of summarizeManagedFundCrossBook(assets, commitmentEvents, managedKeys)) {
    const warnings = managedFundCrossBookWarnings(pair);
    const diff = pair.receiverTotal - pair.payerTotal;
    results.push({
      metricName:
        pair.kind === 'paid_in'
          ? 'Managed Fund Investment (投资 vs 实缴)'
          : 'Managed Fund Exit (退出 vs 分配)',
      fund: pair.targetFund,
      targetEventType: pair.kind,
      sourceValue: pair.payerTotal,
      calculatedValue: pair.receiverTotal,
      diff,
      diffPct:
        pair.payerTotal !== 0
          ? Math.round(Math.abs(diff / pair.payerTotal) * 10_000) / 100
          : diff === 0
            ? 0
            : 100,
      currency: 'CNY',
      unit: 'CNY',
      isReconciled: warnings.length === 0,
      sheet: '基金流水明细',
      notes:
        warnings.length > 0
          ? warnings.join(' ')
          : `${pair.holderFund} → ${pair.targetFund}: ${pair.kind === 'paid_in' ? '投资' : '退出'} and ${pair.kind === 'paid_in' ? '实缴' : '分配'} totals agree; posted once from ${pair.targetFund}'s book.`,
    });
  }

  return results;
}

// ---- Workbook Ingestion Projection ----

export async function parseNanjingWorkbookForIngestion(
  wb: ExcelJS.Workbook,
  options?: NanjingParserOptions,
): Promise<FundUpdateStructuredResult | null> {
  const catalogItems = parseFundCatalog(wb);
  const { assets } = parseLedgerAssets(wb);

  const {
    events: commitmentEvents,
    reviewItems,
    notAppliedByAction,
  } = parseLedgerCommitmentEvents(wb, options);

  if (assets.length === 0 && commitmentEvents.length === 0 && reviewItems.length === 0) {
    return null;
  }

  const reconciliation = reconcileNanjingFundLedger(
    catalogItems,
    assets,
    commitmentEvents,
    reviewItems,
  );

  // The catalog gates which funds the apply step will accept, so it must cover
  // every fund the ledger actually references — a fund can appear in
  // 基金流水明细 before it is added to 基金汇总. Summary order first, then any
  // ledger-only funds, so the catalog stays deterministic.
  const fundCatalog: string[] = [];
  const fundIndexes = new Map<string, number>();
  const fundEnMap = new Map<string, string | null>();

  const addFund = (nameZh: string, nameEn: string | null = null) => {
    const key = normalizeInvestorName(nameZh);
    if (!key) return;
    const existingIndex = fundIndexes.get(key);
    if (existingIndex == null) {
      fundIndexes.set(key, fundCatalog.length);
      fundCatalog.push(nameZh);
    }
    if (nameEn && !fundEnMap.has(key)) {
      fundEnMap.set(key, nameEn);
    }
  };
  for (const c of catalogItems) addFund(c.nameZh, c.nameEn ?? null);
  for (const a of assets) if (a.fund) addFund(a.fund, a.fundEnglishName ?? null);
  for (const e of commitmentEvents) if (e.fund) addFund(e.fund, e.fundEnglishName ?? null);
  for (const r of reviewItems) if (r.fund) addFund(r.fund, r.fundEnglishName ?? null);

  // Full fund catalog items including any ledger-only funds
  const fundCatalogItems: FundCatalogItem[] = [];
  const catalogItemMap = new Map(catalogItems.map((c) => [normalizeInvestorName(c.nameZh), c]));
  const netCashFlows = parseCatalogNetCashFlows(wb);
  for (const f of fundCatalog) {
    const key = normalizeInvestorName(f);
    const existing = catalogItemMap.get(key);
    if (existing) {
      fundCatalogItems.push({
        ...existing,
        nameZh: f,
        nameEn: existing.nameEn ?? fundEnMap.get(key) ?? null,
        netCashFlowAmount: netCashFlows.get(key) ?? 0,
      });
    } else {
      fundCatalogItems.push({
        nameZh: f,
        nameEn: fundEnMap.get(key) ?? null,
        filingCode: null,
        subscribedAmount: null,
        paidInAmount: null,
        investedAmount: null,
      });
    }
  }

  const assetCount = assets.length;
  const directCount = assets.filter((a) => a.assetType === 'direct_investment').length;
  const fundOfFundsCount = assetCount - directCount;
  const txnCount = assets.reduce((n, a) => n + a.txns.length, 0);
  const commitmentEventCount = commitmentEvents.length;
  const reviewItemCount = reviewItems.length;
  const transferCount = commitmentEvents.filter((e) => e.intent === 'transfer_in').length;
  const notAppliedTotal = Object.values(notAppliedByAction).reduce((sum, n) => sum + n, 0);

  const stats = {
    asset_count: assetCount,
    direct_count: directCount,
    fund_of_funds_count: fundOfFundsCount,
    transaction_count: txnCount,
    valuation_count: 0,
    commitment_event_count: commitmentEventCount,
    review_item_count: reviewItemCount,
  };

  const assetNames = assets.map((a) => a.name);
  const uniqueFundsTouched = [
    ...new Set([
      ...assets.map((a) => a.fund),
      ...commitmentEvents.map((e) => e.fund),
      ...reviewItems.map((r) => r.fund),
    ]),
  ].sort();
  const fundCount = uniqueFundsTouched.length;

  // Latest transaction date across all assets
  let fileDate: string | null = null;
  for (const a of assets) {
    for (const t of a.txns) {
      if (!fileDate || t.date > fileDate) fileDate = t.date;
    }
  }

  const reconciledMetricsCount = reconciliation.filter((r) => r.isReconciled).length;
  const totalReconciliationCount = reconciliation.length;

  const keyPoints: string[] = [
    `Format: ${NANJING_TEMPLATE_ID}`,
    `Currency: CNY (source amounts in 万元, ×10,000 applied)`,
    `Funds touched: ${uniqueFundsTouched.join(', ') || '(none)'}`,
    `${assetCount} proposed asset updates`,
    `${txnCount} proposed ledger rows`,
    `${commitmentEventCount} proposed investor lifecycle events (CNY)`,
  ];

  if (transferCount > 0) {
    keyPoints.push(
      `${transferCount} transfer event(s) parsed with deterministic counterparty pairing`,
    );
  }
  if (reviewItemCount > 0) {
    keyPoints.push(
      `${reviewItemCount} non-cash review item(s) (实缴调整/损益核销) surfaced for manual review (non-postable)`,
    );
  }
  if (totalReconciliationCount > 0) {
    keyPoints.push(
      `Reconciliation: ${reconciledMetricsCount}/${totalReconciliationCount} fund metrics reconciled against 基金汇总 summary`,
    );
  }
  if (notAppliedTotal > 0) {
    keyPoints.push(
      `Rows not applied: ${Object.entries(notAppliedByAction).map(([a, n]) => `${a} ${n}`).join(', ')}`,
    );
  }

  const actionItems: string[] = [
    'Review proposed asset changes in the Fund Updates review flow.',
    'Review proposed investor commitment and cash-flow events before approving.',
  ];
  if (reviewItemCount > 0) {
    actionItems.push(
      `Review ${reviewItemCount} non-cash adjustment/write-off item(s) (实缴调整/损益核销).`,
    );
  }
  const unreconciledCount = totalReconciliationCount - reconciledMetricsCount;
  if (unreconciledCount > 0) {
    actionItems.push(
      `Resolve ${unreconciledCount} reconciliation difference(s) against 基金汇总 summary before approval.`,
    );
  }

  return {
    file_type: 'fund_updates',
    parser: NANJING_TEMPLATE_ID,
    summary: `Nanjing 金光紫金 lifecycle ledger: ${assetCount} portfolio holdings across ${fundCount} funds, ${txnCount} transactions (CNY), ${commitmentEventCount} investor lifecycle events (${transferCount} transfers), ${reviewItemCount} non-cash review items. Proposed only — pending review.`,
    key_points: keyPoints,
    action_items: actionItems,
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
      fund_catalog_items: fundCatalogItems,
      commitment_events: commitmentEvents,
      review_items: reviewItems,
      reconciliation,
    },
  };
}

// ---- Deterministic Parser Module Export ----

export const nanjingFundLedgerParser = {
  templateId: NANJING_TEMPLATE_ID,
  async parse(
    buffer: Buffer,
    options?: NanjingParserOptions,
  ): Promise<FundUpdateStructuredResult | null> {
    if (!(await fingerprintNanjingFundLedger(buffer))) return null;
    const wb = await loadWorkbook(buffer);
    return parseNanjingWorkbookForIngestion(wb, options);
  },
};
