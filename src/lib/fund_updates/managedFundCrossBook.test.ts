import { describe, expect, it } from 'vitest';
import {
  buildManagedFundNameKeys,
  crossBookFlowKindForTxn,
  formatWan,
  isManagedFundCrossBookAsset,
  isManagedFundName,
  managedFundCrossBookNote,
  managedFundCrossBookWarnings,
  summarizeManagedFundCrossBook,
} from './managedFundCrossBook';
import type { ParsedAsset, ParsedCommitmentEvent, ParsedTxn } from './index';

const JINGUANG_FUND = '南京金光紫金股权投资基金（有限合伙企业）';
const TONGDE = '南京桐德股权投资合伙企业（有限合伙）';
const RUIFENG = '南京瑞沣股权投资合伙企业（有限合伙）';
const YUESHENG = '南京月升星繁创业投资合伙企业（有限合伙）';
const HUAIAN = '淮安熙和创业投资基金合伙企业（有限合伙）';

const managedKeys = buildManagedFundNameKeys([JINGUANG_FUND, TONGDE, RUIFENG, YUESHENG, HUAIAN]);

function txn(overrides: Partial<ParsedTxn> = {}): ParsedTxn {
  return {
    date: '2023-02-20',
    type: 'contribution',
    subTypeLabel: 'Initial Investment',
    pricePerShare: null,
    shareCount: null,
    valueAmount: 4_000_000,
    currency: 'CNY',
    fxRate: null,
    notes: null,
    sourceSheet: '基金流水明细',
    sourceRow: 73,
    ...overrides,
  };
}

function asset(overrides: Partial<ParsedAsset> = {}): ParsedAsset {
  return {
    code: 'NJ-x',
    name: RUIFENG,
    legalName: RUIFENG,
    country: 'China',
    investmentTypeLabel: 'Fund of Funds',
    assetType: 'fund_of_funds',
    fund: TONGDE,
    entity: null,
    fundingSource: null,
    fundingSourceRaw: null,
    entryDate: '2023-02-20',
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
    txns: [txn()],
    ...overrides,
  };
}

function paidIn(overrides: Partial<ParsedCommitmentEvent> = {}): ParsedCommitmentEvent {
  return {
    fund: RUIFENG,
    investorName: TONGDE,
    investorTypeRaw: '机构投资人',
    investorTypeLabel: 'Institutional Investor',
    date: '2023-03-13',
    intent: 'paid_in',
    amount: 3_000_000,
    currency: 'CNY',
    counterpartyName: null,
    actionRaw: '实缴',
    natureRaw: '实缴出资',
    directionRaw: '资金流入基金',
    notes: null,
    sourceRow: 99,
    ...overrides,
  };
}

describe('isManagedFundName', () => {
  it('matches a managed fund by exact canonical name', () => {
    expect(isManagedFundName(YUESHENG, managedKeys)).toBe(true);
  });

  it('matches a managed fund written with an English suffix on the same line', () => {
    expect(
      isManagedFundName(
        '南京瑞沣股权投资合伙企业（有限合伙）Nanjing Ruifeng Equity Investment Partnership (Limited Partnership)',
        managedKeys,
      ),
    ).toBe(true);
    expect(isManagedFundName("淮安熙和创业投资基金合伙企业（有限合伙） Huai'an Xihe Venture Capital Fund", managedKeys)).toBe(true);
  });

  it('matches regardless of full-width vs ASCII parentheses', () => {
    expect(isManagedFundName('南京桐德股权投资合伙企业(有限合伙)', managedKeys)).toBe(true);
  });

  it('does not treat a management company sharing the fund name prefix as the fund', () => {
    expect(isManagedFundName('南京金光紫金创业投资管理有限公司', managedKeys)).toBe(false);
    expect(
      isManagedFundName(
        '南京金光紫金创业投资管理有限公司Nanjing Sinar Mas & ZiJin Venture Capital Management Co., Ltd.',
        managedKeys,
      ),
    ).toBe(false);
    expect(isManagedFundName('青岛金光紫金创业投资管理有限', managedKeys)).toBe(false);
  });

  it('does not match a prefix or substring of a managed fund name', () => {
    expect(isManagedFundName('南京金光紫金股权投资基金', managedKeys)).toBe(false);
    expect(isManagedFundName('南京月升星繁', managedKeys)).toBe(false);
  });

  it('is false for empty names and an empty catalog', () => {
    expect(isManagedFundName('', managedKeys)).toBe(false);
    expect(isManagedFundName(null, managedKeys)).toBe(false);
    expect(isManagedFundName(YUESHENG, new Set())).toBe(false);
  });
});

