import { describe, it, expect } from 'vitest';
import { listTimeLabel, previewLine } from './preview';

describe('previewLine', () => {
  it('returns an empty line when the thread has no message', () => {
    expect(previewLine(null)).toBe('');
  });

  it('flattens markdown to one plain line', () => {
    const text = '## Verdict\n\n**Pursue** — see [Reuters, 12 Mar 2026](https://x.test) and `EBITDA`.\n- point one';
    expect(previewLine({ role: 'assistant', text })).toBe('Verdict Pursue — see Reuters, 12 Mar 2026 and EBITDA. point one');
  });

  it('keeps snake_case identifiers intact while dropping *emphasis*', () => {
    expect(previewLine({ role: 'assistant', text: 'Ran *list_routines* on deal_flow' })).toBe(
      'Ran list_routines on deal_flow',
    );
  });

  it('prefixes the user\'s own latest message', () => {
    expect(previewLine({ role: 'user', text: 'Summarise my pipeline' })).toBe('You: Summarise my pipeline');
  });

  it('returns an empty line when only markup was left', () => {
    expect(previewLine({ role: 'assistant', text: '```\ncode\n```' })).toBe('');
  });

  it('drops HTML tags from previews', () => {
    expect(previewLine({ role: 'assistant', text: '<p>Hello <strong>team</strong></p>' })).toBe('Hello team');
  });
});

describe('listTimeLabel', () => {
  const now = new Date(2026, 9, 15, 21, 0); // Thu 15 Oct 2026, local time

  it('shows the time for a message sent today', () => {
    expect(listTimeLabel(new Date(2026, 9, 15, 15, 22).toISOString(), now)).toBe('3:22 PM');
  });

  it('shows the weekday within the past week', () => {
    expect(listTimeLabel(new Date(2026, 9, 11, 9, 0).toISOString(), now)).toBe('Sunday');
  });

  it('shows the month and day for older messages this year', () => {
    expect(listTimeLabel(new Date(2026, 9, 5, 9, 0).toISOString(), now)).toBe('Oct 5');
  });

  it('adds the year for messages from an earlier year', () => {
    expect(listTimeLabel(new Date(2025, 11, 30, 9, 0).toISOString(), now)).toBe('Dec 30, 2025');
  });

  it('returns nothing without a time', () => {
    expect(listTimeLabel(null, now)).toBe('');
    expect(listTimeLabel('not a date', now)).toBe('');
  });
});
