import { beforeEach, describe, expect, it, vi } from 'vitest';

const { list, previewUpdate, update, remember, forget } = vi.hoisted(() => ({
  list: vi.fn(),
  previewUpdate: vi.fn(),
  update: vi.fn(),
  remember: vi.fn(),
  forget: vi.fn(),
}));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({
  createContainer: vi.fn(() => ({
    botService: { list, previewUpdate, update },
    botMemoryService: { remember, forget },
  })),
}));

import { MAX_NOTES_PER_CALL, updateBot } from './update_bot';
import { BOT_TOOL_CONFIG, botDto } from '@/lib/bots/testing/botFixtures';
import { extractApprovalPayload } from '@/lib/insights/approvalMarker';
import { BOT_CHANGE_APPROVAL_MARKER, type BotChangeApprovalPayload } from '@/lib/bots/approval';
import { BotValidationError } from '@/lib/services/botService';

const fields = (over = {}) => ({
  name: 'Deal Scout',
  avatar: { hue: 152, eyes: 'round', mood: 'calm', shape: 'orbit' },
  persona_md: 'Find deals.',
  visibility: 'workspace',
  ...over,
});

const note = (text: string) => ({ text, created_at: '2026-10-21T10:00:00.000Z' });

describe('update_bot', () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue([
      botDto(),
      botDto({ id: 'mine', name: 'My Notes', visibility: 'private', persona_md: 'Keep notes.' }),
      botDto({ id: 'copilot', name: 'Copilot', can_edit: false, is_default: true }),
    ]);
    previewUpdate.mockReset();
    update.mockReset().mockResolvedValue({});
    remember.mockReset().mockImplementation(async (_u, _b, texts: string[]) => ({
      notes: texts.map(note),
      added: texts.map(note),
      skipped: [],
    }));
    forget.mockReset().mockResolvedValue({ notes: [], removed: [], missing: [] });
  });

  it('writes a private bot\'s persona at once, with no card', async () => {
    previewUpdate.mockResolvedValue({
      before: fields({ visibility: 'private', persona_md: 'Keep notes.' }),
      after: fields({ visibility: 'private', persona_md: 'Keep notes.\n\nAlso track follow-ups.' }),
      changed: ['persona_md'],
    });

    const out = (await updateBot.invoke({ bot: 'My Notes', persona_append: 'Also track follow-ups.' }, BOT_TOOL_CONFIG)) as string;

    expect(previewUpdate).toHaveBeenCalledWith('u1', 'mine', { persona_md: 'Keep notes.\n\nAlso track follow-ups.' });
    expect(update).toHaveBeenCalledWith('u1', 'mine', { persona_md: 'Keep notes.\n\nAlso track follow-ups.' });
    expect(out).toContain('Updated **My Notes** (persona)');
    expect(out).not.toContain(BOT_CHANGE_APPROVAL_MARKER);
  });

  it('puts a shared bot\'s persona change on a card with a warning, and writes nothing', async () => {
    previewUpdate.mockResolvedValue({ before: fields(), after: fields({ persona_md: 'Find fintech deals.' }), changed: ['persona_md'] });

    const out = (await updateBot.invoke({ bot: 'deal scout', persona: 'Find fintech deals.' }, BOT_TOOL_CONFIG)) as string;

    expect(update).not.toHaveBeenCalled();
    const payload = extractApprovalPayload<BotChangeApprovalPayload>(out, BOT_CHANGE_APPROVAL_MARKER);
    expect(payload).toMatchObject({ action: 'update', bot_id: 'scout', input: { persona_md: 'Find fintech deals.' } });
    expect(payload?.warning).toMatch(/shared with the workspace/);
    expect(out).toContain('confirm on a card');
  });

  it('warns when one call shares a private bot and sets its persona: the persona is for everyone', async () => {
    previewUpdate.mockResolvedValue({
      before: fields({ visibility: 'private', persona_md: 'Keep notes.' }),
      after: fields({ visibility: 'workspace', persona_md: 'Notes for all.' }),
      changed: ['visibility', 'persona_md'],
    });

    const out = (await updateBot.invoke({ bot: 'My Notes', shared: true, persona: 'Notes for all.' }, BOT_TOOL_CONFIG)) as string;

    expect(update).not.toHaveBeenCalled();
    const payload = extractApprovalPayload<BotChangeApprovalPayload>(out, BOT_CHANGE_APPROVAL_MARKER);
    expect(payload?.warning).toMatch(/shared with the workspace/);
  });

  it('renames or recolours a private bot at once, sending only the changed fields', async () => {
    const avatar = { hue: 0, eyes: 'round', mood: 'calm', shape: 'orbit' };
    previewUpdate.mockResolvedValue({
      before: fields({ visibility: 'private', persona_md: 'Keep notes.' }),
      after: fields({ visibility: 'private', persona_md: 'Keep notes.', name: 'Notes', avatar }),
      changed: ['name', 'avatar'],
    });

    const out = (await updateBot.invoke({ bot: 'My Notes', name: 'Notes', color: 'red' }, BOT_TOOL_CONFIG)) as string;

    expect(previewUpdate).toHaveBeenCalledWith('u1', 'mine', { name: 'Notes', avatar });
    expect(update).toHaveBeenCalledWith('u1', 'mine', { name: 'Notes', avatar });
    expect(out).toBe('Updated **My Notes** (name → "Notes", look); it applies from its next reply.');
    expect(out).not.toContain(BOT_CHANGE_APPROVAL_MARKER);
  });

  it("puts a shared bot's rename or recolour on the same warning card as its persona, with only the changed fields", async () => {
    previewUpdate.mockResolvedValue({
      before: fields(),
      after: fields({ name: 'Scout', avatar: { hue: 0, eyes: 'round', mood: 'calm', shape: 'orbit' } }),
      changed: ['name', 'avatar'],
    });

    const out = (await updateBot.invoke({ bot: 'deal scout', name: 'Scout', color: 'red' }, BOT_TOOL_CONFIG)) as string;

    const payload = extractApprovalPayload<BotChangeApprovalPayload>(out, BOT_CHANGE_APPROVAL_MARKER);
    expect(Object.keys(payload!.input)).toEqual(['name', 'avatar']);
    expect(payload?.warning).toBe(
      'Deal Scout is shared with the workspace: this changes it for everyone who uses it (name → "Scout", look), not just for you. Confirm to apply the change below.',
    );
    expect(out).toContain('confirm on a card, because the bot is shared');
    expect(update).not.toHaveBeenCalled();
  });

  it('always confirms sharing a private bot, and making a shared bot private, on the card', async () => {
    previewUpdate.mockResolvedValueOnce({
      before: fields({ visibility: 'private', persona_md: 'Keep notes.' }),
      after: fields({ visibility: 'workspace', persona_md: 'Keep notes.' }),
      changed: ['visibility'],
    });
    let out = (await updateBot.invoke({ bot: 'My Notes', shared: true }, BOT_TOOL_CONFIG)) as string;
    expect(extractApprovalPayload<BotChangeApprovalPayload>(out, BOT_CHANGE_APPROVAL_MARKER)?.warning).toBe(
      'My Notes will be shared with the workspace: everyone gets it as it is below (shared with the workspace), not just you. Confirm to share it.',
    );
    expect(out).toContain('because the bot would become shared');

    previewUpdate.mockResolvedValueOnce({ before: fields(), after: fields({ visibility: 'private' }), changed: ['visibility'] });
    out = (await updateBot.invoke({ bot: 'deal scout', shared: false }, BOT_TOOL_CONFIG)) as string;
    expect(extractApprovalPayload<BotChangeApprovalPayload>(out, BOT_CHANGE_APPROVAL_MARKER)?.warning).toBe(
      'Deal Scout is shared with the workspace: this changes it for everyone who uses it (made private), not just for you. Confirm to apply the change below.',
    );
    expect(out).toContain('because the bot is shared');
    expect(update).not.toHaveBeenCalled();
  });

  it('remembers notes for the user at once, on the current bot when none is named, and touches no persona', async () => {
    remember.mockResolvedValueOnce({ notes: [], added: [note('Answer in Bahasa')], skipped: ['Call me Nico'] });

    const out = (await updateBot.invoke(
      { remember: ['Answer in Bahasa', 'Call me Nico'] },
      { configurable: { userId: 'u1', botId: 'scout' } },
    )) as string;

    expect(remember).toHaveBeenCalledWith('u1', 'scout', ['Answer in Bahasa', 'Call me Nico']);
    expect(out).toContain('Remembered for this user on **Deal Scout**: "Answer in Bahasa".');
    expect(out).toContain('Already noted on **Deal Scout**: "Call me Nico".');
    expect(previewUpdate).not.toHaveBeenCalled();
    expect(out).not.toContain(BOT_CHANGE_APPROVAL_MARKER);
  });

  it('remembers a note and renames a private bot in one call: both apply, memory first, no card', async () => {
    previewUpdate.mockResolvedValueOnce({
      before: fields({ visibility: 'private', persona_md: 'Keep notes.' }),
      after: fields({ visibility: 'private', persona_md: 'Keep notes.', name: 'Notes' }),
      changed: ['name'],
    });

    const out = (await updateBot.invoke({ bot: 'My Notes', remember: ['Call me Nico'], name: 'Notes' }, BOT_TOOL_CONFIG)) as string;

    expect(remember).toHaveBeenCalledWith('u1', 'mine', ['Call me Nico']);
    expect(update).toHaveBeenCalledWith('u1', 'mine', { name: 'Notes' });
    expect(remember.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]!);
    expect(out).toBe(
      'Remembered for this user on **My Notes**: "Call me Nico".\nUpdated **My Notes** (name → "Notes"); it applies from its next reply.',
    );
    expect(out).not.toContain(BOT_CHANGE_APPROVAL_MARKER);
  });

  it('forgets notes and names the ones it could not find', async () => {
    forget.mockResolvedValueOnce({ notes: [], removed: [note('Remind me on Fridays')], missing: ['Call me Nico'] });
    const out = (await updateBot.invoke({ bot: 'scout', forget: ['Remind me on Fridays', 'Call me Nico'] }, BOT_TOOL_CONFIG)) as string;
    expect(forget).toHaveBeenCalledWith('u1', 'scout', ['Remind me on Fridays', 'Call me Nico']);
    expect(out).toContain('Forgot on **Deal Scout**: "Remind me on Fridays".');
    expect(out).toContain('No note on **Deal Scout** about: "Call me Nico".');
  });

  it('keeps notes for the user on a bot they cannot edit, but refuses the bot change', async () => {
    const out = (await updateBot.invoke({ bot: 'Copilot', remember: ['Call me Nico'], name: 'X' }, BOT_TOOL_CONFIG)) as string;
    expect(remember).toHaveBeenCalledWith('u1', 'copilot', ['Call me Nico']);
    expect(out).toContain('Remembered for this user on **Copilot**');
    expect(out).toContain('the primary bot is fixed');
    expect(previewUpdate).not.toHaveBeenCalled();
  });

  it('refuses a bot it cannot identify, a self change outside a bot chat, and an empty call', async () => {
    expect(await updateBot.invoke({ bot: 'nobody', name: 'X' }, BOT_TOOL_CONFIG)).toContain('The bots are: Deal Scout, My Notes, Copilot');
    expect(await updateBot.invoke({ persona: 'x' }, { configurable: { userId: 'u1' } })).toContain('name the bot to change');
    expect(await updateBot.invoke({ bot: 'scout' }, BOT_TOOL_CONFIG)).toContain('Nothing to change: pass a persona');
    expect(previewUpdate).not.toHaveBeenCalled();
  });

  it('says when nothing would change, and relays a validation error as a rejection', async () => {
    previewUpdate.mockResolvedValueOnce({ before: fields(), after: fields(), changed: [] });
    expect(await updateBot.invoke({ bot: 'scout', name: 'Deal Scout' }, BOT_TOOL_CONFIG)).toContain('Nothing to change on **Deal Scout**');
    remember.mockRejectedValueOnce(new BotValidationError('A note cannot be blank'));
    expect(await updateBot.invoke({ bot: 'scout', remember: ['x'] }, BOT_TOOL_CONFIG)).toBe('Rejection: A note cannot be blank');
  });

  it('caps the notes one call may remember', async () => {
    await expect(
      updateBot.invoke({ bot: 'scout', remember: Array.from({ length: MAX_NOTES_PER_CALL + 1 }, () => 'n') }, BOT_TOOL_CONFIG),
    ).rejects.toThrow(/did not match expected schema/);
    expect(remember).not.toHaveBeenCalled();
  });
});