describe('isManagedFundCrossBookAsset', () => {
  it('is true when a managed fund holds another managed fund', () => {
    expect(isManagedFundCrossBookAsset(asset(), managedKeys)).toBe(true);
  });

  it('is false for a managed fund investing in an outside fund or company', () => {
    expect(isManagedFundCrossBookAsset(asset({ name: '南京紫东国际创意园天使投资基金（有限合伙企业）' }), managedKeys)).toBe(false);
    expect(isManagedFundCrossBookAsset(asset({ name: '江苏美克医学技术有限公司', assetType: 'direct_investment' }), managedKeys)).toBe(false);
  });

  it('is false for an investor-held proposal even when the target is a managed fund (Startech shape)', () => {
    expect(isManagedFundCrossBookAsset(asset({ holderKind: 'investor', fund: TONGDE }), managedKeys)).toBe(false);
  });

  it('is false when the holder and target are the same fund', () => {
    expect(isManagedFundCrossBookAsset(asset({ name: TONGDE }), managedKeys)).toBe(false);
  });
});

describe('managedFundCrossBookNote', () => {
  it('names the receiving fund and the rows the money is recorded from', () => {
    expect(managedFundCrossBookNote(HUAIAN)).toBe(
      `Recorded from ${HUAIAN}'s paid-in rows; this row posts no ledger entry.`,
    );
    expect(managedFundCrossBookNote(HUAIAN, crossBookFlowKindForTxn(txn({ type: 'divestment' })))).toContain(
      'distribution rows',
    );
  });
});

describe('formatWan', () => {
  it('renders CNY amounts in 万', () => {
    expect(formatWan(29_000_000)).toBe('2,900万');
    expect(formatWan(1_000_000)).toBe('100万');
  });
});

describe('summarizeManagedFundCrossBook', () => {
  it('matches split receiver rows against one payer row by total (400万 vs 300万 + 100万)', () => {
    const pairs = summarizeManagedFundCrossBook(
      [asset()],
      [paidIn(), paidIn({ date: '2024-01-05', amount: 1_000_000, sourceRow: 111 })],
      managedKeys,
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      kind: 'paid_in',
      payerTotal: 4_000_000,
      receiverTotal: 4_000_000,
      payerRows: [73],
      receiverRows: [99, 111],
      payerFirstDate: '2023-02-20',
      receiverFirstDate: '2023-03-13',
    });
    expect(managedFundCrossBookWarnings(pairs[0])).toEqual([]);
  });

  it('warns when the receiving fund has no paid-in rows for the pair', () => {
    const [pair] = summarizeManagedFundCrossBook([asset()], [], managedKeys);
    const warnings = managedFundCrossBookWarnings(pair);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${TONGDE} → ${RUIFENG}`);
    expect(warnings[0]).toContain('400万');
    expect(warnings[0]).toContain('no 实缴 rows');
  });

  it('warns when only the receiving side exists', () => {
    const [pair] = summarizeManagedFundCrossBook([], [paidIn({ amount: 4_000_000 })], managedKeys);
    expect(managedFundCrossBookWarnings(pair)[0]).toContain('no matching 投资 rows');
  });

  it('warns when the two totals differ', () => {
    const [pair] = summarizeManagedFundCrossBook([asset()], [paidIn()], managedKeys);
    expect(managedFundCrossBookWarnings(pair)[0]).toContain('does not match');
  });

  it('warns when the first rows of the two books are far apart in time', () => {
    const [pair] = summarizeManagedFundCrossBook(
      [asset({ name: YUESHENG, txns: [txn({ date: '2026-04-14', sourceRow: 74 })] })],
      [paidIn({ fund: YUESHENG, amount: 4_000_000, date: '2024-08-07', sourceRow: 183 })],
      managedKeys,
    );
    const warnings = managedFundCrossBookWarnings(pair);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('2026-04-14');
    expect(warnings[0]).toContain('2024-08-07');
  });

  it('ignores outside investors, outside targets, and management companies', () => {
    const pairs = summarizeManagedFundCrossBook(
      [asset({ name: '江苏美克医学技术有限公司', assetType: 'direct_investment' })],
      [paidIn({ investorName: '南京金光紫金创业投资管理有限公司' }), paidIn({ investorName: '吉龙权' })],
      managedKeys,
    );
    expect(pairs).toEqual([]);
  });

  it('pairs 退出 rows with the receiving fund\'s 分配 rows', () => {
    const [pair] = summarizeManagedFundCrossBook(
      [asset({ txns: [txn({ type: 'divestment', valueAmount: 500_000 })] })],
      [paidIn({ intent: 'distribution', amount: 500_000 })],
      managedKeys,
    );
    expect(pair.kind).toBe('distribution');
    expect(managedFundCrossBookWarnings(pair)).toEqual([]);
  });
});
