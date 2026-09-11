import { describe, expect, it } from 'vitest';
import {
  FUND_CATALOG,
  GROUP_CATALOG,
  OTHERS_FUND,
  OTHERS_GROUP,
  UNATTRIBUTED_ENTITY,
  fundForEntity,
  groupForEntity,
  isCompositeEntity,
  parseWorkbook,
  resolveAppendixId,
  scoreAppendixNameMatch,
} from './startech_quarterly';

const APPENDIX = [
  { id: 'S017', name: 'Akulaku' },
  { id: 'S009', name: 'Gojek' },
  { id: 'S002', name: 'Air Bnb Inc' },
  { id: 'S001', name: 'Spotify Inc' },
  { id: 'S048', name: 'Mahogany (Coco)' },
  { id: 'S026', name: 'Metamask' },
  { id: 'S006', name: 'Alpha JWC 2' },
  { id: 'S023', name: 'Alpha JWC 3' },
  { id: 'S003', name: 'Alpha JWC 1' },
  { id: 'S015', name: 'Alto Pharmaceutical (Nahkoda Fund)' },
];

describe('scoreAppendixNameMatch', () => {
  it('scores exact and near-exact names highly', () => {
    expect(scoreAppendixNameMatch('Akulaku', 'Akulaku')).toBe(1);
    expect(scoreAppendixNameMatch('AirBnb', 'Air Bnb Inc')).toBeGreaterThanOrEqual(0.85);
    expect(scoreAppendixNameMatch('Coco', 'Mahogany (Coco)')).toBeGreaterThanOrEqual(0.85);
  });

  it('does not force a weak match for unrelated names', () => {
    expect(scoreAppendixNameMatch('GOTO Group', 'Gojek')).toBeLessThan(0.7);
  });
});
describe('resolveAppendixId', () => {
  it('uses manual overrides for awkward sheet codes', () => {
    expect(resolveAppendixId('GOTO', ['GOTO Group'], APPENDIX)).toBe('S009');
    expect(resolveAppendixId('AJWCII', ['Alpha JWC Fund II'], APPENDIX)).toBe('S006');
    expect(resolveAppendixId('AJWCIII', ['Alpha JWC Fund III'], APPENDIX)).toBe('S023');
  });

  it('fuzzy-matches Structure / sheet names when no override exists', () => {
    expect(resolveAppendixId('AKUL', ['AKUL', 'Akulaku'], APPENDIX)).toBe('S017');
    expect(resolveAppendixId('ABNB', ['ABNB', 'AirBnb', 'Airbnb'], APPENDIX)).toBe('S002');
    expect(resolveAppendixId('SPOT', ['SPOT', 'Spotify'], APPENDIX)).toBe('S001');
    expect(resolveAppendixId('COCO', ['COCO', 'Coco'], APPENDIX)).toBe('S048');
    expect(resolveAppendixId('META', ['META', 'Metmask'], APPENDIX)).toBe('S026');
    expect(resolveAppendixId('ALTO', ['ALTO', 'Alto Pharmaceutical'], APPENDIX)).toBe('S015');
  });

  it('returns undefined when nothing is confident', () => {
    expect(resolveAppendixId('EURO', ['EURO', 'PT Euro Medika', 'Euro Medika'], APPENDIX)).toBeUndefined();
    expect(resolveAppendixId('NEWX', ['Brand New Co'], APPENDIX)).toBeUndefined();
  });
});

