import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, ctor } = vi.hoisted(() => ({ invoke: vi.fn(), ctor: vi.fn() }));

vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class {
    invoke = invoke;
    constructor(opts: unknown) {
      ctor(opts);
    }
  },
}));

import {
  buildRouterPrompt,
  parseRoutedEffort,
  routeEffort,
  shouldRoute,
  OPEN_INSIGHT_EFFORT_FLOOR,
  resolveTurnEffort,
  fallbackEffort,
  isVeryShortTurn,
  ROUTER_FALLBACK,
  ROUTER_SKIP_CHARS,
  ROUTER_TIMEOUT_MS,
  SHORT_TURN_CHARS,
} from './effortRouter';

beforeEach(() => {
  invoke.mockReset();
  ctor.mockReset();
});

describe('parseRoutedEffort', () => {
  it('reads a bare tier word', () => {
    expect(parseRoutedEffort('low')).toBe('low');
    expect(parseRoutedEffort('  HIGH\n')).toBe('high');
    expect(parseRoutedEffort('medium.')).toBe('medium');
    expect(parseRoutedEffort('deep')).toBe('deep');
  });

  it('never yields max, which no tier may reach automatically', () => {
    expect(parseRoutedEffort('max')).toBeNull();
    expect(parseRoutedEffort('xhigh')).toBeNull();
  });

  it('takes the first tier word when the model writes a sentence', () => {
    expect(parseRoutedEffort('This looks like a low effort lookup.')).toBe('low');
  });

  it('returns null when no tier is present so the caller can fall back', () => {
    expect(parseRoutedEffort('I cannot help with that')).toBeNull();
    expect(parseRoutedEffort('')).toBeNull();
  });
});

describe('shouldRoute', () => {
  it('routes a never-routed thread or a turn with an attachment, and reuses the stored tier otherwise', () => {
    expect(shouldRoute(null, false)).toBe(true);
    expect(shouldRoute('low', true)).toBe(true);
    expect(shouldRoute('low', false)).toBe(false);
  });

  it('skips the router for a very short, attachment-free turn, which then falls back to low', () => {
    const short = 'thanks, continue';
    expect(isVeryShortTurn(short)).toBe(true);
    expect(shouldRoute(null, false, short)).toBe(false);
    expect(fallbackEffort({ message: short, hasAttachments: false })).toBe('low');
  });

  it('still routes a very short turn that carries an attachment', () => {
    expect(shouldRoute(null, true, 'summarise this')).toBe(true);
  });

  it('routes a turn just over the skip length, and ignores surrounding whitespace', () => {
    expect(shouldRoute(null, false, `  ${'x'.repeat(ROUTER_SKIP_CHARS)}  `)).toBe(false);
    expect(shouldRoute(null, false, 'x'.repeat(ROUTER_SKIP_CHARS + 1))).toBe(true);
  });

  it('keeps routing when the caller does not pass the message', () => {
    expect(shouldRoute(null, false, undefined)).toBe(true);
  });

  it('skips only turns short enough to be lookups, well under the fallback length', () => {
    expect(ROUTER_SKIP_CHARS).toBeLessThan(SHORT_TURN_CHARS);
  });
});

describe('buildRouterPrompt', () => {
  it('mentions attachments and the page in view when present', () => {
    const prompt = buildRouterPrompt({
      message: 'summarize this',
      hasAttachments: true,
      pageSummary: '/companies/acme',
    });
    expect(prompt).toContain('summarize this');
    expect(prompt).toContain('attachments');
    expect(prompt).toContain('/companies/acme');
  });

  it('omits the optional lines when there is nothing to report', () => {
    const prompt = buildRouterPrompt({ message: 'hello' });
    expect(prompt).not.toContain('attachments');
    expect(prompt).not.toContain('viewing');
  });

  it('truncates a very long turn so routing stays cheap', () => {
    const prompt = buildRouterPrompt({ message: 'x'.repeat(10_000) });
    expect(prompt.length).toBeLessThan(4_100);
  });
});

