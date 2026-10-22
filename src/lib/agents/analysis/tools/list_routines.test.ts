import { beforeEach, describe, expect, it, vi } from 'vitest';

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({ createContainer: vi.fn(() => ({ botRoutineService: { list } })) }));

import { listRoutines } from './list_routines';
import { BOT_TOOL_CONFIG } from '@/lib/bots/testing/botFixtures';
import { BotNotFoundError } from '@/lib/services/botService';

describe('list_routines', () => {
  beforeEach(() => list.mockReset());

  it("lists this bot's routines with their id, schedule, state, runs and creation", async () => {
    list.mockResolvedValue([
      {
        id: 'r1',
        title: 'Morning pipeline',
        schedule_label: 'Weekdays at 09:00 (UTC)',
        enabled: true,
        next_fire_at: '2026-10-16T09:00:00.000Z',
        last_fired_at: null,
        created_at: '2026-10-01T08:00:00.000Z',
        is_mine: false,
        created_by_name: 'Ana',
        prompt: 'Summarise\nmy pipeline',
      },
    ]);

    const out = (await listRoutines.invoke({}, BOT_TOOL_CONFIG)) as string;

    expect(list).toHaveBeenCalledWith('u1', 'copilot');
    expect(out).toContain(
      '| r1 | Morning pipeline | Weekdays at 09:00 (UTC) | yes | 2026-10-16T09:00:00.000Z | never | 2026-10-01T08:00:00.000Z | Ana | Summarise my pipeline |',
    );
  });

  it('rejects, like the other routine tools, when the user cannot see the bot', async () => {
    list.mockRejectedValueOnce(new BotNotFoundError());
    expect(await listRoutines.invoke({}, BOT_TOOL_CONFIG)).toBe("Rejection: the user cannot see this bot's routines.");
  });

  it('says so when there are none', async () => {
    list.mockResolvedValue([]);
    expect(await listRoutines.invoke({}, BOT_TOOL_CONFIG)).toBe('You have no routines yet.');
  });
});
