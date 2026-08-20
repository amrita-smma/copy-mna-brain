import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  fingerprintNanjingFundLedger,
  generateNanjingAssetCode,
  isNanjingAssetCode,
  NANJING_ASSET_CODE_PREFIX,
  NANJING_TEMPLATE_ID,
  nanjingFundLedgerParser,
  parseFundCatalog,
  parseLedgerAssets,
  parseLedgerCommitmentEvents,
  splitBilingual,
} from './nanjing_fund_ledger';
import type { LegacyAssetProposal } from '../types';

interface CreateTestWorkbookOptions {
  includeDetailSheet?: boolean;
  includeSummarySheet?: boolean;
  customHeaders?: string[];
  dataRows?: Array<{
    order?: string | number | null;
    date?: Date | null;
    entity?: string | null;
    entityType?: string | null;
    action?: string | null;
    target?: string | null;
    targetType?: string | null;
    nature?: string | null;
    amountWan?: number | null;
    direction?: string | null;
    counterparty?: string | null;
    fund?: string | null;
    dataStatus?: string | null;
    remarks?: string | null;
  }>;
  summaryRows?: Array<{
    name?: string | null;
    filingCode?: string | null;
    subscribedWan?: number | null;
    paidInWan?: number | null;
    investedWan?: number | null;
  }>;
}

const DEFAULT_HEADERS = [
  '序号\nOrder',
  '发生日期\nDate',
  '主体\nEntity',
  '主体类型\nEntity Type',
  '动作\nAction',
  '对象\nTarget',
  '对象类型\nTarget Type',
  '事项性质\nTransaction Nature',
  '金额（万元）\nAmount (RMB 10,000)',
  '金额方向\nCash Flow Direction',
  '来源/交易对手方\nSource / Counterparty',
  '所属基金\nRelated Fund',
  '数据状态\nData Status',
  '备注\nRemarks',
];