describe('parseWorkbook transaction sell_proceeds_destination', () => {
  it('omits zero-value placeholder rows without share movement', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const { parseWorkbook } = await import('./startech_quarterly');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Acme');

    ws.getCell(4, 7).value = new Date('2026-06-30');
    ws.getCell(7, 4).value = 'Acme Corp';
    ws.getCell(10, 4).value = 'Direct Investments';
    ws.getCell(23, 3).value = 'Txn Date';
    ws.getCell(23, 5).value = 'Transaction Type';
    ws.getCell(23, 8).value = 'Transaction Value';
    ws.getCell(24, 3).value = new Date('2022-07-27');
    ws.getCell(24, 5).value = 'Others';
    ws.getCell(24, 8).value = 0;
    ws.getCell(25, 3).value = new Date('2022-08-01');
    ws.getCell(25, 5).value = 'Cost of Investment';
    ws.getCell(25, 8).value = -100;

    const assets = parseWorkbook(wb);
    expect(assets).toHaveLength(1);
    expect(assets[0].txns).toHaveLength(1);
    expect(assets[0].txns[0]).toMatchObject({
      date: '2022-08-01',
      valueAmount: 100,
      sourceSheet: 'Acme',
      sourceRow: 25,
      dataStatus: 'verified',
    });
  });

  it('defaults divestments to distributed_to_investor and non-divestments to null', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const { parseWorkbook } = await import('./startech_quarterly');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Acme');

    ws.getCell(4, 7).value = new Date('2026-06-30'); // G4 reporting date
    ws.getCell(7, 4).value = 'Acme Corp'; // D7
    ws.getCell(10, 4).value = 'Direct Investments'; // D10

    // Header row
    ws.getCell(23, 2).value = 'S/N';
    ws.getCell(23, 3).value = 'Txn Date';
    ws.getCell(23, 5).value = 'Transaction Type';
    ws.getCell(23, 6).value = 'Price per Share';
    ws.getCell(23, 7).value = 'No of Shares';
    ws.getCell(23, 8).value = 'Transaction Value';
    ws.getCell(23, 9).value = 'Currency';

    // Contribution row
    ws.getCell(24, 3).value = new Date('2021-01-01');
    ws.getCell(24, 5).value = 'Cost of investment';
    ws.getCell(24, 8).value = -1000000;
    ws.getCell(24, 9).value = 'USD';

    // Divestment row
    ws.getCell(25, 3).value = new Date('2023-05-15');
    ws.getCell(25, 5).value = 'Divestment';
    ws.getCell(25, 8).value = 500000;
    ws.getCell(25, 9).value = 'USD';

    const assets = parseWorkbook(wb);
    expect(assets).toHaveLength(1);
    expect(assets[0].txns).toHaveLength(2);

    expect(assets[0].txns[0]).toMatchObject({
      type: 'contribution',
      sellProceedsDestination: null,
      sourceSheet: 'Acme',
      sourceRow: 24,
    });
    expect(assets[0].txns[1]).toMatchObject({
      type: 'divestment',
      sellProceedsDestination: 'distributed_to_investor',
    });
  });

  it('parses a workbook row labelled Distribution to type divestment with sellProceedsDestination distributed_to_investor', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const { parseWorkbook } = await import('./startech_quarterly');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Acme');

    ws.getCell(4, 7).value = new Date('2026-06-30'); // G4 reporting date
    ws.getCell(7, 4).value = 'Acme Corp'; // D7
    ws.getCell(10, 4).value = 'Direct Investments'; // D10

    // Header row
    ws.getCell(23, 2).value = 'S/N';
    ws.getCell(23, 3).value = 'Txn Date';
    ws.getCell(23, 5).value = 'Transaction Type';
    ws.getCell(23, 6).value = 'Price per Share';
    ws.getCell(23, 7).value = 'No of Shares';
    ws.getCell(23, 8).value = 'Transaction Value';
    ws.getCell(23, 9).value = 'Currency';

    // Distribution row
    ws.getCell(24, 3).value = new Date('2024-06-01');
    ws.getCell(24, 5).value = 'Distribution';
    ws.getCell(24, 8).value = 250000;
    ws.getCell(24, 9).value = 'USD';

    const assets = parseWorkbook(wb);
    expect(assets).toHaveLength(1);
    expect(assets[0].txns).toHaveLength(1);
    expect(assets[0].txns[0]).toMatchObject({
      type: 'divestment',
      sellProceedsDestination: 'distributed_to_investor',
      valueAmount: 250000,
    });
  });

  it('maps return of capital and interest income with sellProceedsDestination null', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const { parseWorkbook } = await import('./startech_quarterly');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Acme');

    ws.getCell(4, 7).value = new Date('2026-06-30');
    ws.getCell(7, 4).value = 'Acme Corp';
    ws.getCell(10, 4).value = 'Direct Investments';

    ws.getCell(23, 2).value = 'S/N';
    ws.getCell(23, 3).value = 'Txn Date';
    ws.getCell(23, 5).value = 'Transaction Type';
    ws.getCell(23, 8).value = 'Transaction Value';

    ws.getCell(24, 3).value = new Date('2024-03-01');
    ws.getCell(24, 5).value = 'Return of Capital';
    ws.getCell(24, 8).value = 100000;

    ws.getCell(25, 3).value = new Date('2024-04-01');
    ws.getCell(25, 5).value = 'Interest Income';
    ws.getCell(25, 8).value = 25000;

    const assets = parseWorkbook(wb);
    expect(assets).toHaveLength(1);
    expect(assets[0].txns).toHaveLength(2);
    expect(assets[0].txns[0]).toMatchObject({
      type: 'return_of_capital',
      sellProceedsDestination: null,
      valueAmount: 100000,
    });
    expect(assets[0].txns[1]).toMatchObject({
      type: 'interest_income',
      sellProceedsDestination: null,
      valueAmount: 25000,
    });
  });

  it('keeps Market Value Tracker marks that predate G7 entry date with canonical period labels', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const { parseWorkbook } = await import('./startech_quarterly');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Acme');

    ws.getCell(4, 7).value = new Date('2026-06-30');
    ws.getCell(7, 4).value = 'Acme Corp';
    ws.getCell(7, 7).value = new Date('2026-01-15');
    ws.getCell(10, 4).value = 'Direct Investments';

    ws.getCell(23, 3).value = 'Txn Date';
    ws.getCell(23, 5).value = 'Transaction Type';
    ws.getCell(23, 8).value = 'Transaction Value';
    ws.getCell(24, 3).value = new Date('2026-01-15');
    ws.getCell(24, 5).value = 'Cost of Investment';
    ws.getCell(24, 8).value = -100;

    ws.getCell(23, 14).value = 'Date';
    ws.getCell(23, 17).value = 'Market Value';
    ws.getCell(24, 14).value = new Date('2025-12-31');
    ws.getCell(24, 17).value = 80;

    const assets = parseWorkbook(wb);
    expect(assets).toHaveLength(1);
    expect(assets[0].entryDate).toBe('2026-01-15');
    expect(assets[0].valuations[0]).toMatchObject({
      asOfDate: '2025-12-31',
      periodLabel: 'Q4 2025',
      marketValue: 80,
    });
  });

  it('parses literal FORE row taking positive magnitude for pricePerShare while preserving valueAmount and shareCount', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const { parseWorkbook } = await import('./startech_quarterly');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('FORE');

    ws.getCell(4, 7).value = new Date('2026-06-30');
    ws.getCell(7, 4).value = 'FORE';
    ws.getCell(10, 4).value = 'Direct Investments';

    // Header row
    ws.getCell(23, 2).value = 'S/N';
    ws.getCell(23, 3).value = 'Txn Date';
    ws.getCell(23, 5).value = 'Transaction Type';
    ws.getCell(23, 6).value = 'Price per Share';
    ws.getCell(23, 7).value = 'No of Shares';
    ws.getCell(23, 8).value = 'Transaction Value';
    ws.getCell(23, 9).value = 'Currency';

    // Literal FORE row: FORE / 2019-04-26 / contribution
    // valueAmount +550077.5, shareCount +30598, pricePerShare -17.97756389
    ws.getCell(24, 3).value = new Date('2019-04-26');
    ws.getCell(24, 5).value = 'contribution';
    ws.getCell(24, 6).value = -17.97756389;
    ws.getCell(24, 7).value = 30598;
    ws.getCell(24, 8).value = -550077.5;
    ws.getCell(24, 9).value = 'USD';

    const assets = parseWorkbook(wb);
    expect(assets).toHaveLength(1);
    expect(assets[0].txns).toHaveLength(1);
    expect(assets[0].txns[0]).toMatchObject({
      date: '2019-04-26',
      type: 'contribution',
      pricePerShare: 17.97756389,
      shareCount: 30598,
      valueAmount: 550077.5,
    });
  });

  it('parses valuation row taking positive magnitude for pricePerShare and currentPricePerShare (:645)', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const { parseWorkbook } = await import('./startech_quarterly');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('FORE');

    ws.getCell(4, 7).value = new Date('2026-06-30');
    ws.getCell(7, 4).value = 'FORE';
    ws.getCell(10, 4).value = 'Direct Investments';

    // Transaction header and row so the sheet has ledger events
    ws.getCell(23, 2).value = 'S/N';
    ws.getCell(23, 3).value = 'Txn Date';
    ws.getCell(23, 5).value = 'Transaction Type';
    ws.getCell(23, 8).value = 'Transaction Value';
    ws.getCell(24, 3).value = new Date('2019-04-26');
    ws.getCell(24, 5).value = 'Cost of Investment';
    ws.getCell(24, 8).value = -550077.5;

    // Valuation Tracker header row (row 23, cols N..)
    ws.getCell(23, 14).value = 'Date';
    ws.getCell(23, 15).value = 'Price per Share';
    ws.getCell(23, 16).value = 'Market Value';
    ws.getCell(23, 17).value = 'No of Shares';

    // Valuation row with negative pps
    ws.getCell(24, 14).value = new Date('2019-06-30');
    ws.getCell(24, 15).value = -17.97756389;
    ws.getCell(24, 16).value = 550077.5;
    ws.getCell(24, 17).value = 30598;

    const assets = parseWorkbook(wb);
    expect(assets).toHaveLength(1);
    expect(assets[0].valuations).toHaveLength(1);
    expect(assets[0].valuations[0]).toMatchObject({
      asOfDate: '2019-06-30',
      pricePerShare: 17.97756389,
      marketValue: 550077.5,
      sharesOutstanding: 30598,
    });
    expect(assets[0].currentPricePerShare).toBe(17.97756389);
  });

  it('populates investor holder fields, sets group === fund, and sets holderName to entity when present', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Acme');

    ws.getCell(4, 7).value = new Date('2026-06-30');
    ws.getCell(7, 4).value = 'Acme Corp';
    ws.getCell(8, 7).value = 'Startech Growth Fund VCC';
    ws.getCell(10, 4).value = 'Direct Investments';
    ws.getCell(23, 3).value = 'Txn Date';
    ws.getCell(23, 5).value = 'Transaction Type';
    ws.getCell(23, 8).value = 'Transaction Value';
    ws.getCell(24, 3).value = new Date('2026-01-15');
    ws.getCell(24, 5).value = 'Cost of Investment';
    ws.getCell(24, 8).value = -100;

    const assets = parseWorkbook(wb);
    expect(assets).toHaveLength(1);
    const asset = assets[0];
    expect(asset.holderKind).toBe('investor');
    expect(asset.group).toBe(asset.fund);
    expect(asset.group).toBe('Startech Growth Fund 1');
    expect(asset.holderName).toBe('Startech Growth Fund VCC');
    expect(asset.entity).toBe('Startech Growth Fund VCC');
    expect(asset.entityIsComposite).toBe(false);
    expect(asset.entityIsUnattributed).toBe(false);
  });

  it('falls back to UNATTRIBUTED_ENTITY and marks entityIsUnattributed when G8 is NA', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Acme');

    ws.getCell(4, 7).value = new Date('2026-06-30');
    ws.getCell(7, 4).value = 'Acme Corp';
    ws.getCell(8, 7).value = 'NA';
    ws.getCell(10, 4).value = 'Direct Investments';
    ws.getCell(23, 3).value = 'Txn Date';
    ws.getCell(23, 5).value = 'Transaction Type';
    ws.getCell(23, 8).value = 'Transaction Value';
    ws.getCell(24, 3).value = new Date('2026-01-15');
    ws.getCell(24, 5).value = 'Cost of Investment';
    ws.getCell(24, 8).value = -100;

    const assets = parseWorkbook(wb);
    expect(assets).toHaveLength(1);
    const asset = assets[0];
    expect(asset.entity).toBeNull();
    expect(asset.entityIsUnattributed).toBe(true);
    expect(asset.holderName).toBe(UNATTRIBUTED_ENTITY);
    expect(asset.holderKind).toBe('investor');
    expect(asset.group).toBe('Others');
    expect(asset.group).toBe(asset.fund);
    expect(asset.entityIsComposite).toBe(false);
  });
});

