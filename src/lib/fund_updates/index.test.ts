import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  NANJING_TEMPLATE_ID,
  STARTECH_TEMPLATE_ID,
  fingerprintNanjingFundLedger,
  fingerprintStartechQuarterly,
  tryDeterministicFundUpdateParse,
} from './index';

async function buildMinimalStartechBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Structure');
  wb.addWorksheet('Appendix');
  const ws = wb.addWorksheet('Acme');
  ws.getCell(4, 7).value = new Date('2026-06-30'); // G4 reporting date
  ws.getCell(7, 4).value = 'Acme Corp'; // D7
  ws.getCell(10, 4).value = 'Direct Investments'; // D10
  ws.getCell(23, 3).value = 'Txn Date';
  ws.getCell(24, 3).value = new Date('2021-01-01');
  ws.getCell(24, 5).value = 'Cost of investment';
  ws.getCell(24, 8).value = -1000000;
  ws.getCell(24, 9).value = 'USD';
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

async function buildMinimalNanjingBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const wsDetail = wb.addWorksheet('基金流水明细');
  // R2 header row
  wsDetail.getCell(2, 1).value = '序号Order';
  wsDetail.getCell(2, 2).value = '发生日期Date';
  wsDetail.getCell(2, 5).value = '动作Action';
  wsDetail.getCell(2, 6).value = '对象\nTarget';
  wsDetail.getCell(2, 7).value = '对象类型Target Type';
  wsDetail.getCell(2, 8).value = '事项性质Transaction Nature';
  wsDetail.getCell(2, 9).value = '金额（万元）Amount (RMB 10,000)';
  wsDetail.getCell(2, 10).value = '金额方向\nCash Flow Direction';
  wsDetail.getCell(2, 12).value = '所属基金\nRelated Fund';
  wsDetail.getCell(2, 13).value = '数据状态Data Status';

  // R3 data row
  wsDetail.getCell(3, 1).value = 1;
  wsDetail.getCell(3, 2).value = new Date('2021-06-15');
  wsDetail.getCell(3, 5).value = '投资';
  wsDetail.getCell(3, 6).value = '目标企业 Target Co';
  wsDetail.getCell(3, 7).value = '企业';
  wsDetail.getCell(3, 8).value = '首次投资';
  wsDetail.getCell(3, 9).value = 500;
  wsDetail.getCell(3, 10).value = '资金流出基金';
  wsDetail.getCell(3, 12).value = '南京金光紫金股权投资基金（有限合伙企业）';
  wsDetail.getCell(3, 13).value = '正常';

  const wsSummary = wb.addWorksheet('基金汇总');
  wsSummary.getCell(3, 1).value = '基金名称';
  wsSummary.getCell(4, 1).value = '南京金光紫金股权投资基金（有限合伙企业）';
  wsSummary.getCell(4, 2).value = 'SD2431';
  wsSummary.getCell(4, 3).value = 10000;
  wsSummary.getCell(4, 4).value = 10000;
  wsSummary.getCell(4, 5).value = 5000;

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

describe('tryDeterministicFundUpdateParse', () => {
  it('returns null for non-Excel content types', async () => {
    const result = await tryDeterministicFundUpdateParse(
      Buffer.from('not an excel file'),
      'application/pdf',
      'report.pdf',
    );
    expect(result).toBeNull();
  });

  it('returns null when Excel fingerprint does not match', async () => {
    // Arbitrary bytes — not a valid workbook.
    const result = await tryDeterministicFundUpdateParse(
      Buffer.from('PK fake xlsx'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'random.xlsx',
    );
    expect(result).toBeNull();
  });

  it('routes STARTECH workbook to STARTECH parser and sets currency to USD', async () => {
    const buffer = await buildMinimalStartechBuffer();
    const result = await tryDeterministicFundUpdateParse(
      buffer,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'startech.xlsx',
    );
    expect(result).not.toBeNull();
    expect(result?.parser).toBe(STARTECH_TEMPLATE_ID);
    expect(result?.fund_update_proposal?.assets[0].currency).toBe('USD');
    expect(result?.fund_update_proposal?.fund_catalog).toBeDefined();
  });

  it('routes Nanjing workbook to Nanjing parser and sets currency to CNY', async () => {
    const buffer = await buildMinimalNanjingBuffer();
    const result = await tryDeterministicFundUpdateParse(
      buffer,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'nanjing.xlsx',
    );
    expect(result).not.toBeNull();
    expect(result?.parser).toBe(NANJING_TEMPLATE_ID);
    expect(result?.fund_update_proposal?.assets[0].currency).toBe('CNY');
    expect(result?.fund_update_proposal?.fund_catalog).toContain('南京金光紫金股权投资基金（有限合伙企业）');
  });
});

describe('Cross-fingerprint isolation', () => {
  it('STARTECH workbook matches STARTECH fingerprint and rejects Nanjing fingerprint', async () => {
    const startechBuffer = await buildMinimalStartechBuffer();
    await expect(fingerprintStartechQuarterly(startechBuffer)).resolves.toBe(true);
    await expect(fingerprintNanjingFundLedger(startechBuffer)).resolves.toBe(false);
  });

  it('Nanjing workbook matches Nanjing fingerprint and rejects STARTECH fingerprint', async () => {
    const nanjingBuffer = await buildMinimalNanjingBuffer();
    await expect(fingerprintNanjingFundLedger(nanjingBuffer)).resolves.toBe(true);
    await expect(fingerprintStartechQuarterly(nanjingBuffer)).resolves.toBe(false);
  });

  it('returns false for garbage buffers', async () => {
    await expect(fingerprintStartechQuarterly(Buffer.from('nope'))).resolves.toBe(false);
    await expect(fingerprintNanjingFundLedger(Buffer.from('nope'))).resolves.toBe(false);
  });
});