async function createTestWorkbookBuffer(options: CreateTestWorkbookOptions = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const {
    includeDetailSheet = true,
    includeSummarySheet = true,
    customHeaders,
    dataRows = [
      {
        order: 1,
        date: new Date('2023-05-20'),
        entity: '个人投资人',
        entityType: '个人投资人',
        action: '投资',
        target: '北京化药科创医药科技发展有限公司\nBeijing Huayao Kechuang',
        targetType: '企业',
        nature: '首次投资',
        amountWan: 640,
        direction: '资金流出基金',
        counterparty: '华夏银行',
        fund: '南京瑞沣股权投资合伙企业（有限合伙）',
        dataStatus: '正常',
        remarks: '首期出资',
      },
    ],
    summaryRows = [
      {
        name: '南京瑞沣股权投资合伙企业（有限合伙）',
        filingCode: 'SD2431',
        subscribedWan: 10000,
        paidInWan: 8000,
        investedWan: 6000,
      },
      {
        name: '南京金光紫金股权投资基金（有限合伙企业）',
        filingCode: '未备案',
        subscribedWan: 5000,
        paidInWan: 3000,
        investedWan: 2000,
      },
    ],
  } = options;

  if (includeDetailSheet) {
    const wsDetail = wb.addWorksheet('基金流水明细');
    wsDetail.getCell(1, 1).value = '金光紫金在管基金全生命周期流水明细';
    const headers = customHeaders ?? DEFAULT_HEADERS;
    for (let c = 0; c < headers.length; c++) {
      wsDetail.getCell(2, c + 1).value = headers[c];
    }
    for (let i = 0; i < dataRows.length; i++) {
      const r = i + 3;
      const row = dataRows[i];
      wsDetail.getCell(r, 1).value = row.order as unknown as ExcelJS.CellValue;
      wsDetail.getCell(r, 2).value = row.date as unknown as ExcelJS.CellValue;
      wsDetail.getCell(r, 3).value = row.entity as unknown as ExcelJS.CellValue;
      wsDetail.getCell(r, 4).value = row.entityType as unknown as ExcelJS.CellValue;
      wsDetail.getCell(r, 5).value = row.action as unknown as ExcelJS.CellValue;
      wsDetail.getCell(r, 6).value = row.target as unknown as ExcelJS.CellValue;
      wsDetail.getCell(r, 7).value = row.targetType as unknown as ExcelJS.CellValue;
      wsDetail.getCell(r, 8).value = row.nature as unknown as ExcelJS.CellValue;
      wsDetail.getCell(r, 9).value = row.amountWan as unknown as ExcelJS.CellValue;
      wsDetail.getCell(r, 10).value = row.direction as unknown as ExcelJS.CellValue;
      wsDetail.getCell(r, 11).value = row.counterparty as unknown as ExcelJS.CellValue;
      wsDetail.getCell(r, 12).value = row.fund as unknown as ExcelJS.CellValue;
      wsDetail.getCell(r, 13).value = row.dataStatus as unknown as ExcelJS.CellValue;
      wsDetail.getCell(r, 14).value = row.remarks as unknown as ExcelJS.CellValue;
    }
  }

  if (includeSummarySheet) {
    const wsSummary = wb.addWorksheet('基金汇总');
    wsSummary.getCell(3, 1).value = '基金名称';
    wsSummary.getCell(3, 2).value = '备案编码';
    wsSummary.getCell(3, 3).value = '原表认缴规模（万元）';
    wsSummary.getCell(3, 4).value = '原表实缴规模（万元）';
    wsSummary.getCell(3, 5).value = '原表已投金额（万元）';

    for (let i = 0; i < summaryRows.length; i++) {
      const r = i + 4;
      const row = summaryRows[i];
      wsSummary.getCell(r, 1).value = row.name as unknown as ExcelJS.CellValue;
      wsSummary.getCell(r, 2).value = row.filingCode as unknown as ExcelJS.CellValue;
      wsSummary.getCell(r, 3).value = row.subscribedWan as unknown as ExcelJS.CellValue;
      wsSummary.getCell(r, 4).value = row.paidInWan as unknown as ExcelJS.CellValue;
      wsSummary.getCell(r, 5).value = row.investedWan as unknown as ExcelJS.CellValue;
    }

    const totalRow = summaryRows.length + 4;
    wsSummary.getCell(totalRow, 1).value = '合计';
  }

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

describe('Nanjing Fund deterministic fingerprint parser', () => {
  // Requirement 1: fingerprint accepts a minimal valid Nanjing workbook
  it('1. fingerprint accepts a minimal valid Nanjing workbook', async () => {
    const buf = await createTestWorkbookBuffer();
    const matches = await fingerprintNanjingFundLedger(buf);
    expect(matches).toBe(true);
  });

  // Requirement 2: fingerprint rejects missing sheets or wrong headers
  describe('2. fingerprint rejection rules', () => {
    it('rejects a workbook missing 基金汇总', async () => {
      const buf = await createTestWorkbookBuffer({ includeSummarySheet: false });
      expect(await fingerprintNanjingFundLedger(buf)).toBe(false);
    });

    it('rejects a workbook missing 基金流水明细', async () => {
      const buf = await createTestWorkbookBuffer({ includeDetailSheet: false });
      expect(await fingerprintNanjingFundLedger(buf)).toBe(false);
    });

    it('rejects a workbook with wrong R2 headers', async () => {
      const badHeaders = [...DEFAULT_HEADERS];
      badHeaders[0] = 'WrongHeader';
      const buf = await createTestWorkbookBuffer({ customHeaders: badHeaders });
      expect(await fingerprintNanjingFundLedger(buf)).toBe(false);
    });

    it('rejects a workbook with no data rows (empty ledger)', async () => {
      const buf = await createTestWorkbookBuffer({ dataRows: [] });
      expect(await fingerprintNanjingFundLedger(buf)).toBe(false);
    });

    it('rejects corrupted or garbage buffer safely without throwing', async () => {
      expect(await fingerprintNanjingFundLedger(Buffer.from('not an excel file'))).toBe(false);
    });
  });

  // Requirement 3: splitBilingual
  describe('3. splitBilingual', () => {
    it('splits newline-separated bilingual strings', () => {
      const res = splitBilingual('刘海滨\nLIU HAIBIN');
      expect(res).toEqual({
        zh: '刘海滨',
        en: 'LIU HAIBIN',
      });
    });

    it('splits bilingual strings with no separator', () => {
      const res = splitBilingual(
        '南京金光方山投资基金企业（有限合伙）Nanjing Jinguang Fangshan Investment Fund Enterprise (Limited Partnership)',
      );
      expect(res).toEqual({
        zh: '南京金光方山投资基金企业（有限合伙）',
        en: 'Nanjing Jinguang Fangshan Investment Fund Enterprise (Limited Partnership)',
      });
    });

    it('handles Chinese-only strings', () => {
      const res = splitBilingual('北京化药科创医药科技发展有限公司');
      expect(res).toEqual({
        zh: '北京化药科创医药科技发展有限公司',
        en: null,
      });
    });

    it('handles ASCII-only strings without CJK', () => {
      const res = splitBilingual('Acme Corporation Limited (USA)');
      expect(res).toEqual({
        zh: 'Acme Corporation Limited (USA)',
        en: null,
      });
    });
  });

  // Requirement 4: 万元 -> CNY conversion (640 -> 6_400_000)
  it('4. converts 万元 to CNY correctly (640 -> 6_400_000)', async () => {
    const buf = await createTestWorkbookBuffer({
      dataRows: [
        {
          order: 1,
          date: new Date('2023-06-01'),
          action: '投资',
          target: '测试医药公司\nTest Pharma',
          targetType: '企业',
          nature: '首次投资',
          amountWan: 640,
          direction: '资金流出基金',
          fund: '南京瑞沣股权投资合伙企业（有限合伙）',
        },
      ],
    });

    const result = await nanjingFundLedgerParser.parse(buf);
    expect(result).not.toBeNull();
    const assets = result!.fund_update_proposal!.assets;
    expect(assets).toHaveLength(1);
    expect(assets[0].txns).toHaveLength(1);
    expect(assets[0].txns[0].valueAmount).toBe(6_400_000);
    expect(assets[0].txns[0].currency).toBe('CNY');
    expect(assets[0].currency).toBe('CNY');
  });

  // Requirement 5: Grouping: same target under two funds -> two assets with distinct codes
  it('5. groups by (fund, target): same target under two funds produces two distinct assets', async () => {
    const buf = await createTestWorkbookBuffer({
      dataRows: [
        {
          order: 1,
          date: new Date('2023-01-10'),
          action: '投资',
          target: '北京化药科创医药科技发展有限公司\nBeijing Huayao Kechuang',
          targetType: '企业',
          nature: '首次投资',
          amountWan: 500,
          fund: '南京瑞沣股权投资合伙企业（有限合伙）',
        },
        {
          order: 2,
          date: new Date('2023-02-15'),
          action: '投资',
          target: '北京化药科创医药科技发展有限公司\nBeijing Huayao Kechuang',
          targetType: '企业',
          nature: '首次投资',
          amountWan: 300,
          fund: '淮安熙和创业投资基金合伙企业（有限合伙）',
        },
      ],
    });

    const result = await nanjingFundLedgerParser.parse(buf);
    expect(result).not.toBeNull();
    const assets = result!.fund_update_proposal!.assets;
    expect(assets).toHaveLength(2);

    const [assetA, assetB] = assets;
    expect(assetA.legalName).toBe('北京化药科创医药科技发展有限公司');
    expect(assetB.legalName).toBe('北京化药科创医药科技发展有限公司');
    expect(assetA.fund).toBe('南京瑞沣股权投资合伙企业（有限合伙）');
    expect(assetB.fund).toBe('淮安熙和创业投资基金合伙企业（有限合伙）');
    expect(assetA.code).not.toBe(assetB.code);
    expect(assetA.code).toMatch(/^NJ-[0-9a-f]{10}$/);
    expect(assetB.code).toMatch(/^NJ-[0-9a-f]{10}$/);
  });

  // Requirement 6: Code stability — parsing the same buffer twice yields identical codes
  it('6. generates deterministic, byte-identical codes across multiple parse passes', async () => {
    const buf = await createTestWorkbookBuffer();
    const res1 = await nanjingFundLedgerParser.parse(buf);
    const res2 = await nanjingFundLedgerParser.parse(buf);

    expect(res1).not.toBeNull();
    expect(res2).not.toBeNull();
    const codes1 = res1!.fund_update_proposal!.assets.map((a) => a.code);
    const codes2 = res2!.fund_update_proposal!.assets.map((a) => a.code);
    expect(codes1).toEqual(codes2);

    const manualCode = generateNanjingAssetCode(
      '南京瑞沣股权投资合伙企业（有限合伙）',
      '北京化药科创医药科技发展有限公司',
    );
    expect(codes1[0]).toBe(manualCode);
  });

  it('6b. isNanjingAssetCode correctly identifies Nanjing asset codes', () => {
    expect(NANJING_ASSET_CODE_PREFIX).toBe('NJ-');
    expect(isNanjingAssetCode('NJ-1234567890')).toBe(true);
    expect(isNanjingAssetCode('nj-1234567890')).toBe(true);
    expect(isNanjingAssetCode('  NJ-abc1234567  ')).toBe(true);
    expect(isNanjingAssetCode('GOTO')).toBe(false);
    expect(isNanjingAssetCode('STARTECH_1')).toBe(false);
    expect(isNanjingAssetCode('')).toBe(false);
    expect(isNanjingAssetCode(null)).toBe(false);
    expect(isNanjingAssetCode(undefined)).toBe(false);
  });

  // Requirement 7: LP rows produce no assets and no txns
  describe('7. LP capital flows filtering', () => {
    it('skips LP flow actions (认缴/实缴/减资/分配/实缴调整) and tracks lpRowCount', async () => {
      const buf = await createTestWorkbookBuffer({
        dataRows: [
          { order: 1, action: '认缴', nature: '新增额度', amountWan: 1000 },
          { order: 2, action: '实缴', nature: '实缴出资', amountWan: 800 },
          { order: 3, action: '减资', nature: '减资返还', amountWan: 100 },
          { order: 4, action: '分配', nature: '减资分配', amountWan: 50 },
          { order: 5, action: '实缴调整', nature: '损益核销', amountWan: 10 },
          {
            order: 6,
            date: new Date('2023-07-01'),
            action: '投资',
            target: '赛德特生物制药有限公司\nSaidet Bio',
            targetType: '企业',
            nature: '首次投资',
            amountWan: 500,
            fund: '南京瑞满股权投资合伙企业（有限合伙）',
          },
        ],
      });

      const result = await nanjingFundLedgerParser.parse(buf);
      expect(result).not.toBeNull();
      const proposal = result!.fund_update_proposal!;
      expect(proposal.assets).toHaveLength(1);
      expect(proposal.assets[0].name).toBe('赛德特生物制药有限公司');
      expect(proposal.assets[0].txns).toHaveLength(1);
      expect(result!.summary).toContain('Investor cash-flow rows (5) are not applied');
    });

    it('returns null when a workbook contains only LP rows (0 portfolio assets)', async () => {
      const buf = await createTestWorkbookBuffer({
        dataRows: [
          { order: 1, action: '认缴', nature: '新增额度', amountWan: 1000 },
          { order: 2, action: '实缴', nature: '实缴出资', amountWan: 800 },
        ],
      });

      const result = await nanjingFundLedgerParser.parse(buf);
      expect(result).toBeNull();
    });
  });

  // Requirement 8: divestment sell-proceeds destination
  describe('8. sellProceedsDestination for divestments', () => {
    it('sets cash_in_fund for 资金流入基金, and null for contributions', async () => {
      const buf = await createTestWorkbookBuffer({
        dataRows: [
          {
            order: 1,
            date: new Date('2023-01-01'),
            action: '投资',
            target: '中联网仓科技有限公司\nZhonglian Wangcang',
            targetType: '企业',
            nature: '首次投资',
            amountWan: 3000,
            direction: '资金流出基金',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
          {
            order: 2,
            date: new Date('2023-08-15'),
            action: '退出',
            target: '中联网仓科技有限公司\nZhonglian Wangcang',
            targetType: '企业',
            nature: '转让',
            amountWan: 500,
            direction: '资金流入基金',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
        ],
      });

      const result = await nanjingFundLedgerParser.parse(buf);
      expect(result).not.toBeNull();
      const asset = result!.fund_update_proposal!.assets[0];
      expect(asset.txns).toHaveLength(2);

      const contribution = asset.txns[0];
      expect(contribution.type).toBe('contribution');
      expect(contribution.subTypeLabel).toBe('Initial Investment');
      expect(contribution.sellProceedsDestination).toBeNull();

      const divestment = asset.txns[1];
      expect(divestment.type).toBe('divestment');
      expect(divestment.subTypeLabel).toBe('Transfer');
      expect(divestment.sellProceedsDestination).toBe('cash_in_fund');
    });

    it('sets distributed_to_investor if divestment direction is not 资金流入基金', async () => {
      const buf = await createTestWorkbookBuffer({
        dataRows: [
          {
            order: 1,
            date: new Date('2023-08-15'),
            action: '退出',
            target: '中联网仓科技有限公司\nZhonglian Wangcang',
            targetType: '企业',
            nature: '退出分配',
            amountWan: 500,
            direction: '资金流出基金',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
        ],
      });

      const result = await nanjingFundLedgerParser.parse(buf);
      expect(result).not.toBeNull();
      const divestment = result!.fund_update_proposal!.assets[0].txns[0];
      expect(divestment.type).toBe('divestment');
      expect(divestment.subTypeLabel).toBe('Exit Distribution');
      expect(divestment.sellProceedsDestination).toBe('distributed_to_investor');
    });
  });

  // Requirement 9: unknown CN label falls through to raw string
  it('9. falls through to raw Chinese string for unknown labels without throwing', async () => {
    const buf = await createTestWorkbookBuffer({
      dataRows: [
        {
          order: 1,
          date: new Date('2023-05-20'),
          action: '投资',
          target: '未知创新药企业',
          targetType: '企业',
          nature: '未知特殊事项性质',
          amountWan: 120,
          direction: '资金流出基金',
          fund: '未登记新设立基金（有限合伙）',
        },
      ],
    });

    const result = await nanjingFundLedgerParser.parse(buf);
    expect(result).not.toBeNull();
    const asset = result!.fund_update_proposal!.assets[0];
    expect(asset.name).toBe('未知创新药企业');
    expect(asset.legalName).toBe('未知创新药企业');
    expect(asset.fund).toBe('未登记新设立基金（有限合伙）');
    expect(asset.txns[0].subTypeLabel).toBe('未知特殊事项性质');
  });

  // Additional detail tests: fund catalog, classification, notes, projection structure
  describe('Fund catalog and projection details', () => {
    it('parses fund catalog from 基金汇总 sheet, keeping Chinese fund names', async () => {
      const wb = new ExcelJS.Workbook();
      const wsSummary = wb.addWorksheet('基金汇总');
      wsSummary.getCell(3, 1).value = '基金名称';
      wsSummary.getCell(3, 2).value = '备案编码';
      wsSummary.getCell(3, 3).value = '原表认缴规模（万元）';
      wsSummary.getCell(3, 4).value = '原表实缴规模（万元）';
      wsSummary.getCell(3, 5).value = '原表已投金额（万元）';

      wsSummary.getCell(4, 1).value = '南京桐德股权投资合伙企业（有限合伙）';
      wsSummary.getCell(4, 2).value = 'SD2431';
      wsSummary.getCell(4, 3).value = 15000;
      wsSummary.getCell(4, 4).value = 12000;
      wsSummary.getCell(4, 5).value = 9000;

      // Bilingual cell: the English half is stripped, not carried through.
      wsSummary.getCell(5, 1).value = '南京弘盛股权投资合伙企业（有限合伙）\nNanjing Hongsheng Equity Investment Partnership (LP)';
      wsSummary.getCell(5, 2).value = '未备案';
      wsSummary.getCell(5, 3).value = 8000;
      wsSummary.getCell(5, 4).value = 5000;
      wsSummary.getCell(5, 5).value = 3000;

      wsSummary.getCell(6, 1).value = '合计';

      const catalog = parseFundCatalog(wb);
      expect(catalog).toHaveLength(2);
      expect(catalog[0]).toEqual({
        nameZh: '南京桐德股权投资合伙企业（有限合伙）',
        filingCode: 'SD2431',
        subscribedAmount: 150_000_000,
        paidInAmount: 120_000_000,
        investedAmount: 90_000_000,
      });
      expect(catalog[1]).toEqual({
        nameZh: '南京弘盛股权投资合伙企业（有限合伙）',
        filingCode: null,
        subscribedAmount: 80_000_000,
        paidInAmount: 50_000_000,
        investedAmount: 30_000_000,
      });
    });

    it('includes ledger-only funds in fund_catalog even when 基金汇总 omits them', async () => {
      const wb = new ExcelJS.Workbook();
      const wsDetail = wb.addWorksheet('基金流水明细');
      wsDetail.getCell(1, 1).value = '金光紫金在管基金全生命周期流水明细';
      for (let c = 0; c < DEFAULT_HEADERS.length; c++) {
        wsDetail.getCell(2, c + 1).value = DEFAULT_HEADERS[c];
      }

      // Asset row on a fund that 基金汇总 has not been updated with yet.
      wsDetail.getCell(3, 1).value = 1;
      wsDetail.getCell(3, 2).value = new Date('2023-01-01');
      wsDetail.getCell(3, 5).value = '投资';
      wsDetail.getCell(3, 6).value = '甲公司\nCompany A';
      wsDetail.getCell(3, 7).value = '企业';
      wsDetail.getCell(3, 9).value = 100;
      wsDetail.getCell(3, 12).value = '南京全新基金（有限合伙）\nNanjing Brand New Fund (LP)';

      // Commitment event on a second unlisted fund.
      wsDetail.getCell(4, 1).value = 2;
      wsDetail.getCell(4, 2).value = new Date('2023-02-01');
      wsDetail.getCell(4, 3).value = '投资人甲\nInvestor A';
      wsDetail.getCell(4, 4).value = '机构投资人';
      wsDetail.getCell(4, 5).value = '认缴';
      wsDetail.getCell(4, 6).value = '南京另一新基金（有限合伙）';
      wsDetail.getCell(4, 7).value = '基金';
      wsDetail.getCell(4, 8).value = '新增额度';
      wsDetail.getCell(4, 9).value = 500;
      wsDetail.getCell(4, 10).value = '认缴额度增加';
      wsDetail.getCell(4, 12).value = '南京另一新基金（有限合伙）';

      const wsSummary = wb.addWorksheet('基金汇总');
      wsSummary.getCell(3, 1).value = '基金名称';
      wsSummary.getCell(4, 1).value = '南京已备案基金（有限合伙）';
      wsSummary.getCell(5, 1).value = '合计';

      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      const result = await nanjingFundLedgerParser.parse(buf);
      expect(result).not.toBeNull();
      // Summary order first, then ledger-only funds — asset funds before event funds.
      expect(result!.fund_update_proposal!.fund_catalog).toEqual([
        '南京已备案基金（有限合伙）',
        '南京全新基金（有限合伙）',
        '南京另一新基金（有限合伙）',
      ]);
    });

    it('correctly classifies direct_investment vs fund_of_funds', async () => {
      const wb = new ExcelJS.Workbook();
      const wsDetail = wb.addWorksheet('基金流水明细');
      wsDetail.getCell(1, 1).value = '金光紫金在管基金全生命周期流水明细';
      for (let c = 0; c < DEFAULT_HEADERS.length; c++) {
        wsDetail.getCell(2, c + 1).value = DEFAULT_HEADERS[c];
      }

      // Direct investment
      wsDetail.getCell(3, 1).value = 1;
      wsDetail.getCell(3, 2).value = new Date('2023-01-01');
      wsDetail.getCell(3, 5).value = '投资';
      wsDetail.getCell(3, 6).value = '企业目标\nDirect Target Co';
      wsDetail.getCell(3, 7).value = '企业';
      wsDetail.getCell(3, 9).value = 100;
      wsDetail.getCell(3, 12).value = '南京瑞沣股权投资合伙企业（有限合伙）';

      // Fund of funds
      wsDetail.getCell(4, 1).value = 2;
      wsDetail.getCell(4, 2).value = new Date('2023-02-01');
      wsDetail.getCell(4, 5).value = '投资';
      wsDetail.getCell(4, 6).value = '子基金企业\nSub Fund LP';
      wsDetail.getCell(4, 7).value = '基金/合伙企业';
      wsDetail.getCell(4, 9).value = 200;
      wsDetail.getCell(4, 12).value = '南京瑞沣股权投资合伙企业（有限合伙）';

      const { assets } = parseLedgerAssets(wb);
      expect(assets).toHaveLength(2);

      const direct = assets.find((a) => a.name === '企业目标');
      expect(direct?.assetType).toBe('direct_investment');
      expect(direct?.investmentTypeLabel).toBe('Direct Investments');

      const fof = assets.find((a) => a.name === '子基金企业');
      expect(fof?.assetType).toBe('fund_of_funds');
      expect(fof?.investmentTypeLabel).toBe('Fund of Funds');
    });

    it('aggregates notes from counterparty, remarks, and non-normal status', async () => {
      const buf = await createTestWorkbookBuffer({
        dataRows: [
          {
            order: 1,
            date: new Date('2023-05-20'),
            action: '投资',
            target: '备注测试企业',
            targetType: '企业',
            nature: '首次投资',
            amountWan: 50,
            counterparty: '中国工商银行',
            remarks: '第三批投资款',
            dataStatus: '待核实',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
        ],
      });

      const result = await nanjingFundLedgerParser.parse(buf);
      expect(result).not.toBeNull();
      const txn = result!.fund_update_proposal!.assets[0].txns[0];
      expect(txn.notes).toBe('Counterparty: 中国工商银行; 第三批投资款; 待核实');
    });

    it('projects valid FundUpdateStructuredResult proposal metadata', async () => {
      const buf = await createTestWorkbookBuffer({
        dataRows: [
          {
            order: 1,
            date: new Date('2023-01-15'),
            action: '投资',
            target: '甲公司\nCompany A',
            amountWan: 100,
            fund: '南京瑞沣股权投资合伙企业（有限合伙）',
          },
          {
            order: 2,
            date: new Date('2023-09-30'),
            action: '投资',
            target: '乙公司\nCompany B',
            amountWan: 200,
            fund: '南京瑞沣股权投资合伙企业（有限合伙）',
          },
        ],
      });

      const result = await nanjingFundLedgerParser.parse(buf);
      expect(result).not.toBeNull();
      expect(result!.file_type).toBe('fund_updates');
      expect(result!.parser).toBe(NANJING_TEMPLATE_ID);
      expect(result!.file_date).toBe('2023-09-30');
      expect(result!.companies_detected).toEqual(['甲公司', '乙公司']);
      expect(result!.tags).toContain('Fund Update');
      expect(result!.tags).toContain('Nanjing');
      expect(result!.fund_update_proposal).toBeDefined();
      expect(result!.fund_update_proposal!.template_id).toBe(NANJING_TEMPLATE_ID);
      expect(result!.fund_update_proposal!.stats).toEqual({
        asset_count: 2,
        direct_count: 2,
        fund_of_funds_count: 0,
        transaction_count: 2,
        valuation_count: 0,
        commitment_event_count: 0,
      });
      expect(result!.fund_update_proposal!.fund_catalog).toEqual([
        '南京瑞沣股权投资合伙企业（有限合伙）',
        '南京金光紫金股权投资基金（有限合伙企业）',
      ]);
    });
  });

  describe('parseLedgerCommitmentEvents & commitment history wiring', () => {
    it('parses 认缴 + 新增额度 + 认缴额度增加 as an increase event with investor from col 3', async () => {
      const buf = await createTestWorkbookBuffer({
        dataRows: [
          {
            order: 1,
            date: new Date('2023-01-15'),
            entity: '南京国有资产投资主体（有限合伙）\nNanjing State-Owned Asset Investment LP',
            entityType: '机构投资人',
            action: '认缴',
            target: '南京金光紫金股权投资基金（有限合伙企业）',
            targetType: '基金',
            nature: '新增额度',
            amountWan: 5000,
            direction: '认缴额度增加',
            counterparty: null,
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
            dataStatus: '正常',
            remarks: '首期认缴',
          },
        ],
      });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      const { events, notAppliedByAction, warnings } = parseLedgerCommitmentEvents(wb);

      expect(warnings).toEqual([]);
      expect(notAppliedByAction).toEqual({});
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        fund: '南京金光紫金股权投资基金（有限合伙企业）',
        investorName: '南京国有资产投资主体（有限合伙）',
        investorTypeRaw: '机构投资人',
        investorTypeLabel: 'Institutional Investor',
        date: '2023-01-15',
        intent: 'increase',
        amount: 50_000_000,
        currency: 'CNY',
        counterpartyName: null,
        actionRaw: '认缴',
        natureRaw: '新增额度',
        directionRaw: '认缴额度增加',
        notes: 'Additional Commitment; 首期认缴',
        sourceRow: 3,
      });
    });

    it('parses 认缴 + 受让额度 as increase event with Transferred Commitment and counterparty in notes', async () => {
      const buf = await createTestWorkbookBuffer({
        dataRows: [
          {
            order: 1,
            date: new Date('2023-03-20'),
            entity: '新投资人\nNew Investor LP',
            entityType: '机构投资人',
            action: '认缴',
            target: '南京金光紫金股权投资基金（有限合伙企业）',
            targetType: '基金',
            nature: '受让额度',
            amountWan: 1200,
            direction: '认缴额度增加',
            counterparty: '原投资人\nOld Investor LP',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
            dataStatus: '正常',
            remarks: '份额转让',
          },
        ],
      });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      const { events, warnings } = parseLedgerCommitmentEvents(wb);

      expect(warnings).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0].intent).toBe('increase');
      expect(events[0].amount).toBe(12_000_000);
      expect(events[0].investorName).toBe('新投资人');
      expect(events[0].counterpartyName).toBe('原投资人');
      expect(events[0].notes).toBe('Transferred Commitment; Counterparty: 原投资人 Old Investor LP; 份额转让');
    });

    it('parses 减资 + 认缴额度减少 as decrease event', async () => {
      const buf = await createTestWorkbookBuffer({
        dataRows: [
          {
            order: 1,
            date: new Date('2023-04-10'),
            entity: '退伙投资人\nExiting Investor',
            entityType: '个人投资人',
            action: '减资',
            target: '南京金光紫金股权投资基金（有限合伙企业）',
            targetType: '基金',
            nature: '认缴额度减少',
            amountWan: 300,
            direction: '认缴额度减少',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
            dataStatus: '正常',
          },
        ],
      });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      const { events, warnings } = parseLedgerCommitmentEvents(wb);

      expect(warnings).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0].intent).toBe('decrease');
      expect(events[0].amount).toBe(3_000_000);
      expect(events[0].investorName).toBe('退伙投资人');
      expect(events[0].investorTypeLabel).toBe('Individual Investor');
      expect(events[0].notes).toBe('Reduction in Subscription Commitment');
    });

    it('excludes 投资/退出 and tracks 实缴/分配/实缴调整 in notAppliedByAction without emitting commitment events', async () => {
      const buf = await createTestWorkbookBuffer({
        dataRows: [
          {
            order: 1,
            date: new Date('2023-01-01'),
            action: '实缴',
            direction: '资金流入基金',
            amountWan: 100,
            entity: '投资人A',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
          {
            order: 2,
            date: new Date('2023-01-02'),
            action: '分配',
            direction: '资金流出基金',
            amountWan: 50,
            entity: '投资人A',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
          {
            order: 3,
            date: new Date('2023-01-03'),
            action: '实缴调整',
            direction: '非现金调整',
            amountWan: 10,
            entity: '投资人A',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
          {
            order: 4,
            date: new Date('2023-01-04'),
            action: '投资',
            direction: '资金流出基金',
            amountWan: 200,
            target: '标的公司',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
          {
            order: 5,
            date: new Date('2023-01-05'),
            action: '退出',
            direction: '资金流入基金',
            amountWan: 150,
            target: '标的公司',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
        ],
      });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      const { events, notAppliedByAction, warnings } = parseLedgerCommitmentEvents(wb);

      expect(events).toHaveLength(0);
      expect(warnings).toEqual([]);
      expect(notAppliedByAction).toEqual({
        '实缴': 1,
        '分配': 1,
        '实缴调整': 1,
      });
    });

    it('warns on unrecognised direction and records action in notAppliedByAction', async () => {
      const buf = await createTestWorkbookBuffer({
        dataRows: [
          {
            order: 1,
            date: new Date('2023-01-01'),
            action: '其他操作',
            direction: '未知流向',
            amountWan: 100,
            entity: '投资人A',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
        ],
      });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      const { events, notAppliedByAction, warnings } = parseLedgerCommitmentEvents(wb);

      expect(events).toHaveLength(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Row 3');
      expect(warnings[0]).toContain('未知流向');
      expect(notAppliedByAction).toEqual({ '其他操作': 1 });
    });

    it('skips and warns on missing date, zero amount, missing 主体, or missing 所属基金', async () => {
      const buf = await createTestWorkbookBuffer({
        dataRows: [
          // Missing date
          {
            order: 1,
            date: null,
            entity: '投资人A',
            action: '认缴',
            direction: '认缴额度增加',
            amountWan: 100,
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
          // Zero amount
          {
            order: 2,
            date: new Date('2023-01-01'),
            entity: '投资人B',
            action: '认缴',
            direction: '认缴额度增加',
            amountWan: 0,
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
          // Missing entity
          {
            order: 3,
            date: new Date('2023-01-01'),
            entity: null,
            action: '认缴',
            direction: '认缴额度增加',
            amountWan: 100,
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
          // Missing fund
          {
            order: 4,
            date: new Date('2023-01-01'),
            entity: '投资人D',
            action: '认缴',
            direction: '认缴额度增加',
            amountWan: 100,
            fund: null,
          },
        ],
      });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      const { events, warnings } = parseLedgerCommitmentEvents(wb);

      expect(events).toHaveLength(0);
      expect(warnings).toHaveLength(4);
      expect(warnings[0]).toContain('Row 3');
      expect(warnings[0]).toContain('date');
      expect(warnings[1]).toContain('Row 4');
      expect(warnings[1]).toContain('amount');
      expect(warnings[2]).toContain('Row 5');
      expect(warnings[2]).toContain('investor');
      expect(warnings[3]).toContain('Row 6');
      expect(warnings[3]).toContain('fund');
    });

    it('converts negative amount in col 9 to positive CNY amount preserving direction-derived intent', async () => {
      const buf = await createTestWorkbookBuffer({
        dataRows: [
          {
            order: 1,
            date: new Date('2023-01-15'),
            entity: '投资人A',
            action: '认缴',
            direction: '认缴额度增加',
            amountWan: -500,
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
          {
            order: 2,
            date: new Date('2023-01-16'),
            entity: '投资人A',
            action: '减资',
            direction: '认缴额度减少',
            amountWan: -200,
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
        ],
      });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      const { events } = parseLedgerCommitmentEvents(wb);

      expect(events).toHaveLength(2);
      expect(events[0].amount).toBe(5_000_000);
      expect(events[0].intent).toBe('increase');
      expect(events[1].amount).toBe(2_000_000);
      expect(events[1].intent).toBe('decrease');
    });

    it('projects proposal with both assets and commitment events, leaving asset side byte-for-byte unchanged', async () => {
      const buf = await createTestWorkbookBuffer({
        dataRows: [
          {
            order: 1,
            date: new Date('2023-01-10'),
            entity: '投资人甲\nInvestor A',
            entityType: '机构投资人',
            action: '认缴',
            target: '南京金光紫金股权投资基金（有限合伙企业）',
            targetType: '基金',
            nature: '新增额度',
            amountWan: 5000,
            direction: '认缴额度增加',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
          {
            order: 2,
            date: new Date('2023-01-15'),
            action: '投资',
            target: '目标企业甲\nTarget Corp A',
            targetType: '企业',
            nature: '首次投资',
            amountWan: 640,
            direction: '资金流出基金',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
          {
            order: 3,
            date: new Date('2023-02-01'),
            action: '实缴',
            nature: '实缴出资',
            amountWan: 2000,
            direction: '资金流入基金',
            entity: '投资人甲',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
          {
            order: 4,
            date: new Date('2023-03-01'),
            entity: '投资人乙\nInvestor B',
            entityType: '个人投资人',
            action: '减资',
            nature: '认缴额度减少',
            amountWan: 100,
            direction: '认缴额度减少',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
        ],
      });

      const result = await nanjingFundLedgerParser.parse(buf);
      expect(result).not.toBeNull();
      expect(result!.summary).toBe(
        'Nanjing 金光紫金 lifecycle ledger: 1 portfolio holdings across 1 funds, 1 transactions (CNY), 2 investor commitment events. Investor cash-flow rows (1) are not applied. Proposed only — pending review.',
      );
      expect(result!.key_points).toContain('2 proposed investor commitment events (CNY)');
      expect(result!.key_points).toContain('Rows not applied: 实缴 1');
      expect(result!.key_points).toContain('Commitment transfers are recorded as increases; the transferor side is not modeled');
      expect(result!.action_items).toContain('Review proposed investor commitment events before approving.');

      const proposal = result!.fund_update_proposal as LegacyAssetProposal;
      expect(proposal.stats).toEqual({
        asset_count: 1,
        direct_count: 1,
        fund_of_funds_count: 0,
        transaction_count: 1,
        valuation_count: 0,
        commitment_event_count: 2,
      });

      // Verify assets are intact
      expect(proposal.assets).toHaveLength(1);
      expect(proposal.assets[0].name).toBe('目标企业甲');
      expect(proposal.assets[0].txns[0].valueAmount).toBe(6_400_000);

      // Verify commitment events
      expect(proposal.commitment_events).toHaveLength(2);
      expect(proposal.commitment_events![0].investorName).toBe('投资人甲');
      expect(proposal.commitment_events![0].intent).toBe('increase');
      expect(proposal.commitment_events![0].amount).toBe(50_000_000);
      expect(proposal.commitment_events![1].investorName).toBe('投资人乙');
      expect(proposal.commitment_events![1].intent).toBe('decrease');
      expect(proposal.commitment_events![1].amount).toBe(1_000_000);
    });
  });
});
