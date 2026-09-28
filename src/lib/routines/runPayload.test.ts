import { describe, expect, it } from 'vitest';
import { buildOneOffRefreshRunPayload, buildRoutineRunPayload } from './runPayload';
import { buildInsightRefreshPrompt } from './insightRefresh';

describe('runPayload', () => {
  it('plain routine → exact legacy input and untouched triggerMeta', () => {
    const routine = { id: 'rt-1', title: 'Daily Market Scan', prompt: 'Scan for new companies', insight_id: null };
    const baseTriggerMeta = { routine_id: 'rt-1', fired_at: '2026-05-18T06:00:00.000Z' };

    const payload = buildRoutineRunPayload(routine, { insightName: null, agentKey: 'bangun', baseTriggerMeta });

    expect(payload.triggerMeta).toBe(baseTriggerMeta);
    // Exact legacy input: no agent key even when one is given.
    expect(payload.input).toEqual({
      title: 'Daily Market Scan',
      instruction: 'Scan for new companies',
      prompt: 'Scan for new companies',
    });
  });

  it('insight routine → insight_id in both triggerMeta and input, prompt === instruction === wrapped', () => {
    const routine = { id: 'rt-2', title: 'Refresh Competitors', prompt: 'Check new product announcements', insight_id: 'ins-42' };
    const baseTriggerMeta = { routine_id: 'rt-2', fired_at: '2026-05-18T06:00:00.000Z' };

    const expectedWrapped = buildInsightRefreshPrompt({
      insightId: 'ins-42',
      insightName: 'Competitor Landscape',
      userPrompt: 'Check new product announcements',
    });

    const payload = buildRoutineRunPayload(routine, { insightName: 'Competitor Landscape', baseTriggerMeta });

    expect(payload.triggerMeta).toEqual({
      routine_id: 'rt-2',
      fired_at: '2026-05-18T06:00:00.000Z',
      insight_id: 'ins-42',
    });

    expect(payload.input).toMatchObject({
      insight_id: 'ins-42',
      prompt: expectedWrapped,
      instruction: expectedWrapped,
      title: 'Refresh Competitors',
    });
  });

  it('insight routine → input.agent_key carries the resolved agent, general when none is given (MB-560)', () => {
    const routine = { id: 'rt-3', title: 'R', prompt: '', insight_id: 'ins-9' };
    const base = { routine_id: 'rt-3' };

    expect(
      buildRoutineRunPayload(routine, { insightName: 'X', agentKey: 'bangun', baseTriggerMeta: base })
        .input.agent_key,
    ).toBe('bangun');
    expect(
      buildRoutineRunPayload(routine, { insightName: 'X', baseTriggerMeta: base }).input.agent_key,
    ).toBe('general');
    // Not in trigger_meta: a retry drops trigger_meta but copies input.
    expect(
      buildRoutineRunPayload(routine, { insightName: 'X', agentKey: 'bangun', baseTriggerMeta: base })
        .triggerMeta,
    ).not.toHaveProperty('agent_key');
  });

});

describe('buildOneOffRefreshRunPayload', () => {
  it('carries insight_id, the resolved agent_key and the one-off flag, with a default-prompt wrap', () => {
    const payload = buildOneOffRefreshRunPayload({
      insightId: 'ins-9',
      insightName: 'Coal cohort',
      agentKey: 'minerba',
      firedAt: '2026-09-24T01:00:00.000Z',
    });
    const wrapped = buildInsightRefreshPrompt({ insightId: 'ins-9', insightName: 'Coal cohort', userPrompt: '' });

    expect(payload).toEqual({
      triggerMeta: {
        insight_id: 'ins-9',
        manual: true,
        insight_refresh: true,
        fired_at: '2026-09-24T01:00:00.000Z',
      },
      input: {
        title: 'Refresh: Coal cohort',
        instruction: wrapped,
        prompt: wrapped,
        insight_id: 'ins-9',
        agent_key: 'minerba',
        insight_refresh: true,
      },
    });
  });

  it('always has a title, so no model is asked to write one', () => {
    expect(
      buildOneOffRefreshRunPayload({ insightId: 'ins-9', insightName: null, agentKey: 'general', firedAt: 'x' }).input.title,
    ).toBe('Refresh insight');
  });
});
