import { beforeEach, describe, expect, it, vi } from 'vitest';

const { preview } = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({ createContainer: vi.fn(() => ({ botRoutineService: { preview } })) }));

import { proposeCreateRoutine } from './propose_create_routine';
import { BOT_TOOL_CONFIG } from '@/lib/bots/testing/botFixtures';
import { extractApprovalPayload } from '@/lib/insights/approvalMarker';
import { BOT_ROUTINE_APPROVAL_MARKER, type BotRoutineApprovalPayload } from '@/lib/bots/approval';
import { BotRoutineValidationError } from '@/lib/services/botRoutineService';
import { BotForbiddenError } from '@/lib/services/botService';

const args = {
  title: 'Morning pipeline',
  message: 'Summarise what moved in my pipeline yesterday.',
  schedule: 'weekly' as const,
  time: '09:00',
  weekdays: [1, 2, 3, 4, 5],
  timezone: 'Asia/Jakarta',
};

describe('propose_create_routine', () => {
  beforeEach(() => {
    preview.mockReset().mockImplementation(async (_userId, _botId, input) => ({
      bot: { id: 'copilot', name: 'Deal Desk', visibility: 'workspace', is_default: false },
      routine: { ...input },
      label: 'Weekdays at 09:00 (Asia/Jakarta)',
    }));
  });

  it('validates the routine for this bot and hands the card a payload, without scheduling anything', async () => {
    const out = (await proposeCreateRoutine.invoke(args, BOT_TOOL_CONFIG)) as string;

    expect(preview).toHaveBeenCalledWith('u1', 'copilot', {
      title: 'Morning pipeline',
      prompt: 'Summarise what moved in my pipeline yesterday.',
      schedule_kind: 'weekly',
      schedule_spec: { time: '09:00', weekdays: [1, 2, 3, 4, 5] },
      timezone: 'Asia/Jakarta',
    });
    const payload = extractApprovalPayload<BotRoutineApprovalPayload>(out, BOT_ROUTINE_APPROVAL_MARKER);
    expect(payload).toMatchObject({
      bot_id: 'copilot',
      shared: true,
      schedule_label: 'Weekdays at 09:00 (Asia/Jakarta)',
      input: { title: 'Morning pipeline', schedule_kind: 'weekly', timezone: 'Asia/Jakarta' },
    });
    expect(out).toContain('everyone in the workspace will see the routine');
  });

  it("does not warn on Brain Bot: each person's routines on it are their own", async () => {
    preview.mockImplementationOnce(async (_userId, _botId, input) => ({
      bot: { id: 'brain', name: 'Brain Bot', visibility: 'workspace', is_default: true },
      routine: { ...input },
      label: 'Weekdays at 09:00 (Asia/Jakarta)',
    }));
    const out = (await proposeCreateRoutine.invoke(args, BOT_TOOL_CONFIG)) as string;
    expect(extractApprovalPayload<BotRoutineApprovalPayload>(out, BOT_ROUTINE_APPROVAL_MARKER)?.shared).toBe(false);
    expect(out).not.toContain('everyone in the workspace will see the routine');
  });

  it("leaves the timezone to the card (the user's browser) when none was named", async () => {
    const out = (await proposeCreateRoutine.invoke({ ...args, timezone: undefined }, BOT_TOOL_CONFIG)) as string;
    expect(preview.mock.calls[0][2].timezone).toBe('UTC');
    expect(extractApprovalPayload<BotRoutineApprovalPayload>(out, BOT_ROUTINE_APPROVAL_MARKER)?.input.timezone).toBe('');
  });

  it('turns a bad schedule or a bot the user cannot edit into a rejection', async () => {
    preview.mockRejectedValueOnce(new BotRoutineValidationError('Invalid time "25:00", expected HH:MM'));
    expect(await proposeCreateRoutine.invoke({ ...args, time: '25:00' }, BOT_TOOL_CONFIG)).toBe(
      'Rejection: Invalid time "25:00", expected HH:MM',
    );
    preview.mockRejectedValueOnce(new BotForbiddenError());
    expect(await proposeCreateRoutine.invoke(args, BOT_TOOL_CONFIG)).toContain('cannot add routines');
  });

  it('refuses to run outside a bot chat', async () => {
    expect(await proposeCreateRoutine.invoke(args, {})).toContain('only runs inside a Copilot bot chat');
  });
});
