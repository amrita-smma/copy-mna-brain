import { describe, it, expect } from 'vitest';
import { TASK_SUMMARY_MAX_CHARS, parseTaskSummary, taskSummaryPrompt } from './taskSummary';

describe('parseTaskSummary', () => {
  it('keeps the first line, without quotes or a trailing period', () => {
    expect(parseTaskSummary('"Screened 14 fintech targets."\nextra')).toBe('Screened 14 fintech targets');
  });

  it('logs nothing for SKIP or an empty reply', () => {
    expect(parseTaskSummary(' skip ')).toBeNull();
    expect(parseTaskSummary('')).toBeNull();
  });

  it('caps a long line', () => {
    const out = parseTaskSummary('x'.repeat(400));
    expect(out).toHaveLength(TASK_SUMMARY_MAX_CHARS);
    expect(out?.endsWith('…')).toBe(true);
  });
});

describe('taskSummaryPrompt', () => {
  it('gives the request, the clipped answer, the tools and the routine', () => {
    const prompt = taskSummaryPrompt({
      question: 'Find targets',
      answer: 'a'.repeat(5000),
      toolNames: ['query_companies'],
      routineTitle: 'Morning scan',
    });
    expect(prompt).toContain('Sent by the routine "Morning scan".');
    expect(prompt).toContain('Request:\nFind targets');
    expect(prompt).toContain('Tools used: query_companies');
    expect(prompt.length).toBeLessThan(2700);
  });
});
