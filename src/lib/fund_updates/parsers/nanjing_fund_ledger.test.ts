import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  extractFirstCounterpartyToken,
  fingerprintNanjingFundLedger,
  generateNanjingAssetCode,
  isNanjingAssetCode,
  NANJING_ASSET_CODE_PREFIX,
  NANJING_TEMPLATE_ID,
  nanjingFundLedgerParser,
  normalizeInvestorName,
  parseFundCatalog,
  parseLedgerAssets,
  parseLedgerCommitmentEvents,
  reconcileNanjingFundLedger,
  splitBilingual,
  validateTransferCounterparty,
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
    expect(assetA.englishName).toBe('Beijing Huayao Kechuang');
    expect(assetB.legalName).toBe('北京化药科创医药科技发展有限公司');
    expect(assetB.englishName).toBe('Beijing Huayao Kechuang');
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
          { order: 1, action: '认缴', nature: '新增额度', amountWan: 1000, fund: '南京瑞满股权投资合伙企业（有限合伙）' },
          { order: 2, action: '实缴', nature: '实缴出资', amountWan: 800, fund: '南京瑞满股权投资合伙企业（有限合伙）' },
          { order: 3, action: '减资', nature: '减资返还', amountWan: 100, fund: '南京瑞满股权投资合伙企业（有限合伙）' },
          { order: 4, action: '分配', nature: '减资分配', amountWan: 50, fund: '南京瑞满股权投资合伙企业（有限合伙）' },
          { order: 5, action: '实缴调整', nature: '损益核销', amountWan: 10, fund: '南京瑞满股权投资合伙企业（有限合伙）' },
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

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      const { assets, lpRowCount } = parseLedgerAssets(wb);
      expect(assets).toHaveLength(1);
      expect(assets[0].name).toBe('赛德特生物制药有限公司');
      expect(assets[0].englishName).toBe('Saidet Bio');
      expect(lpRowCount).toBe(5);

      const result = await nanjingFundLedgerParser.parse(buf);
      expect(result).not.toBeNull();
      const proposal = result!.fund_update_proposal!;
      expect(proposal.assets).toHaveLength(1);
      expect(proposal.assets[0].name).toBe('赛德特生物制药有限公司');
      expect(proposal.assets[0].englishName).toBe('Saidet Bio');
      expect(proposal.assets[0].txns).toHaveLength(1);
      expect(result!.summary).toContain('1 portfolio holdings across 1 funds, 1 transactions (CNY)');
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
      expect(contribution.sourceRow).toBe(3);
      expect(contribution.subTypeLabel).toBe('Initial Investment');
      expect(contribution.sellProceedsDestination).toBeNull();

      const divestment = asset.txns[1];
      expect(divestment.type).toBe('divestment');
      expect(divestment.sourceRow).toBe(4);
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

      // Bilingual cell: splits into Chinese and English name fields.
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
        nameEn: null,
        filingCode: 'SD2431',
        subscribedAmount: 150_000_000,
        paidInAmount: 120_000_000,
        investedAmount: 90_000_000,
      });
      expect(catalog[1]).toEqual({
        nameZh: '南京弘盛股权投资合伙企业（有限合伙）',
        nameEn: 'Nanjing Hongsheng Equity Investment Partnership (LP)',
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
      const proposal = result!.fund_update_proposal as LegacyAssetProposal;
      // Summary order first, then ledger-only funds — asset funds before event funds.
      expect(proposal.fund_catalog).toEqual([
        '南京已备案基金（有限合伙）',
        '南京全新基金（有限合伙）',
        '南京另一新基金（有限合伙）',
      ]);
      expect(proposal.fund_catalog_items).toEqual([
        {
          nameZh: '南京已备案基金（有限合伙）',
          nameEn: null,
          filingCode: null,
          subscribedAmount: null,
          paidInAmount: null,
          investedAmount: null,
        },
        {
          nameZh: '南京全新基金（有限合伙）',
          nameEn: 'Nanjing Brand New Fund (LP)',
          filingCode: null,
          subscribedAmount: null,
          paidInAmount: null,
          investedAmount: null,
        },
        {
          nameZh: '南京另一新基金（有限合伙）',
          nameEn: null,
          filingCode: null,
          subscribedAmount: null,
          paidInAmount: null,
          investedAmount: null,
        },
      ]);
      expect(result!.fund_update_proposal!.assets[0].fundEnglishName).toBe('Nanjing Brand New Fund (LP)');
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
      expect(direct?.englishName).toBe('Direct Target Co');
      expect(direct?.assetType).toBe('direct_investment');
      expect(direct?.investmentTypeLabel).toBe('Direct Investments');

      const fof = assets.find((a) => a.name === '子基金企业');
      expect(fof?.englishName).toBe('Sub Fund LP');
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
      expect(result!.fund_update_proposal!.assets[0].englishName).toBe('Company A');
      expect(result!.fund_update_proposal!.assets[1].englishName).toBe('Company B');
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
        review_item_count: 0,
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
        fundEnglishName: null,
        investorName: '南京国有资产投资主体（有限合伙）',
        investorEnglishName: 'Nanjing State-Owned Asset Investment LP',
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
        sourceSheet: '基金流水明细',
        dataStatus: 'verified',
      });
    });

    it('parses 认缴 + 受让额度 as transfer_in event with Transferred Commitment and counterparty in notes', async () => {
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
      expect(events[0].intent).toBe('transfer_in');
      expect(events[0].amount).toBe(12_000_000);
      expect(events[0].investorName).toBe('新投资人');
      expect(events[0].investorEnglishName).toBe('New Investor LP');
      expect(events[0].counterpartyName).toBe('原投资人 Old Investor LP');
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
      expect(events[0].investorEnglishName).toBe('Exiting Investor');
      expect(events[0].investorTypeLabel).toBe('Individual Investor');
      expect(events[0].notes).toBe('Reduction in Subscription Commitment');
    });

    it('emits 实缴/分配 investor cash flows and leaves non-cash 实缴调整 unsupported', async () => {
      const buf = await createTestWorkbookBuffer({
        dataRows: [
          {
            order: 1,
            date: new Date('2023-01-01'),
            action: '实缴',
            direction: '资金流入基金',
            amountWan: 100,
            entity: '投资人甲',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
          {
            order: 2,
            date: new Date('2023-01-02'),
            action: '分配',
            direction: '资金流出基金',
            amountWan: 50,
            entity: '南京金光紫金股权投资基金（有限合伙企业）',
            target: '投资人甲',
            fund: '南京金光紫金股权投资基金（有限合伙企业）',
          },
          {
            order: 3,
            date: new Date('2023-01-03'),
            action: '实缴调整',
            direction: '非现金调整',
            amountWan: 10,
            entity: '投资人甲',
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

      expect(events).toHaveLength(2);
      expect(events.map((e) => e.intent)).toEqual(['paid_in', 'distribution']);
      expect(events.map((e) => e.investorName)).toEqual(['投资人甲', '投资人甲']);
      expect(warnings).toEqual([]);
      expect(notAppliedByAction).toEqual({
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
        'Nanjing 金光紫金 lifecycle ledger: 1 portfolio holdings across 1 funds, 1 transactions (CNY), 3 investor lifecycle events (0 transfers), 0 non-cash review items. Proposed only — pending review.',
      );
      expect(result!.key_points).toContain('3 proposed investor lifecycle events (CNY)');
      expect(result!.action_items).toContain('Review proposed investor commitment and cash-flow events before approving.');

      const proposal = result!.fund_update_proposal as LegacyAssetProposal;
      expect(proposal.stats).toEqual({
        asset_count: 1,
        direct_count: 1,
        fund_of_funds_count: 0,
        transaction_count: 1,
        valuation_count: 0,
        commitment_event_count: 3,
        review_item_count: 0,
      });

      // Verify assets are intact
      expect(proposal.assets).toHaveLength(1);
      expect(proposal.assets[0].name).toBe('目标企业甲');
      expect(proposal.assets[0].englishName).toBe('Target Corp A');
      expect(proposal.assets[0].txns[0].valueAmount).toBe(6_400_000);

      // Verify commitment events
      expect(proposal.commitment_events).toHaveLength(3);
      expect(proposal.commitment_events![0].investorName).toBe('投资人甲');
      expect(proposal.commitment_events![0].investorEnglishName).toBe('Investor A');
      expect(proposal.commitment_events![0].intent).toBe('increase');
      expect(proposal.commitment_events![0].amount).toBe(50_000_000);
      expect(proposal.commitment_events![1].intent).toBe('paid_in');
      expect(proposal.commitment_events![1].amount).toBe(20_000_000);
      expect(proposal.commitment_events![2].investorName).toBe('投资人乙');
      expect(proposal.commitment_events![2].investorEnglishName).toBe('Investor B');
      expect(proposal.commitment_events![2].intent).toBe('decrease');
      expect(proposal.commitment_events![2].amount).toBe(1_000_000);
    });
  });

  describe('Ledger gaps worker 2: Transfer pairing, catalog retention, reconciliation & review items', () => {
    describe('normalizeInvestorName', () => {
      it('trims, collapses multiple whitespace characters, and case folds', () => {
        expect(normalizeInvestorName('  南京 国有资产  投资主体   ')).toBe('南京国有资产投资主体');
        expect(normalizeInvestorName('New   Investor   LP\nInc  ')).toBe('new investor lp inc');
        expect(normalizeInvestorName('\t\nACME   HOLDINGS\t')).toBe('acme holdings');
        expect(normalizeInvestorName('新投资人 New Investor LP')).toBe('新投资人');
        expect(normalizeInvestorName('')).toBe('');
        expect(normalizeInvestorName(null)).toBe('');
        expect(normalizeInvestorName(undefined)).toBe('');
      });
    });

    describe('extractFirstCounterpartyToken', () => {
      it('extracts first counterparty token from delimited or single strings', () => {
        expect(extractFirstCounterpartyToken('青岛金光紫金创业投资管理有限')).toBe('青岛金光紫金创业投资管理有限');
        expect(extractFirstCounterpartyToken('青岛金光紫金创业投资管理有限；王国庆')).toBe('青岛金光紫金创业投资管理有限');
        expect(extractFirstCounterpartyToken('投资人甲、投资人乙')).toBe('投资人甲');
        expect(extractFirstCounterpartyToken('LP A, LP B')).toBe('LP A');
        expect(extractFirstCounterpartyToken(null)).toBeNull();
        expect(extractFirstCounterpartyToken('')).toBeNull();
      });
    });

    describe('validateTransferCounterparty', () => {
      it('validates single Chinese, English, and bilingual counterparty entity names', () => {
        expect(validateTransferCounterparty('北京高新创投有限公司')).toEqual({ valid: true });
        expect(validateTransferCounterparty('Master LP Alpha')).toEqual({ valid: true });
        expect(validateTransferCounterparty('原投资人甲\nOriginal LP A')).toEqual({ valid: true });
        expect(validateTransferCounterparty('未知对手方机构')).toEqual({ valid: true });
      });

      it('rejects missing or empty strings', () => {
        expect(validateTransferCounterparty(null).valid).toBe(false);
        expect(validateTransferCounterparty('').valid).toBe(false);
        expect(validateTransferCounterparty('   ').valid).toBe(false);
      });

      it('rejects placeholder tokens', () => {
        const placeholders = ['未知', '待定', 'TBD', 'N/A', 'NA', '-', '--', '?', '待确认', '暂无', '无'];
        for (const p of placeholders) {
          const res = validateTransferCounterparty(p);
          expect(res.valid).toBe(false);
          expect(res.isIncomplete).toBe(true);
        }
      });

      it('rejects tentative or unverified annotations', () => {
        const tentative = ['原投资人（待确认）', 'LP A (待定)', '投资方（待核实）', '某机构（待查）'];
        for (const t of tentative) {
          const res = validateTransferCounterparty(t);
          expect(res.valid).toBe(false);
          expect(res.isIncomplete).toBe(true);
        }
      });

      it('accepts a Chinese legal name ending in bare 有限 exactly as written', () => {
        const res = validateTransferCounterparty('青岛金光紫金创业投资管理有限');
        expect(res.valid).toBe(true);
      });

      it('rejects multi-party strings with delimiters or conjunctions', () => {
        const multiParty = [
          '投资人甲、投资人乙',
          'LP A / LP B',
          'LP A, LP B',
          'LP A + LP B',
          'LP A & LP B',
          '投资人甲及投资人乙',
          '投资人甲与投资人乙',
          '投资人甲和投资人乙',
          '投资人甲以及投资人乙',
          '投资人甲等',
          'LP Alpha and LP Beta',
        ];
        for (const mp of multiParty) {
          const res = validateTransferCounterparty(mp);
          expect(res.valid).toBe(false);
          expect(res.isMultiParty).toBe(true);
        }
      });
    });

    describe('Transfer-in intent and deterministic pairing', () => {
      it('pairs transfer_in with known workbook investor and marks eligible for transfer out', async () => {
        const buf = await createTestWorkbookBuffer({
          dataRows: [
            {
              order: 1,
              date: new Date('2023-01-01'),
              entity: '原投资人甲\nOriginal LP A',
              entityType: '机构投资人',
              action: '认缴',
              nature: '新增额度',
              amountWan: 5000,
              direction: '认缴额度增加',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
            {
              order: 2,
              date: new Date('2023-03-20'),
              entity: '受让投资人乙\nTransferee LP B',
              entityType: '机构投资人',
              action: '认缴',
              nature: '受让额度',
              amountWan: 1200,
              direction: '认缴额度增加',
              counterparty: '原投资人甲\nOriginal LP A',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
          ],
        });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as ArrayBuffer);
        const { events } = parseLedgerCommitmentEvents(wb);

        const transferEv = events.find((e) => e.intent === 'transfer_in');
        expect(transferEv).toBeDefined();
        expect(transferEv!.transferPairing).toEqual({
          status: 'paired',
          transferorName: '原投资人甲',
          counterpartyRaw: '原投资人甲 Original LP A',
          matchedReductionSourceRow: null,
          eligibleForTransferOut: true,
          requiresReview: false,
        });
      });

      it('pairs transfer_in with knownMasterInvestors from options when counterparty is not in workbook', async () => {
        const buf = await createTestWorkbookBuffer({
          dataRows: [
            {
              order: 1,
              date: new Date('2023-03-20'),
              entity: '受让投资人乙',
              entityType: '机构投资人',
              action: '认缴',
              nature: '受让额度',
              amountWan: 1000,
              direction: '认缴额度增加',
              counterparty: ' Master LP Alpha ',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
          ],
        });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as ArrayBuffer);
        const { events } = parseLedgerCommitmentEvents(wb, {
          knownMasterInvestors: ['Master LP Alpha'],
        });

        expect(events).toHaveLength(1);
        expect(events[0].intent).toBe('transfer_in');
        expect(events[0].transferPairing).toEqual({
          status: 'paired',
          transferorName: 'Master LP Alpha',
          counterpartyRaw: 'Master LP Alpha',
          matchedReductionSourceRow: null,
          eligibleForTransferOut: true,
          requiresReview: false,
        });
      });

      it('surfaces unknown valid counterparty with eligibleForTransferOut: true for proposed investor catalog', async () => {
        const buf = await createTestWorkbookBuffer({
          dataRows: [
            {
              order: 1,
              date: new Date('2023-03-20'),
              entity: '受让投资人乙',
              entityType: '机构投资人',
              action: '认缴',
              nature: '受让额度',
              amountWan: 1000,
              direction: '认缴额度增加',
              counterparty: '未知对手方机构',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
          ],
        });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as ArrayBuffer);
        const { events } = parseLedgerCommitmentEvents(wb);

        expect(events).toHaveLength(1);
        expect(events[0].intent).toBe('transfer_in');
        expect(events[0].transferPairing?.status).toBe('unknown_counterparty');
        expect(events[0].transferPairing?.transferorName).toBe('未知对手方机构');
        expect(events[0].transferPairing?.eligibleForTransferOut).toBe(true);
        expect(events[0].transferPairing?.requiresReview).toBe(false);
      });

      it('splits bilingual unknown counterparty and stores native name as transferorName', async () => {
        const buf = await createTestWorkbookBuffer({
          dataRows: [
            {
              order: 1,
              date: new Date('2023-03-20'),
              entity: '受让投资人乙',
              entityType: '机构投资人',
              action: '认缴',
              nature: '受让额度',
              amountWan: 1000,
              direction: '认缴额度增加',
              counterparty: '北京高新创投有限公司\nBeijing HighTech VC Ltd',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
          ],
        });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as ArrayBuffer);
        const { events } = parseLedgerCommitmentEvents(wb);

        expect(events).toHaveLength(1);
        expect(events[0].transferPairing?.transferorName).toBe('北京高新创投有限公司');
        expect(events[0].transferPairing?.eligibleForTransferOut).toBe(true);
        expect(events[0].transferPairing?.requiresReview).toBe(false);
      });

      it('uses first counterparty token for delimited transferor strings without composite entities', async () => {
        const testCases = [
          { raw: '原投资人甲、原投资人乙', expectedFirst: '原投资人甲' },
          { raw: '青岛金光紫金创业投资管理有限；王国庆', expectedFirst: '青岛金光紫金创业投资管理有限' },
          { raw: 'LP Alpha, LP Beta', expectedFirst: 'LP Alpha' },
        ];

        for (const tc of testCases) {
          const buf = await createTestWorkbookBuffer({
            dataRows: [
              {
                order: 1,
                date: new Date('2023-03-20'),
                entity: '受让投资人乙',
                entityType: '机构投资人',
                action: '认缴',
                nature: '受让额度',
                amountWan: 1000,
                direction: '认缴额度增加',
                counterparty: tc.raw,
                fund: '南京金光紫金股权投资基金（有限合伙企业）',
              },
            ],
          });
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(buf as unknown as ArrayBuffer);
          const { events, reviewItems } = parseLedgerCommitmentEvents(wb);

          expect(events).toHaveLength(1);
          expect(events[0].transferPairing?.eligibleForTransferOut).toBe(true);
          expect(events[0].transferPairing?.requiresReview).toBe(false);
          expect(events[0].transferPairing?.transferorName).toBe(tc.expectedFirst);
          expect(events[0].transferPairing?.counterpartyRaw).toBe(tc.raw);
          expect(reviewItems).toHaveLength(0);
        }
      });

      it('keeps conjunction-based multi-party strings review-required and non-postable', async () => {
        const testCases = [
          '投资人甲及投资人乙',
          '投资人甲与投资人乙',
          '投资人甲和投资人乙',
          '投资人甲以及投资人乙',
          '投资人甲等',
        ];

        for (const multiPartyCp of testCases) {
          const buf = await createTestWorkbookBuffer({
            dataRows: [
              {
                order: 1,
                date: new Date('2023-03-20'),
                entity: '受让投资人乙',
                entityType: '机构投资人',
                action: '认缴',
                nature: '受让额度',
                amountWan: 1000,
                direction: '认缴额度增加',
                counterparty: multiPartyCp,
                fund: '南京金光紫金股权投资基金（有限合伙企业）',
              },
            ],
          });
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(buf as unknown as ArrayBuffer);
          const { events } = parseLedgerCommitmentEvents(wb);

          expect(events).toHaveLength(1);
          expect(events[0].transferPairing?.eligibleForTransferOut).toBe(false);
          expect(events[0].transferPairing?.requiresReview).toBe(true);
          expect(events[0].transferPairing?.transferorName).toBeNull();
          expect(events[0].transferPairing?.reviewReason).toContain('Multi-party counterparty string');
        }
      });

      it('keeps incomplete and placeholder counterparty strings review-required and non-postable', async () => {
        const testCases = [
          '未知',
          '待定',
          'TBD',
          'N/A',
          '待确认',
          '暂无',
          '无',
          '原投资人（待确认）',
          '原投资人（待定）',
          '待核实',
        ];

        for (const placeholderCp of testCases) {
          const buf = await createTestWorkbookBuffer({
            dataRows: [
              {
                order: 1,
                date: new Date('2023-03-20'),
                entity: '受让投资人乙',
                entityType: '机构投资人',
                action: '认缴',
                nature: '受让额度',
                amountWan: 1000,
                direction: '认缴额度增加',
                counterparty: placeholderCp,
                fund: '南京金光紫金股权投资基金（有限合伙企业）',
              },
            ],
          });
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(buf as unknown as ArrayBuffer);
          const { events } = parseLedgerCommitmentEvents(wb);

          expect(events).toHaveLength(1);
          expect(events[0].transferPairing?.eligibleForTransferOut).toBe(false);
          expect(events[0].transferPairing?.requiresReview).toBe(true);
          expect(events[0].transferPairing?.transferorName).toBeNull();
        }
      });

      it('flags missing counterparty as review-required', async () => {
        const buf = await createTestWorkbookBuffer({
          dataRows: [
            {
              order: 1,
              date: new Date('2023-03-20'),
              entity: '受让投资人乙',
              entityType: '机构投资人',
              action: '认缴',
              nature: '受让额度',
              amountWan: 1000,
              direction: '认缴额度增加',
              counterparty: null,
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
          ],
        });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as ArrayBuffer);
        const { events } = parseLedgerCommitmentEvents(wb);

        expect(events).toHaveLength(1);
        expect(events[0].intent).toBe('transfer_in');
        expect(events[0].transferPairing?.status).toBe('missing_counterparty');
        expect(events[0].transferPairing?.eligibleForTransferOut).toBe(false);
        expect(events[0].transferPairing?.requiresReview).toBe(true);
      });

      it('suppresses generated transferor when matching reciprocal 认缴额度减少 row exists in workbook', async () => {
        const buf = await createTestWorkbookBuffer({
          dataRows: [
            {
              order: 1,
              date: new Date('2023-03-20'),
              entity: '受让投资人乙',
              entityType: '机构投资人',
              action: '认缴',
              nature: '受让额度',
              amountWan: 1200,
              direction: '认缴额度增加',
              counterparty: '原投资人甲',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
            {
              order: 2,
              date: new Date('2023-03-20'),
              entity: '原投资人甲',
              entityType: '机构投资人',
              action: '减资',
              nature: '认缴额度减少',
              amountWan: 1200,
              direction: '认缴额度减少',
              counterparty: '受让投资人乙',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
          ],
        });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as ArrayBuffer);
        const { events } = parseLedgerCommitmentEvents(wb);

        const transferEv = events.find((e) => e.intent === 'transfer_in');
        expect(transferEv).toBeDefined();
        expect(transferEv!.transferPairing).toEqual({
          status: 'reciprocal_reduction_found',
          transferorName: '原投资人甲',
          counterpartyRaw: '原投资人甲',
          matchedReductionSourceRow: 4, // Row 4 (order 2)
          eligibleForTransferOut: false,
          requiresReview: false,
          reviewReason: 'Matching reciprocal reduction row found in workbook (Row 4).',
        });
      });

      it('marks ambiguous matches when multiple reciprocal reductions or transfers compete', async () => {
        const buf = await createTestWorkbookBuffer({
          dataRows: [
            {
              order: 1,
              date: new Date('2023-03-20'),
              entity: '受让投资人乙',
              action: '认缴',
              nature: '受让额度',
              amountWan: 500,
              direction: '认缴额度增加',
              counterparty: '原投资人甲',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
            {
              order: 2,
              date: new Date('2023-03-20'),
              entity: '受让投资人丙',
              action: '认缴',
              nature: '受让额度',
              amountWan: 500,
              direction: '认缴额度增加',
              counterparty: '原投资人甲',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
            {
              order: 3,
              date: new Date('2023-03-20'),
              entity: '原投资人甲',
              action: '减资',
              nature: '认缴额度减少',
              amountWan: 500,
              direction: '认缴额度减少',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
          ],
        });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as ArrayBuffer);
        const { events } = parseLedgerCommitmentEvents(wb);

        const transferEvents = events.filter((e) => e.intent === 'transfer_in');
        expect(transferEvents).toHaveLength(2);
        expect(transferEvents[0].transferPairing?.status).toBe('ambiguous');
        expect(transferEvents[0].transferPairing?.eligibleForTransferOut).toBe(false);
        expect(transferEvents[0].transferPairing?.requiresReview).toBe(true);
        expect(transferEvents[1].transferPairing?.status).toBe('ambiguous');
        expect(transferEvents[1].transferPairing?.eligibleForTransferOut).toBe(false);
        expect(transferEvents[1].transferPairing?.requiresReview).toBe(true);
      });
    });

    describe('Non-cash review items (实缴调整/损益核销)', () => {
      it('surfaces 实缴调整/损益核销 as structured non-postable ReviewProposalItem and tracks stats', async () => {
        const buf = await createTestWorkbookBuffer({
          dataRows: [
            {
              order: 1,
              date: new Date('2023-05-10'),
              entity: '投资人甲\nInvestor A',
              entityType: '机构投资人',
              action: '实缴调整',
              nature: '损益核销',
              amountWan: 15,
              direction: '非现金调整',
              fund: '南京瑞沣股权投资合伙企业（有限合伙）',
            },
          ],
        });

        const result = await nanjingFundLedgerParser.parse(buf);
        expect(result).not.toBeNull();
        const proposal = result!.fund_update_proposal as LegacyAssetProposal;

        expect(proposal.assets).toHaveLength(0);
        expect(proposal.review_items).toHaveLength(1);
        expect(proposal.review_items![0]).toMatchObject({
          sourceRow: 3,
          fund: '南京瑞沣股权投资合伙企业（有限合伙）',
          investorName: '投资人甲',
          investorEnglishName: 'Investor A',
          investorTypeRaw: '机构投资人',
          date: '2023-05-10',
          amount: 150_000,
          currency: 'CNY',
          action: '实缴调整',
          nature: '损益核销',
          direction: '非现金调整',
          category: 'non_cash_adjustment',
          explanation:
            'Non-cash adjustment (实缴调整 / 损益核销) requires manual review; adjusts paid-in capital by the row amount without changing cash or commitment.',
          isPostable: false,
          requiresReview: true,
        });

        expect(proposal.stats.review_item_count).toBe(1);
        expect(result!.key_points).toContain(
          '1 non-cash review item(s) (实缴调整/损益核销) surfaced for manual review (non-postable)',
        );
        expect(result!.action_items).toContain(
          'Review 1 non-cash adjustment/write-off item(s) (实缴调整/损益核销).',
        );
      });

      it('resolves Target column investor when Entity is the fund for 实缴调整/损益核销', async () => {
        const buf = await createTestWorkbookBuffer({
          dataRows: [
            {
              order: 1,
              date: new Date('2023-05-10'),
              entity: '南京瑞沣股权投资合伙企业（有限合伙）',
              entityType: '基金',
              target: '南京市紫金科技投资集团有限公司',
              targetType: '机构投资人',
              action: '实缴调整',
              nature: '损益核销',
              amountWan: 80,
              direction: '非现金调整',
              fund: '南京瑞沣股权投资合伙企业（有限合伙）',
            },
          ],
        });

        const result = await nanjingFundLedgerParser.parse(buf);
        expect(result).not.toBeNull();
        const proposal = result!.fund_update_proposal as LegacyAssetProposal;

        expect(proposal.review_items).toHaveLength(1);
        expect(proposal.review_items![0]).toMatchObject({
          sourceRow: 3,
          fund: '南京瑞沣股权投资合伙企业（有限合伙）',
          investorName: '南京市紫金科技投资集团有限公司',
          investorTypeRaw: '机构投资人',
          targetRaw: '南京市紫金科技投资集团有限公司',
          entityRaw: '南京瑞沣股权投资合伙企业（有限合伙）',
          action: '实缴调整',
          nature: '损益核销',
          category: 'non_cash_adjustment',
          amount: 800_000,
        });
      });

      it('Row 33: extracts valuation write-down for 高亚投资有限公司 in 南京金光紫金股权投资基金 with 914,781.37 CNY', async () => {
        const buf = await createTestWorkbookBuffer({
          dataRows: [
            {
              order: 31,
              date: new Date('2022-12-31'),
              entity: '南京金光紫金股权投资基金（有限合伙企业）',
              entityType: '基金',
              target: '高亚投资有限公司 GLOBE ASIA INVESTMENTS LIMITED',
              targetType: '机构投资人',
              action: '实缴调整',
              nature: '损益核销',
              amountWan: 91.478137,
              direction: '非现金调整',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
          ],
        });

        const result = await nanjingFundLedgerParser.parse(buf);
        expect(result).not.toBeNull();
        const proposal = result!.fund_update_proposal as LegacyAssetProposal;

        expect(proposal.review_items).toHaveLength(1);
        expect(proposal.review_items![0]).toMatchObject({
          sourceRow: 3,
          fund: '南京金光紫金股权投资基金（有限合伙企业）',
          investorName: '高亚投资有限公司',
          investorEnglishName: 'GLOBE ASIA INVESTMENTS LIMITED',
          investorTypeRaw: '机构投资人',
          date: '2022-12-31',
          amount: 914781.37,
          currency: 'CNY',
          action: '实缴调整',
          nature: '损益核销',
          direction: '非现金调整',
          category: 'non_cash_adjustment',
          requiresReview: true,
          isPostable: false,
        });
      });
    });

    describe('Rows 94 and 95 counterparty policy', () => {
      it('Row 94: uses 青岛金光紫金创业投资管理有限 exactly as written and marks eligible for transfer out', async () => {
        const buf = await createTestWorkbookBuffer({
          dataRows: [
            {
              order: 92,
              date: new Date('2023-08-15'),
              entity: '受让投资人甲\nTransferee LP A',
              entityType: '机构投资人',
              action: '认缴',
              nature: '受让额度',
              amountWan: 500,
              direction: '认缴额度增加',
              counterparty: '青岛金光紫金创业投资管理有限',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
          ],
        });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as ArrayBuffer);
        const { events, reviewItems } = parseLedgerCommitmentEvents(wb);

        expect(events).toHaveLength(1);
        expect(events[0].intent).toBe('transfer_in');
        expect(events[0].counterpartyName).toBe('青岛金光紫金创业投资管理有限');
        expect(events[0].transferPairing).toEqual({
          status: 'unknown_counterparty',
          transferorName: '青岛金光紫金创业投资管理有限',
          counterpartyRaw: '青岛金光紫金创业投资管理有限',
          matchedReductionSourceRow: null,
          eligibleForTransferOut: true,
          requiresReview: false,
        });
        expect(reviewItems).toHaveLength(0);
      });

      it('Row 95: uses only first counterparty from 青岛金光紫金创业投资管理有限；王国庆 and preserves raw provenance in counterpartyRaw/notes', async () => {
        const buf = await createTestWorkbookBuffer({
          dataRows: [
            {
              order: 93,
              date: new Date('2023-08-15'),
              entity: '受让投资人乙\nTransferee LP B',
              entityType: '机构投资人',
              action: '认缴',
              nature: '受让额度',
              amountWan: 300,
              direction: '认缴额度增加',
              counterparty: '青岛金光紫金创业投资管理有限；王国庆',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
          ],
        });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as ArrayBuffer);
        const { events, reviewItems } = parseLedgerCommitmentEvents(wb);

        expect(events).toHaveLength(1);
        expect(events[0].intent).toBe('transfer_in');
        expect(events[0].counterpartyName).toBe('青岛金光紫金创业投资管理有限；王国庆');
        expect(events[0].notes).toContain('Counterparty: 青岛金光紫金创业投资管理有限；王国庆');
        expect(events[0].transferPairing).toEqual({
          status: 'unknown_counterparty',
          transferorName: '青岛金光紫金创业投资管理有限',
          counterpartyRaw: '青岛金光紫金创业投资管理有限；王国庆',
          matchedReductionSourceRow: null,
          eligibleForTransferOut: true,
          requiresReview: false,
        });
        expect(reviewItems).toHaveLength(0);
      });
    });

    describe('Full Fund Catalog Retention', () => {
      it('preserves typed fund_catalog_items with filingCode, subscribedAmount, paidInAmount, and investedAmount', async () => {
        const buf = await createTestWorkbookBuffer({
          summaryRows: [
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
          dataRows: [
            {
              order: 1,
              date: new Date('2023-05-20'),
              action: '投资',
              target: '企业A',
              targetType: '企业',
              nature: '首次投资',
              amountWan: 640,
              direction: '资金流出基金',
              fund: '南京瑞沣股权投资合伙企业（有限合伙）',
            },
            {
              order: 2,
              date: new Date('2023-06-20'),
              action: '投资',
              target: '企业B',
              targetType: '企业',
              nature: '首次投资',
              amountWan: 300,
              direction: '资金流出基金',
              fund: '未在汇总出现的账簿基金',
            },
          ],
        });

        const result = await nanjingFundLedgerParser.parse(buf);
        expect(result).not.toBeNull();
        const proposal = result!.fund_update_proposal as LegacyAssetProposal;

        // Backward compatibility string catalog
        expect(proposal.fund_catalog).toEqual([
          '南京瑞沣股权投资合伙企业（有限合伙）',
          '南京金光紫金股权投资基金（有限合伙企业）',
          '未在汇总出现的账簿基金',
        ]);

        // Full typed catalog items
        expect(proposal.fund_catalog_items).toEqual([
          {
            nameZh: '南京瑞沣股权投资合伙企业（有限合伙）',
            nameEn: null,
            filingCode: 'SD2431',
            subscribedAmount: 100_000_000,
            paidInAmount: 80_000_000,
            investedAmount: 60_000_000,
          },
          {
            nameZh: '南京金光紫金股权投资基金（有限合伙企业）',
            nameEn: null,
            filingCode: null, // '未备案' normalized to null
            subscribedAmount: 50_000_000,
            paidInAmount: 30_000_000,
            investedAmount: 20_000_000,
          },
          {
            nameZh: '未在汇总出现的账簿基金',
            nameEn: null,
            filingCode: null,
            subscribedAmount: null,
            paidInAmount: null,
            investedAmount: null,
          },
        ]);
      });
    });

    describe('Advisory Per-Fund Reconciliation', () => {
      it('calculates reconciliation for net commitment, paid-in, and invested amounts against summary', async () => {
        const buf = await createTestWorkbookBuffer({
          summaryRows: [
            {
              name: '南京金光紫金股权投资基金（有限合伙企业）',
              filingCode: 'SD2431',
              subscribedWan: 3800, // 38,000,000 CNY (40M increase - 2M decrease; 12M paired transfer nets to 0)
              paidInWan: 3000,     // 30,000,000 CNY
              investedWan: 1000,   // 10,000,000 CNY
            },
          ],
          dataRows: [
            // Net Commitment: 40M increase + 12M transfer (paired with synthetic -12M) - 2M decrease = 38M
            {
              order: 1,
              date: new Date('2023-01-01'),
              entity: '投资人A',
              action: '认缴',
              nature: '新增额度',
              amountWan: 4000,
              direction: '认缴额度增加',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
            {
              order: 2,
              date: new Date('2023-01-02'),
              entity: '投资人B',
              action: '认缴',
              nature: '受让额度',
              amountWan: 1200,
              direction: '认缴额度增加',
              counterparty: '投资人A',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
            {
              order: 3,
              date: new Date('2023-01-03'),
              entity: '投资人A',
              action: '减资',
              nature: '认缴额度减少',
              amountWan: 200,
              direction: '认缴额度减少',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
            // Paid-in cash: 20M (differs from summary 30M)
            {
              order: 4,
              date: new Date('2023-01-10'),
              entity: '投资人A',
              action: '实缴',
              nature: '实缴出资',
              amountWan: 2000,
              direction: '资金流入基金',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
            // Non-cash adjustment of 10M
            {
              order: 5,
              date: new Date('2023-01-11'),
              entity: '投资人A',
              action: '实缴调整',
              nature: '损益核销',
              amountWan: 1000,
              direction: '非现金调整',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
            // Invested amount: 10M (reconciled with 10M)
            {
              order: 6,
              date: new Date('2023-02-01'),
              action: '投资',
              target: '企业A',
              targetType: '企业',
              nature: '首次投资',
              amountWan: 1000,
              direction: '资金流出基金',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
          ],
        });

        const result = await nanjingFundLedgerParser.parse(buf);
        expect(result).not.toBeNull();
        const proposal = result!.fund_update_proposal as LegacyAssetProposal;

        expect(proposal.reconciliation).toHaveLength(3);

        const subRecon = proposal.reconciliation!.find(
          (r) => r.metricName === 'Net Commitment vs Subscribed',
        );
        expect(subRecon).toBeDefined();
        expect(subRecon!.sourceValue).toBe(38_000_000);
        expect(subRecon!.calculatedValue).toBe(38_000_000);
        expect(subRecon!.diff).toBe(0);
        expect(subRecon!.isReconciled).toBe(true);

        const paidRecon = proposal.reconciliation!.find(
          (r) => r.metricName === 'Paid-in Capital vs Summary',
        );
        expect(paidRecon).toBeDefined();
        expect(paidRecon!.sourceValue).toBe(30_000_000);
        expect(paidRecon!.calculatedValue).toBe(20_000_000);
        expect(paidRecon!.diff).toBe(-10_000_000);
        expect(paidRecon!.isReconciled).toBe(false);
        // Includes explanation about the non-cash adjustment in notes
        expect(paidRecon!.notes).toContain(
          '1 non-cash adjustment item(s) (实缴调整/损益核销) totaling 10,000,000 CNY surfaced for review',
        );

        const invRecon = proposal.reconciliation!.find(
          (r) => r.metricName === 'Invested Amount vs Summary',
        );
        expect(invRecon).toBeDefined();
        expect(invRecon!.sourceValue).toBe(10_000_000);
        expect(invRecon!.calculatedValue).toBe(10_000_000);
        expect(invRecon!.diff).toBe(0);
        expect(invRecon!.isReconciled).toBe(true);

        // Key points self-description
        expect(result!.key_points).toContain(
          'Reconciliation: 2/3 fund metrics reconciled against 基金汇总 summary',
        );
        expect(result!.action_items).toContain(
          'Resolve 1 reconciliation difference(s) against 基金汇总 summary before approval.',
        );
      });

      it('nets paired synthetic transfers to zero at fund level during reconciliation', async () => {
        const buf = await createTestWorkbookBuffer({
          summaryRows: [
            {
              name: '南京金光紫金股权投资基金（有限合伙企业）',
              filingCode: 'SD2431',
              subscribedWan: 5000, // 50,000,000 CNY
            },
          ],
          dataRows: [
            // 50M initial commitment to LP A
            {
              order: 1,
              date: new Date('2023-01-01'),
              entity: '投资人A',
              action: '认缴',
              nature: '新增额度',
              amountWan: 5000,
              direction: '认缴额度增加',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
            // LP A transfers 15M to LP B (paired synthetic transfer, no reciprocal reduction row in workbook)
            {
              order: 2,
              date: new Date('2023-01-15'),
              entity: '投资人B',
              action: '认缴',
              nature: '受让额度',
              amountWan: 1500,
              direction: '认缴额度增加',
              counterparty: '投资人A',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
            // Portfolio asset row so workbook is recognized as valid proposal
            {
              order: 3,
              date: new Date('2023-02-01'),
              action: '投资',
              target: '企业A',
              targetType: '企业',
              nature: '首次投资',
              amountWan: 500,
              direction: '资金流出基金',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
          ],
        });

        const result = await nanjingFundLedgerParser.parse(buf);
        expect(result).not.toBeNull();
        const proposal = result!.fund_update_proposal as LegacyAssetProposal;

        const subRecon = proposal.reconciliation!.find(
          (r) => r.metricName === 'Net Commitment vs Subscribed',
        );
        expect(subRecon).toBeDefined();
        expect(subRecon!.sourceValue).toBe(50_000_000);
        // Calculated must net to exactly 50M (+50M increase +15M transfer_in -15M synthetic transfer_out = 50M)
        expect(subRecon!.calculatedValue).toBe(50_000_000);
        expect(subRecon!.diff).toBe(0);
        expect(subRecon!.isReconciled).toBe(true);
      });

      it('balances workbook reciprocal reduction and transfer_in exactly once', async () => {
        const buf = await createTestWorkbookBuffer({
          summaryRows: [
            {
              name: '南京金光紫金股权投资基金（有限合伙企业）',
              filingCode: 'SD2431',
              subscribedWan: 5000, // 50,000,000 CNY
            },
          ],
          dataRows: [
            // 50M initial commitment to LP A
            {
              order: 1,
              date: new Date('2023-01-01'),
              entity: '投资人A',
              action: '认缴',
              nature: '新增额度',
              amountWan: 5000,
              direction: '认缴额度增加',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
            // Explicit decrease row in workbook for LP A (-10M)
            {
              order: 2,
              date: new Date('2023-01-15'),
              entity: '投资人A',
              action: '减资',
              nature: '认缴额度减少',
              amountWan: 1000,
              direction: '认缴额度减少',
              counterparty: '投资人B',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
            // Explicit transfer_in row in workbook for LP B (+10M)
            {
              order: 3,
              date: new Date('2023-01-15'),
              entity: '投资人B',
              action: '认缴',
              nature: '受让额度',
              amountWan: 1000,
              direction: '认缴额度增加',
              counterparty: '投资人A',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
            // Portfolio asset row
            {
              order: 4,
              date: new Date('2023-02-01'),
              action: '投资',
              target: '企业A',
              targetType: '企业',
              nature: '首次投资',
              amountWan: 500,
              direction: '资金流出基金',
              fund: '南京金光紫金股权投资基金（有限合伙企业）',
            },
          ],
        });

        const result = await nanjingFundLedgerParser.parse(buf);
        expect(result).not.toBeNull();
        const proposal = result!.fund_update_proposal as LegacyAssetProposal;

        const subRecon = proposal.reconciliation!.find(
          (r) => r.metricName === 'Net Commitment vs Subscribed',
        );
        expect(subRecon).toBeDefined();
        expect(subRecon!.sourceValue).toBe(50_000_000);
        // Calculated must balance to exactly 50M (50M increase + 10M transfer - 10M decrease = 50M)
        expect(subRecon!.calculatedValue).toBe(50_000_000);
        expect(subRecon!.diff).toBe(0);
        expect(subRecon!.isReconciled).toBe(true);
      });
    });
  });
});
