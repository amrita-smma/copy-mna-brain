import { describe, expect, it } from 'vitest';
import { isAiScreeningRun, screeningRunWriteRefusal } from './screeningRunGuard';

describe('isAiScreeningRun', () => {
  it('is true only for an ai_screening task', () => {
    expect(isAiScreeningRun({ configurable: { agent_name: 'ai_screening' } })).toBe(true);
    expect(isAiScreeningRun({ configurable: { agent_name: 'workforce' } })).toBe(false);
    expect(isAiScreeningRun({ configurable: {} })).toBe(false);
    expect(isAiScreeningRun(undefined)).toBe(false);
  });
});

describe('screeningRunWriteRefusal', () => {
  it('returns a refusal naming the action inside an ai_screening task', () => {
    const refusal = screeningRunWriteRefusal(
      { configurable: { agent_name: 'ai_screening' } },
      'Dropping a company',
    );
    expect(refusal).toMatch(/Dropping a company is not allowed in an AI Screening task/);
    expect(refusal).toMatch(/Auto promote \/ Auto drop/);
  });

  it('returns null outside an ai_screening task', () => {
    expect(screeningRunWriteRefusal({ configurable: { agent_name: null } }, 'Promoting')).toBeNull();
  });
});