describe('routeEffort', () => {
  it('returns the tier the model picked', async () => {
    invoke.mockResolvedValue({ content: 'high' });
    await expect(routeEffort({ message: 'analyse Acme' }, 'k')).resolves.toBe('high');
  });

  it('reads the tier out of block-array content when thinking is on', async () => {
    invoke.mockResolvedValue({
      content: [
        { type: 'thinking', thinking: 'ignored' },
        { type: 'text', text: 'low' },
      ],
    });
    await expect(routeEffort({ message: 'what is the EBITDA' }, 'k')).resolves.toBe('low');
  });

  it('runs the routing call itself on Haiku with thinking off, at low effort, under a short timeout', async () => {
    invoke.mockResolvedValue({ content: 'low' });
    await routeEffort({ message: 'hi' }, 'k');
    expect(ctor).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-haiku-5-5',
        thinking: { type: 'disabled' },
        outputConfig: { effort: 'low' },
      }),
    );
    expect(invoke.mock.calls[0][1]).toMatchObject({ timeout: ROUTER_TIMEOUT_MS });
    expect(ROUTER_TIMEOUT_MS).toBeLessThanOrEqual(1500);
  });

  it('returns null without calling the model on an empty turn', async () => {
    await expect(routeEffort({ message: '   ' }, 'k')).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns null rather than throwing when the call fails', async () => {
    invoke.mockRejectedValue(new Error('timeout'));
    await expect(routeEffort({ message: 'analyse Acme' }, 'k')).resolves.toBeNull();
  });
});

describe('fallbackEffort', () => {
  it('runs a short, attachment-free turn at low when the router gave no answer', () => {
    expect(fallbackEffort({ message: 'thanks, and the EBITDA?' })).toBe('low');
    expect(fallbackEffort({ message: 'x'.repeat(SHORT_TURN_CHARS) })).toBe('low');
  });

  it('keeps the medium fallback for a long turn or one with attachments', () => {
    expect(fallbackEffort({ message: 'x'.repeat(SHORT_TURN_CHARS + 1) })).toBe(ROUTER_FALLBACK);
    expect(fallbackEffort({ message: 'review this', hasAttachments: true })).toBe(ROUTER_FALLBACK);
  });
});

describe('resolveTurnEffort', () => {
  it('uses the caller\'s fallback when nothing is routed, and ROUTER_FALLBACK without one', () => {
    expect(resolveTurnEffort({ requested: null, stored: null, routed: null, fallback: 'low' })).toBe('low');
    expect(resolveTurnEffort({ requested: null, stored: null, routed: 'high', fallback: 'low' })).toBe('high');
  });

  it('pins the thread to explicit requested effort', () => {
    expect(resolveTurnEffort({ requested: 'high', stored: 'low', routed: 'deep' })).toBe('high');
    expect(resolveTurnEffort({ requested: 'low', stored: 'high', routed: 'high' })).toBe('low');
  });

  it('falls back to ROUTER_FALLBACK (medium, not low) when nothing is stored or routed', () => {
    expect(resolveTurnEffort({})).toBe('medium');
    expect(resolveTurnEffort({ requested: null, stored: null, routed: null })).toBe(ROUTER_FALLBACK);
  });

  it('uses routed effort for brand-new thread with no stored tier', () => {
    expect(resolveTurnEffort({ routed: 'deep' })).toBe('deep');
  });

  it('escalates but never de-escalates an existing thread', () => {
    expect(resolveTurnEffort({ stored: 'low', routed: 'high' })).toBe('high');
    expect(resolveTurnEffort({ stored: 'high', routed: 'low' })).toBe('high');
    expect(resolveTurnEffort({ stored: 'medium', routed: 'deep' })).toBe('deep');
  });

  it('falls back to stored tier when routing fails on an existing thread', () => {
    expect(resolveTurnEffort({ stored: 'low', routed: null })).toBe('low');
  });

  it('raises an Auto turn to the floor, from the routed or the stored tier', () => {
    expect(resolveTurnEffort({ routed: 'low', floor: OPEN_INSIGHT_EFFORT_FLOOR })).toBe('medium');
    expect(resolveTurnEffort({ stored: 'low', routed: null, floor: 'medium' })).toBe('medium');
  });

  it('never lowers a tier that is already above the floor', () => {
    expect(resolveTurnEffort({ stored: 'high', floor: 'medium' })).toBe('high');
    expect(resolveTurnEffort({ routed: 'deep', floor: 'medium' })).toBe('deep');
  });

  it('never overrides a tier the user picked by hand', () => {
    expect(resolveTurnEffort({ requested: 'low', stored: 'low', floor: 'medium' })).toBe('low');
  });

  it('sets the open-insight floor to medium, the tier the chat document cap was sized for', () => {
    expect(OPEN_INSIGHT_EFFORT_FLOOR).toBe('medium');
  });
});
