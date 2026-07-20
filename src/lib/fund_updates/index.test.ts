import { describe, expect, it } from 'vitest';
import { tryDeterministicFundUpdateParse } from './index';
import { fingerprintStartechQuarterly } from './parsers/startech_quarterly';

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
    // Arbitrary bytes — not a valid STARTECH workbook.
    const result = await tryDeterministicFundUpdateParse(
      Buffer.from('PK fake xlsx'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'random.xlsx',
    );
    expect(result).toBeNull();
  });
});

describe('fingerprintStartechQuarterly', () => {
  it('returns false for garbage buffers', async () => {
    await expect(fingerprintStartechQuarterly(Buffer.from('nope'))).resolves.toBe(false);
  });
});