describe('GROUP_CATALOG', () => {
  it('has the 8 expected strings in order, and FUND_CATALOG === GROUP_CATALOG', () => {
    expect(GROUP_CATALOG).toEqual([
      'Startech Growth Fund 1',
      'Startech Growth Fund 2',
      'Startech Growth Fund 3',
      'Startech Growth Fund 4',
      'Startech Growth Fund 5',
      'Meranti 1',
      'Meranti 2',
      'Others',
    ]);
    expect(FUND_CATALOG).toBe(GROUP_CATALOG);
    expect(OTHERS_GROUP).toBe('Others');
    expect(OTHERS_FUND).toBe(OTHERS_GROUP);
  });
});

describe('groupForEntity', () => {
  const cases: Array<[string | null, string]> = [
    ['Meranti Global Investment Ltd', 'Meranti 1'],
    ['Meranti Global Investment Ltd.', 'Meranti 1'],
    ['Meranti Global Investment Pte. Ltd', 'Meranti 2'],
    ['Startech Growth Fund VCC', 'Startech Growth Fund 1'],
    ['Startech Partners Ltd', 'Startech Growth Fund 1'],
    ['SMG Management Ltd', 'Others'],
    [null, 'Others'],
  ];

  it.each(cases)('maps %s -> %s', (entity, expected) => {
    expect(groupForEntity(entity)).toBe(expected);
  });
});

