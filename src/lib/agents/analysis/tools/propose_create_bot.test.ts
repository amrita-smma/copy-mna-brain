import { beforeEach, describe, expect, it, vi } from 'vitest';

const { previewCreate, validateInput } = vi.hoisted(() => ({ previewCreate: vi.fn(), validateInput: vi.fn() }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({
  createContainer: vi.fn(() => ({ botService: { previewCreate }, botRoutineService: { validateInput } })),
}));

import { MAX_PROPOSED_ROUTINES, proposeCreateBot } from './propose_create_bot';
import { BOT_TOOL_CONFIG } from '@/lib/bots/testing/botFixtures';
import { extractApprovalPayload } from '@/lib/insights/approvalMarker';
import { BOT_CHANGE_APPROVAL_MARKER, type BotChangeApprovalPayload } from '@/lib/bots/approval';
import { BotValidationError } from '@/lib/services/botService';
import { BotRoutineValidationError } from '@/lib/services/botRoutineService';

const morning = {
  title: 'Morning pipeline',
  message: 'Summarise the pipeline.',
  schedule: 'daily' as const,
  time: '08:00',
};

describe('propose_create_bot', () => {
  beforeEach(() => {
    previewCreate.mockReset().mockImplementation((input) => ({
      ...input,
      name: (input.name as string).trim(),
      persona_md: (input.persona_md as string | undefined) ?? '',
      visibility: 'private',
    }));
    validateInput.mockReset().mockImplementation((input) => ({
      routine: { ...input, schedule_spec: { ...input.schedule_spec, normalized: true } },
      label: `Daily at ${(input.schedule_spec as { time: string }).time} (${input.timezone})`,
    }));
  });

  it('proposes a bot from a name, a colour and a shape, blank persona, without creating anything', async () => {
    const out = (await proposeCreateBot.invoke(
      { name: 'Market Watch', color: 'purple', shape: 'orbit' },
      BOT_TOOL_CONFIG,
    )) as string;

    const input = previewCreate.mock.calls[0][0];
    expect(Object.keys(input).sort()).toEqual(['avatar', 'name']);
    expect(input.avatar).toMatchObject({ hue: 280, shape: 'orbit' });
    const payload = extractApprovalPayload<BotChangeApprovalPayload>(out, BOT_CHANGE_APPROVAL_MARKER);
    expect(payload).toMatchObject({ action: 'create', after: { name: 'Market Watch' } });
    expect(payload?.input).toEqual(payload?.after);
    expect(payload?.routines).toBeUndefined();
    expect(validateInput).not.toHaveBeenCalled();
    expect(out).toContain('asks who it is');
  });

  it('carries a persona and the routines the bot starts with, each validated, into the card', async () => {
    const out = (await proposeCreateBot.invoke(
      {
        name: 'Market Watch',
        persona: '  Numbers first. Short answers.  ',
        routines: [morning, { ...morning, title: 'Friday wrap', schedule: 'weekly', weekdays: [5], timezone: 'Asia/Jakarta' }],
      },
      BOT_TOOL_CONFIG,
    )) as string;

    expect(previewCreate.mock.calls[0][0]).toMatchObject({ name: 'Market Watch', persona_md: 'Numbers first. Short answers.' });
    // Validated in UTC when no zone was named; the card fills in the browser's.
    expect(validateInput).toHaveBeenNthCalledWith(1, {
      title: 'Morning pipeline',
      prompt: 'Summarise the pipeline.',
      schedule_kind: 'daily',
      schedule_spec: { time: '08:00' },
      timezone: 'UTC',
    });
    expect(validateInput).toHaveBeenNthCalledWith(2, expect.objectContaining({ schedule_kind: 'weekly', schedule_spec: { time: '08:00', weekdays: [5] }, timezone: 'Asia/Jakarta' }));

    const payload = extractApprovalPayload<BotChangeApprovalPayload>(out, BOT_CHANGE_APPROVAL_MARKER);
    expect(payload?.after.persona_md).toBe('Numbers first. Short answers.');
    expect(payload?.routines).toHaveLength(2);
    expect(payload?.routines?.[0]).toEqual({
      label: 'Daily at 08:00 (UTC)',
      input: {
        title: 'Morning pipeline',
        prompt: 'Summarise the pipeline.',
        schedule_kind: 'daily',
        schedule_spec: { time: '08:00', normalized: true },
        // Blank: the card sends the browser's zone.
        timezone: '',
      },
    });
    expect(payload?.routines?.[1].input.timezone).toBe('Asia/Jakarta');
    expect(out).toContain('with a persona');
    expect(out).toContain('2 routines');
    expect(out).toContain('Morning pipeline: Daily at 08:00 (UTC)');
    expect(out).not.toContain('asks who it is');
  });

  it('ignores skills or sharing passed in anyway', async () => {
    await proposeCreateBot.invoke({ name: 'X', skills: ['research'], shared: true } as never, BOT_TOOL_CONFIG);
    expect(Object.keys(previewCreate.mock.calls[0][0]).sort()).toEqual(['avatar', 'name']);
  });

  it('caps the routines one proposal may set up', async () => {
    // The schema refuses the call before the handler runs.
    await expect(
      proposeCreateBot.invoke(
        { name: 'X', routines: Array.from({ length: MAX_PROPOSED_ROUTINES + 1 }, () => morning) },
        BOT_TOOL_CONFIG,
      ),
    ).rejects.toThrow(/did not match expected schema/);
    expect(previewCreate).not.toHaveBeenCalled();
  });

  it('rejects an unknown colour, a failed bot validation and a failed routine validation in words the model can act on', async () => {
    expect(await proposeCreateBot.invoke({ name: 'X', color: 'plaid' }, BOT_TOOL_CONFIG)).toContain('Unknown colour "plaid"');
    previewCreate.mockImplementationOnce(() => {
      throw new BotValidationError('Name must be at most 60 characters');
    });
    expect(await proposeCreateBot.invoke({ name: 'X' }, BOT_TOOL_CONFIG)).toBe(
      'Rejection: Name must be at most 60 characters',
    );
    validateInput.mockImplementationOnce(() => {
      throw new BotRoutineValidationError('Time must be HH:MM');
    });
    expect(await proposeCreateBot.invoke({ name: 'X', routines: [{ ...morning, time: 'noon' }] }, BOT_TOOL_CONFIG)).toBe(
      'Rejection: Time must be HH:MM',
    );
  });
});
