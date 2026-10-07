import { describe, expect, it } from 'vitest';
import {
  COMPANY_CONTEXT_PROMPT_MAX_CHARS,
  clipCompanyContext,
} from './companyContextPrompt';

describe('clipCompanyContext', () => {
  it('returns an empty, untruncated result for a missing context', () => {
    expect(clipCompanyContext(null)).toEqual({ text: '', truncated: false });
    expect(clipCompanyContext(undefined)).toEqual({ text: '', truncated: false });
  });

  it('treats a whitespace-only context as no context at all', () => {
    // The editor persists whatever the user leaves behind, so "cleared" can
    // arrive as blank-but-present rather than null.
    expect(clipCompanyContext('   \n\t ')).toEqual({ text: '', truncated: false });
  });

  it('trims a short context and reports it untruncated', () => {
    expect(clipCompanyContext('  Founder wants out.  ')).toEqual({
      text: 'Founder wants out.',
      truncated: false,
    });
  });

  it('leaves a context sitting exactly on the limit alone', () => {
    const exact = 'x'.repeat(COMPANY_CONTEXT_PROMPT_MAX_CHARS);
    expect(clipCompanyContext(exact)).toEqual({ text: exact, truncated: false });
  });

  it('clips an oversized context and flags that characters were dropped', () => {
    const result = clipCompanyContext(
      `${'x'.repeat(COMPANY_CONTEXT_PROMPT_MAX_CHARS)}TAIL`,
    );

    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain('TAIL');
    expect(result.text).toHaveLength(COMPANY_CONTEXT_PROMPT_MAX_CHARS + 1); // + the ellipsis
    expect(result.text.endsWith('…')).toBe(true);
  });

  it('honours a caller-supplied limit', () => {
    const result = clipCompanyContext('abcdefghij', 4);
    expect(result).toEqual({ text: 'abcd…', truncated: true });
  });

  it('measures the limit after trimming, not before', () => {
    const padded = `${' '.repeat(50)}abcd${' '.repeat(50)}`;
    expect(clipCompanyContext(padded, 4)).toEqual({
      text: 'abcd',
      truncated: false,
    });
  });
});
