import { describe, it, expect } from 'vitest';
import { isSafeHttpUrl } from './newsLinkGuard';

describe('isSafeHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isSafeHttpUrl('https://example.com/article')).toBe(true);
    expect(isSafeHttpUrl('http://example.com/article')).toBe(true);
  });

  it('rejects a javascript: URL', () => {
    expect(isSafeHttpUrl('javascript:alert(document.cookie)')).toBe(false);
  });

  it('rejects a data: URL', () => {
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects an unparseable string rather than throwing', () => {
    expect(isSafeHttpUrl('not a url')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isSafeHttpUrl('')).toBe(false);
  });
});
