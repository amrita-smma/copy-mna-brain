import { describe, expect, it } from 'vitest';
import {
  finishedReportFromThread,
  isSwallowedRecursionError,
} from './recoverFinishedRun';

type Msg = { content: unknown; tool_calls?: unknown[] };
const text = (m: Msg) => (typeof m.content === 'string' ? m.content : '');

describe('isSwallowedRecursionError', () => {
  it('matches the step limit swallowed into the final message', () => {
    expect(
      isSwallowedRecursionError(
        'Error invoking agent: Recursion limit of 50 reached without hitting a stop condition.',
      ),
    ).toBe(true);
  });

  it('does not match other swallowed provider errors or a plain report', () => {
    expect(isSwallowedRecursionError('Error invoking agent: 429 rate_limit')).toBe(false);
    expect(isSwallowedRecursionError('✓ Done: hit the recursion limit workaround')).toBe(false);
  });
});

describe('finishedReportFromThread', () => {
  const narrate = { name: 'narrate_step', args: { title: 'Done', overview: 'x' } };

  it('returns the closing report when only trace plumbing is left to run', () => {
    const report = '✓ Done: Completed the pitch.';
    expect(
      finishedReportFromThread<Msg>(
        [{ content: 'hi' }, { content: report, tool_calls: [narrate, { name: 'report_progress' }] }],
        text,
      ),
    ).toBe(report);
  });

  it('returns null when the last turn still has a real tool call', () => {
    expect(
      finishedReportFromThread<Msg>(
        [{ content: '✓ Done: x', tool_calls: [narrate, { name: 'send_email' }] }],
        text,
      ),
    ).toBeNull();
  });

  it('returns null when the last message is not a done report', () => {
    expect(finishedReportFromThread<Msg>([{ content: 'Working on it', tool_calls: [narrate] }], text)).toBeNull();
    expect(finishedReportFromThread<Msg>([{ content: '✗ Could not complete: x' }], text)).toBeNull();
  });

  it('returns null for an empty thread', () => {
    expect(finishedReportFromThread<Msg>([], text)).toBeNull();
  });
});