describe('fundForEntity', () => {
  const cases: Array<[string | null, string]> = [
    ['Meranti Global Investment Ltd', 'Meranti 1'],
    ['Meranti Global Investment Ltd.', 'Meranti 1'],
    ['Meranti Global Investment Pte. Ltd', 'Meranti 2'],
    ['Startech Growth Fund VCC', 'Startech Growth Fund 1'],
    ['Startech Partners Ltd', 'Startech Growth Fund 1'],
    ['SMG Management Ltd', 'Others'],
    [null, 'Others'],
  ];

  it.each(cases)('returns the same value as groupForEntity for %s', (entity, expected) => {
    expect(fundForEntity(entity)).toBe(expected);
    expect(fundForEntity(entity)).toBe(groupForEntity(entity));
  });
});

describe('isCompositeEntity', () => {
  it('returns true for composite entity strings', () => {
    expect(
      isCompositeEntity(
        'Asia Star Fund Ltd, Meranti Global Investment Ltd, Hawthorn Limited',
      ),
    ).toBe(true);
    expect(
      isCompositeEntity('Meranti Global Investment Ltd. & Startech Growth VCC'),
    ).toBe(true);
    expect(
      isCompositeEntity('PT Sinarmas Ventura & PT Akselerasi Digital Inovasi'),
    ).toBe(true);
  });

  it('returns false for single entities and null', () => {
    expect(isCompositeEntity(null)).toBe(false);
    expect(isCompositeEntity('Spruce Capital Investments Pte. Ltd.')).toBe(false);
    expect(isCompositeEntity('Nano Digital Technology Ltd (BVI)')).toBe(false);
    expect(isCompositeEntity('Startech Growth Fund VCC')).toBe(false);
  });
});
