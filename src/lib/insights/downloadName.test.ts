import { describe, it, expect } from 'vitest';
import { insightHtmlFileName } from './downloadName';

describe('insightHtmlFileName', () => {
  it('slugifies the name and adds .html', () => {
    expect(insightHtmlFileName('APAC Market Scan — Q3 2026!')).toBe('apac-market-scan-q3-2026.html');
  });

  it('keeps letters of any script', () => {
    expect(insightHtmlFileName('南京 基金 报告')).toBe('南京-基金-报告.html');
    expect(insightHtmlFileName('Laporan Pasar Ölçüm')).toBe('laporan-pasar-ölçüm.html');
  });

  it('falls back to insight when the name has no letters or digits', () => {
    expect(insightHtmlFileName('  ---  ')).toBe('insight.html');
    expect(insightHtmlFileName('')).toBe('insight.html');
  });

  it('caps a long name without leaving a trailing hyphen', () => {
    const name = `${'a'.repeat(79)} bcd`;
    const file = insightHtmlFileName(name);
    expect(file).toBe(`${'a'.repeat(79)}.html`);
  });
});
