import { describe, expect, it } from 'vitest';
import {
  isSameBusinessIdentity,
  normalizeCanonicalName,
  normalizeInvestorName,
  splitBilingual,
} from './normalizeIdentity';

describe('normalizeIdentity', () => {
  describe('splitBilingual', () => {
    it('splits newline and space separated bilingual strings', () => {
      expect(splitBilingual('赛德特生物制药有限公司\nSaidet Biotech Co., Ltd.')).toEqual({
        zh: '赛德特生物制药有限公司',
        en: 'Saidet Biotech Co., Ltd.',
      });
      expect(splitBilingual('北京化药科创医药科技发展有限公司 Beijing Huayao Kechuang')).toEqual({
        zh: '北京化药科创医药科技发展有限公司',
        en: 'Beijing Huayao Kechuang',
      });
      expect(splitBilingual('南京瑞满股权投资合伙企业（有限合伙） Nanjing Ruiman LP')).toEqual({
        zh: '南京瑞满股权投资合伙企业（有限合伙）',
        en: 'Nanjing Ruiman LP',
      });
    });

    it('handles Chinese-only or English-only strings', () => {
      expect(splitBilingual('赛德特生物制药有限公司')).toEqual({
        zh: '赛德特生物制药有限公司',
        en: null,
      });
      expect(splitBilingual('Startech Growth Fund 1')).toEqual({
        zh: 'Startech Growth Fund 1',
        en: null,
      });
      expect(splitBilingual('')).toEqual({ zh: '', en: null });
      expect(splitBilingual(null)).toEqual({ zh: '', en: null });
      expect(splitBilingual(undefined)).toEqual({ zh: '', en: null });
    });
  });

  describe('normalizeCanonicalName & normalizeInvestorName', () => {
    it('normalizes leading/trailing whitespace, newlines, and internal whitespace runs', () => {
      expect(normalizeCanonicalName('  Startech   Growth   Fund 1  \n')).toBe('startech growth fund 1');
      expect(normalizeCanonicalName('\t\nACME   HOLDINGS\t')).toBe('acme holdings');
      expect(normalizeCanonicalName('  Treasury   Pool  ')).toBe('treasury pool');
    });

    it('extracts canonical native CJK name from bilingual strings', () => {
      expect(normalizeCanonicalName('赛德特生物制药有限公司 Saidet Biotech')).toBe('赛德特生物制药有限公司');
      expect(normalizeCanonicalName('赛德特生物制药有限公司\nSaidet Biotech Co., Ltd.')).toBe('赛德特生物制药有限公司');
      expect(normalizeCanonicalName('新投资人 New Investor LP')).toBe('新投资人');
    });

    it('normalizes full-width parentheses and spaces', () => {
      expect(normalizeCanonicalName('南京瑞满股权投资合伙企业（有限合伙）')).toBe('南京瑞满股权投资合伙企业(有限合伙)');
      expect(normalizeCanonicalName('南京瑞满股权投资合伙企业(有限合伙)')).toBe('南京瑞满股权投资合伙企业(有限合伙)');
      expect(normalizeCanonicalName('南京　瑞满　投资')).toBe('南京瑞满投资');
    });

    it('handles null, undefined, and empty strings gracefully', () => {
      expect(normalizeCanonicalName('')).toBe('');
      expect(normalizeCanonicalName(null)).toBe('');
      expect(normalizeCanonicalName(undefined)).toBe('');
      expect(normalizeInvestorName('   ')).toBe('');
    });
  });

  describe('isSameBusinessIdentity', () => {
    it('returns true for matching corporate identities across casing and bilingual suffixes', () => {
      expect(
        isSameBusinessIdentity(
          '赛德特生物制药有限公司',
          '赛德特生物制药有限公司 Saidet Biotech Co., Ltd.',
        ),
      ).toBe(true);

      expect(
        isSameBusinessIdentity(
          '  STARTECH GROWTH FUND 1  ',
          'startech growth fund 1',
        ),
      ).toBe(true);

      expect(
        isSameBusinessIdentity(
          '南京瑞满股权投资合伙企业（有限合伙）',
          '南京瑞满股权投资合伙企业(有限合伙)',
        ),
      ).toBe(true);
    });

    it('returns true for CJK internal space variations', () => {
      expect(
        isSameBusinessIdentity(
          '  赛德特 生物制药 有限公司  ',
          '赛德特生物制药有限公司',
        ),
      ).toBe(true);

      expect(
        isSameBusinessIdentity(
          '南京 瑞满 股权投资合伙企业(有限合伙)',
          '南京瑞满股权投资合伙企业(有限合伙)',
        ),
      ).toBe(true);
    });

    it('returns false for genuinely different business identities', () => {
      expect(isSameBusinessIdentity('南京瑞满', '南京瑞来')).toBe(false);
      expect(isSameBusinessIdentity('赛德特生物制药有限公司', '赛德特生物技术有限公司')).toBe(false);
      expect(isSameBusinessIdentity('Startech Growth Fund 1', 'Startech Growth Fund 2')).toBe(false);
      expect(isSameBusinessIdentity('Akulaku', 'Akulaku Indonesia')).toBe(false);
      expect(isSameBusinessIdentity('Alpha JWC Fund II', 'Alpha JWC Fund III')).toBe(false);
    });

    it('returns false when either input is null or empty', () => {
      expect(isSameBusinessIdentity('', '南京瑞满')).toBe(false);
      expect(isSameBusinessIdentity(null, '南京瑞满')).toBe(false);
      expect(isSameBusinessIdentity('南京瑞满', undefined)).toBe(false);
      expect(isSameBusinessIdentity('', '')).toBe(false);
    });
  });
});
