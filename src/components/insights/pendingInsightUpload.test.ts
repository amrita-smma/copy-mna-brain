import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  clearPendingInsightUpload,
  peekPendingInsightUpload,
  setPendingInsightUpload,
} from './pendingInsightUpload';

const file = (name: string) => new File(['<p>x</p>'], name);

describe('pendingInsightUpload', () => {
  afterEach(() => {
    vi.useRealTimers();
    const left = peekPendingInsightUpload();
    if (left) clearPendingInsightUpload(left);
  });

  it('hands the dropped file to the next peek, and keeps it until cleared', () => {
    const f = file('a.html');
    setPendingInsightUpload(f);
    expect(peekPendingInsightUpload()).toBe(f);
    // A StrictMode double-mount peeks twice.
    expect(peekPendingInsightUpload()).toBe(f);
    clearPendingInsightUpload(f);
    expect(peekPendingInsightUpload()).toBeNull();
  });

  it('does not clear a newer drop when an older file is cleared', () => {
    const older = file('old.html');
    const newer = file('new.html');
    setPendingInsightUpload(older);
    setPendingInsightUpload(newer);
    clearPendingInsightUpload(older);
    expect(peekPendingInsightUpload()).toBe(newer);
  });

  it('ignores a file left behind by a navigation that never landed', () => {
    vi.useFakeTimers();
    setPendingInsightUpload(file('stale.html'));
    vi.advanceTimersByTime(31_000);
    expect(peekPendingInsightUpload()).toBeNull();
  });
});
