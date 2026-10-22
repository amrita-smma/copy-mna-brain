import { beforeEach, describe, expect, it, vi } from 'vitest';

const { list, archive } = vi.hoisted(() => ({ list: vi.fn(), archive: vi.fn() }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({ createContainer: vi.fn(() => ({ botRoutineService: { list, archive } })) }));

import { deleteRoutine } from './delete_routine';
import { BOT_TOOL_CONFIG } from '@/lib/bots/testing/botFixtures';
import { BotRoutineNotFoundError } from '@/lib/services/botRoutineService';
import { BotForbiddenError } from '@/lib/services/botService';

const routines = [
  { id: 'r1', title: 'Morning pipeline', schedule_label: 'Weekdays at 09:00 (Asia/Jakarta)', is_mine: true, created_by_name: null },
  { id: 'r2', title: 'CRM digest', schedule_label: 'Daily at 18:00 (UTC)', is_mine: false, created_by_name: 'Ana' },
];

describe('delete_routine', () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue(routines);
    archive.mockReset().mockResolvedValue(undefined);
  });

  it('archives the routine named by title and reports it', async () => {
    expect(await deleteRoutine.invoke({ routine: 'morning pipeline' }, BOT_TOOL_CONFIG)).toBe(
      'Deleted the routine "Morning pipeline" (Weekdays at 09:00 (Asia/Jakarta), id r1).',
    );
    expect(archive).toHaveBeenCalledWith('u1', 'copilot', 'r1');
  });

  it("says whose routine it was when it was someone else's", async () => {
    const out = (await deleteRoutine.invoke({ routine: 'r2' }, BOT_TOOL_CONFIG)) as string;
    expect(out).toContain('Deleted the routine "CRM digest"');
    expect(out).toContain('It was created by Ana; it no longer runs for them either.');
  });

  it('refuses an ambiguous or unknown reference without archiving', async () => {
    list.mockResolvedValue([...routines, { ...routines[0], id: 'r3', title: 'Morning CRM' }]);
    expect(await deleteRoutine.invoke({ routine: 'morning' }, BOT_TOOL_CONFIG)).toBe(
      'Rejection: no single routine matches "morning". Call list_routines and name one by its id or exact title.',
    );
    expect(archive).not.toHaveBeenCalled();
  });

  it('reports a vanished routine and a forbidden bot as rejections', async () => {
    archive.mockRejectedValueOnce(new BotRoutineNotFoundError());
    expect(await deleteRoutine.invoke({ routine: 'r1' }, BOT_TOOL_CONFIG)).toBe('Rejection: the routine "r1" is already gone.');
    archive.mockRejectedValueOnce(new BotForbiddenError());
    expect(await deleteRoutine.invoke({ routine: 'r1' }, BOT_TOOL_CONFIG)).toBe("Rejection: the user cannot change this bot's routines.");
  });

  it('only runs inside a bot chat', async () => {
    expect(await deleteRoutine.invoke({ routine: 'r1' }, { configurable: { userId: 'u1' } })).toMatch(/^\*\*Error:\*\*/);
    expect(list).not.toHaveBeenCalled();
  });
});
