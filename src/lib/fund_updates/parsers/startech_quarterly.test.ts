import { describe, expect, it } from 'vitest';
import {
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
});
