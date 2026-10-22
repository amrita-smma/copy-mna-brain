import { describe, it, expect } from 'vitest';
import {
  OptionCardValidationError,
  buildOptionCard,
  isOptionCardPayload,
  optionAnswerText,
} from './optionCards';

const base = {
  card_id: 'c1',
  question: 'Which scope?',
  options: [{ label: 'Indonesia only' }, { label: 'All of SEA', recommended: true }],
};

describe('buildOptionCard', () => {
  it('defaults to a single choice with a custom answer, trimming and de-duplicating options', () => {
    const card = buildOptionCard({
      ...base,
      question: ' Which scope? ',
      options: [...base.options, { label: ' indonesia ONLY ' }, { label: '  ' }],
    });
    expect(card).toEqual({
      card_id: 'c1',
      question: 'Which scope?',
      mode: 'single',
      options: [{ label: 'Indonesia only' }, { label: 'All of SEA', recommended: true }],
      allow_custom: true,
    });
  });

  it('keeps multi choice and a closed list when asked', () => {
    const card = buildOptionCard({ ...base, mode: 'multi', allow_custom: false });
    expect(card.mode).toBe('multi');
    expect(card.allow_custom).toBe(false);
  });

  it('rejects too few or too many options, two recommendations, and an empty question', () => {
    expect(() => buildOptionCard({ ...base, options: [{ label: 'Only one' }] })).toThrow(OptionCardValidationError);
    expect(() =>
      buildOptionCard({ ...base, options: Array.from({ length: 7 }, (_, i) => ({ label: `O${i}` })) }),
    ).toThrow(OptionCardValidationError);
    expect(() =>
      buildOptionCard({ ...base, options: base.options.map((o) => ({ ...o, recommended: true })) }),
    ).toThrow('Recommend at most one option');
    expect(() => buildOptionCard({ ...base, question: ' ' })).toThrow('The question is empty');
  });
});

describe('isOptionCardPayload', () => {
  it('accepts a built card and rejects a partial one', () => {
    expect(isOptionCardPayload(buildOptionCard(base))).toBe(true);
    expect(isOptionCardPayload({ ...buildOptionCard(base), mode: 'many' })).toBe(false);
    expect(isOptionCardPayload({ card_id: 'c1', question: 'q' })).toBe(false);
  });
});

describe('optionAnswerText', () => {
  it('sends the question with each pick, the custom answer last', () => {
    expect(optionAnswerText(base, ['All of SEA'])).toBe('Which scope?\n→ All of SEA');
    expect(optionAnswerText(base, ['Indonesia only'], ' plus Vietnam ')).toBe(
      'Which scope?\n→ Indonesia only\n→ plus Vietnam',
    );
    expect(optionAnswerText(base, [], '  ')).toBe('');
  });
});
