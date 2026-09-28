import { describe, expect, it } from 'vitest';
import { validateReportPlan, type ReportPlanQuestion } from './plan';

describe('validateReportPlan', () => {
  const plan = (questions: ReportPlanQuestion[]) =>
    validateReportPlan({
      request: 'Compare TSMC vs Samsung margins',
      methodology: 'Compare gross and operating margins from 2021 to 2024.',
      questions,
    });
  const question = (options: ReportPlanQuestion['options'], id = 'q1'): ReportPlanQuestion => ({
    id,
    question: 'Pick one',
    options,
  });
  const labels = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Opt ${i + 1}` }));

  it.each([
    ['zero questions', []],
    ['questions with and without a recommended option', [
      question([{ label: 'Last 3 years', recommended: true }, { label: 'Last 5 years' }]),
      question(labels(4), 'q2'),
    ]],
  ])('accepts a plan with %s', (_label, questions) => {
    expect(plan(questions as ReportPlanQuestion[])).toBeNull();
  });

  it.each([
    ['more than 3 questions', [1, 2, 3, 4].map((i) => question(labels(2), `q${i}`)), 'at most 3 questions'],
    ['a question with fewer than 2 options', [question(labels(1))], 'between 2 and 4 options'],
    ['a question with more than 4 options', [question(labels(5))], 'between 2 and 4 options'],
    [
      'a question with more than one recommended option',
      [question([{ label: 'A', recommended: true }, { label: 'B', recommended: true }])],
      'At most one option per question can be marked recommended',
    ],
  ])('rejects %s', (_label, questions, message) => {
    expect(plan(questions)).toContain(message);
  });
});
