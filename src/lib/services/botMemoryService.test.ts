import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BotMemoryService } from './botMemoryService';
import { BotNotFoundError, BotValidationError } from './botService';
import { BOT_MEMORY_MAX_NOTES, type BotMemoryNote } from '@/lib/bots/memoryTypes';

const find = vi.fn();
const update = vi.fn();
const findVisibleRow = vi.fn();

const note = (text: string, created_at = '2026-10-01T00:00:00.000Z') => ({ text, created_at });

/** The repository double: `update` hands the stored notes to the change and keeps its result. */
let stored: BotMemoryNote[];
function makeService() {
  return new BotMemoryService({
    repo: { find, update } as never,
    bots: { findVisibleRow },
    now: () => new Date('2026-10-21T10:00:00.000Z'),
  });
}

beforeEach(() => {
  stored = [];
  find.mockReset().mockImplementation(async () => ({ notes: stored }));
  update.mockReset().mockImplementation(async (_b, _u, change) => {
    const next = change(stored);
    if (next !== null) stored = next;
    return stored;
  });
  findVisibleRow.mockReset().mockResolvedValue({ id: 'b1' });
});

describe('BotMemoryService.list', () => {
  it('returns [] for a bot with no row, and refuses a bot the user cannot see', async () => {
    const service = makeService();
    find.mockResolvedValueOnce(null);
    expect(await service.list('u1', 'b1')).toEqual([]);
    findVisibleRow.mockRejectedValueOnce(new BotNotFoundError());
    await expect(service.list('u1', 'hidden')).rejects.toBeInstanceOf(BotNotFoundError);
    expect(find).toHaveBeenCalledTimes(1);
  });
});

describe('BotMemoryService.remember', () => {
  it('appends new notes with the time, skips ones already there, in one locked rewrite', async () => {
    stored = [note('Answer in Bahasa.')];
    const out = await makeService().remember('u1', 'b1', ['  answer in bahasa ', 'Remind me on Fridays', 'remind me on fridays.']);
    expect(out.added).toEqual([note('Remind me on Fridays', '2026-10-21T10:00:00.000Z')]);
    expect(out.skipped).toEqual(['answer in bahasa', 'remind me on fridays.']);
    expect(out.notes).toHaveLength(2);
    expect(update).toHaveBeenCalledTimes(1);
    expect(findVisibleRow).toHaveBeenCalledWith('u1', 'b1');
  });

  it('leaves the row alone when every note was already there', async () => {
    stored = [note('Call me Nico')];
    const out = await makeService().remember('u1', 'b1', ['call me nico']);
    expect(out.added).toEqual([]);
    // The change returned null: nothing written.
    expect(update.mock.results[0].value).resolves.toEqual([note('Call me Nico')]);
  });

  it('rejects blank, non-text, over-long notes, an empty list, a hidden bot and a full list', async () => {
    const service = makeService();
    await expect(service.remember('u1', 'b1', ['  '])).rejects.toBeInstanceOf(BotValidationError);
    await expect(service.remember('u1', 'b1', [3])).rejects.toBeInstanceOf(BotValidationError);
    await expect(service.remember('u1', 'b1', ['x'.repeat(301)])).rejects.toBeInstanceOf(BotValidationError);
    await expect(service.remember('u1', 'b1', [])).rejects.toBeInstanceOf(BotValidationError);
    expect(update).not.toHaveBeenCalled();
    findVisibleRow.mockRejectedValueOnce(new BotNotFoundError());
    await expect(service.remember('u1', 'hidden', ['x'])).rejects.toBeInstanceOf(BotNotFoundError);
    stored = Array.from({ length: BOT_MEMORY_MAX_NOTES }, (_, i) => note(`n${i}`));
    await expect(service.remember('u1', 'b1', ['one more'])).rejects.toThrow(/at most/);
    expect(stored).toHaveLength(BOT_MEMORY_MAX_NOTES);
  });
});

describe('BotMemoryService.forget', () => {
  it('removes a note by its words only — never by a phrase inside it — and names what it could not find', async () => {
    stored = [note('Remind me on Fridays'), note('Answer in Bahasa')];
    const out = await makeService().forget('u1', 'b1', ['remind me on fridays.', 'fridays', 'Call me Nico']);
    expect(out.removed).toEqual([note('Remind me on Fridays')]);
    expect(out.missing).toEqual(['fridays', 'Call me Nico']);
    expect(out.notes).toEqual([note('Answer in Bahasa')]);
    expect(stored).toEqual([note('Answer in Bahasa')]);
  });

  it('does not write when nothing matched', async () => {
    stored = [note('Answer in Bahasa')];
    const out = await makeService().forget('u1', 'b1', ['nothing like this']);
    expect(out.removed).toEqual([]);
    expect(stored).toEqual([note('Answer in Bahasa')]);
  });
});

describe('BotMemoryService.replace', () => {
  it('keeps the date of a note already there, dates new ones today, drops repeats', async () => {
    stored = [note('Answer in Bahasa')];
    const notes = await makeService().replace('u1', 'b1', ['answer in bahasa', 'Call me Nico', 'call me nico']);
    expect(notes).toEqual([note('Answer in Bahasa'), note('Call me Nico', '2026-10-21T10:00:00.000Z')]);
    expect(stored).toEqual(notes);
  });

  it('rejects a non-list, a list over the cap and a blank entry before touching the row', async () => {
    const service = makeService();
    await expect(service.replace('u1', 'b1', 'x')).rejects.toBeInstanceOf(BotValidationError);
    await expect(service.replace('u1', 'b1', Array.from({ length: BOT_MEMORY_MAX_NOTES + 1 }, () => 'n'))).rejects.toThrow(/at most/);
    await expect(service.replace('u1', 'b1', ['ok', ' '])).rejects.toBeInstanceOf(BotValidationError);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('BotMemoryService.promptContext', () => {
  it('is null with no notes and a bulleted block otherwise, after the visibility check', async () => {
    const service = makeService();
    expect(await service.promptContext('u1', 'b1')).toBeNull();
    stored = [note('Answer in Bahasa'), note('Remind me on Fridays')];
    const block = await service.promptContext('u1', 'b1');
    expect(block).toContain('## What this user asked you to remember');
    expect(block).toContain('- Answer in Bahasa\n- Remind me on Fridays');
    expect(block).toContain('update_bot');
    expect(findVisibleRow).toHaveBeenCalledTimes(2);
    findVisibleRow.mockRejectedValueOnce(new BotNotFoundError());
    await expect(service.promptContext('u1', 'hidden')).rejects.toBeInstanceOf(BotNotFoundError);
  });
});
