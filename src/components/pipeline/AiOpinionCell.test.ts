import { describe, expect, it } from 'vitest';
import { aiOpinionText } from './AiOpinionCell';

const opinion = (over: Partial<Parameters<typeof aiOpinionText>[0]> = {}) => ({
  ai_opinion_verdict: 'pass',
  ai_opinion_summary: 'Strong margins, fits the thesis',
  ai_opinion_status: 'completed',
  ...over,
});

describe('aiOpinionText', () => {
  it('names the verdict in place of the icon, then the summary', () => {
    expect(aiOpinionText(opinion())).toBe('Pass: Strong margins, fits the thesis');
    expect(aiOpinionText(opinion({ ai_opinion_verdict: 'tentative', ai_opinion_summary: null }))).toBe('Tentative');
  });

  it('says Analyzing… while a run is in flight, as the cell does', () => {
    expect(aiOpinionText(opinion({ ai_opinion_status: 'processing' }))).toBe('Analyzing…');
  });

  it('is empty when there is no verdict', () => {
    expect(aiOpinionText(opinion({ ai_opinion_verdict: null }))).toBe('');
  });
});
