import { describe, it, expect } from 'vitest';
import {
  MAX_RESPONSE_FEEDBACK_COMMENT_LENGTH,
  improveRequestText,
  parseResponseFeedback,
  responseFeedbackReasonsFor,
  retryQuestionTexts,
  toResponseFeedbackValue,
} from './responseFeedback';

describe('parseResponseFeedback', () => {
  it('accepts a thumbs-down with reasons and a comment, reasons in display order and deduplicated', () => {
    expect(
      parseResponseFeedback({ rating: -1, reasons: ['shallow', 'misunderstood', 'shallow'], comment: '  too thin  ' }),
    ).toEqual({ value: { rating: -1, reasons: ['misunderstood', 'shallow'], comment: 'too thin' } });
  });

  it('drops reasons from a thumbs-up', () => {
    expect(parseResponseFeedback({ rating: 1, reasons: ['shallow'] })).toEqual({
      value: { rating: 1, reasons: [], comment: null },
    });
  });

  it('accepts a comment with no rating', () => {
    expect(parseResponseFeedback({ rating: null, comment: 'Use the 2025 numbers' })).toEqual({
      value: { rating: null, reasons: [], comment: 'Use the 2025 numbers' },
    });
  });

  it('rejects a vote with neither a rating nor a comment', () => {
    expect(parseResponseFeedback({ rating: null, comment: '   ' })).toEqual({
      error: 'feedback needs a rating or a comment',
    });
  });

  it.each([0, 2, '1', 5])('rejects rating %j', (rating) => {
    expect(parseResponseFeedback({ rating })).toHaveProperty('error');
  });

  it('rejects a reason outside the closed list', () => {
    expect(parseResponseFeedback({ rating: -1, reasons: ['rude'] })).toEqual({ error: 'unknown reason: rude' });
  });

  it('rejects reasons that are not an array', () => {
    expect(parseResponseFeedback({ rating: -1, reasons: 'shallow' })).toHaveProperty('error');
  });

  it('rejects a comment over the length cap', () => {
    const comment = 'x'.repeat(MAX_RESPONSE_FEEDBACK_COMMENT_LENGTH + 1);
    expect(parseResponseFeedback({ rating: -1, comment })).toHaveProperty('error');
  });
});

describe('responseFeedbackReasonsFor', () => {
  const ids = (reply: { usedTools: boolean; structured: boolean }) =>
    responseFeedbackReasonsFor(reply).map((r) => r.id);

  it('offers the tool and display reasons only when the reply had tools or structured output', () => {
    expect(ids({ usedTools: false, structured: false })).not.toContain('unwanted_actions');
    expect(ids({ usedTools: false, structured: false })).not.toContain('broken_display');
    expect(ids({ usedTools: true, structured: false })).toContain('unwanted_actions');
    expect(ids({ usedTools: false, structured: true })).toContain('broken_display');
  });

  it('always ends with "Something else"', () => {
    expect(ids({ usedTools: true, structured: true }).at(-1)).toBe('other');
  });
});

describe('improveRequestText', () => {
  it("names the picked reasons and the user's comment, leaving out 'Something else'", () => {
    expect(improveRequestText({ reasons: ['wrong_info', 'other'], comment: ' check revenue ' })).toBe(
      'Your last answer missed the mark. Please try again and improve it.\n' +
        'What was wrong: wrong or made-up info.\n' +
        'More detail: check revenue',
    );
  });

  it('still asks for a better answer with no reasons', () => {
    expect(improveRequestText({ reasons: [], comment: null })).toBe(
      'Your last answer missed the mark. Please try again and improve it.',
    );
  });
});

describe('retryQuestionTexts', () => {
  const text = (t: string) => [{ type: 'text', text: t }];

  it("maps each reply to its question's text, without the composer's attachment markup", () => {
    const map = retryQuestionTexts([
      { role: 'user', parts: text('Compare them\n📎 Attached: A.pdf\n<!-- attach_id: 7f -->') },
      { role: 'assistant', parts: text('a1') },
      { role: 'user', parts: text('Next?') },
      { role: 'assistant', parts: text('a2') },
    ]);
    expect(map.get(1)).toBe('Compare them');
    expect(map.get(3)).toBe('Next?');
    expect(map.has(0)).toBe(false);
  });

  it("offers no retry for a reply to another bot's or a routine's message, or before any question", () => {
    const map = retryQuestionTexts([
      { role: 'assistant', parts: text('hello') },
      { role: 'user', parts: text('from a bot'), metadata: { fromBot: { id: 'b' } } },
      { role: 'assistant', parts: text('a') },
      { role: 'user', parts: text('daily'), metadata: { fromRoutine: { id: 'r' } } },
      { role: 'assistant', parts: text('b') },
    ]);
    expect(map.size).toBe(0);
  });
});

describe('toResponseFeedbackValue', () => {
  it('drops reasons no longer on the list', () => {
    expect(toResponseFeedbackValue({ rating: -1, reasons: ['shallow', 'gone'], comment: null })).toEqual({
      rating: -1,
      reasons: ['shallow'],
      comment: null,
    });
  });
});
