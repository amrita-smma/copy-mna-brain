import { describe, expect, it } from 'vitest';
import { apiRoutineToUi, type ApiRoutine } from './routineApi';

function row(overrides: Partial<ApiRoutine> = {}): ApiRoutine {
  return {
    id: 'rt-1',
    title: 'Refresh',
    prompt: '',
    schedule_kind: 'daily',
    schedule_spec: { time: '09:00' },
    cron_expression: '0 9 * * *',
    timezone: 'UTC',
    agent_name: null,
    priority: 0,
    enabled: true,
    last_fired_at: null,
    next_fire_at: '2099-01-01T09:00:00.000Z',
    created_by: 'u-1',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    archived_at: null,
    insight_id: 'ins-1',
    insight_name: 'Coal Q3',
    ...overrides,
  };
}

describe('apiRoutineToUi — pause state (MB-560)', () => {
  it('maps a system pause to its reason and a notice naming the agent from the list row', () => {
    const ui = apiRoutineToUi(
      row({ enabled: false, paused_reason: 'agent_deprecated', insight_agent_key: 'bangun' }),
    );
    expect(ui.enabled).toBe(false);
    expect(ui.pausedReason).toBe('agent_deprecated');
    expect(ui.pausedNotice).toBe('Paused — @bangun was deprecated. Rebind the insight to resume.');
    expect(ui.nextRun).toBe('paused');
  });

  it('names the agent from opts when the row has no insight_agent_key (the per-insight endpoint)', () => {
    const ui = apiRoutineToUi(row({ enabled: false, paused_reason: 'agent_incompatible' }), {
      insightAgentKey: 'dikti',
    });
    expect(ui.pausedNotice).toBe(
      'Paused — @dikti no longer fits this insight. Rebind the insight to resume.',
    );
  });

  it('keeps a manual pause distinct: no reason, no notice', () => {
    const ui = apiRoutineToUi(row({ enabled: false, paused_reason: null, insight_agent_key: 'bangun' }));
    expect(ui.pausedReason).toBeNull();
    expect(ui.pausedNotice).toBeNull();
  });

  it('ignores a reason outside the closed set and rows that predate the column', () => {
    expect(apiRoutineToUi(row({ paused_reason: 'bogus' })).pausedReason).toBeNull();
    expect(apiRoutineToUi(row()).pausedNotice).toBeNull();
  });
});
