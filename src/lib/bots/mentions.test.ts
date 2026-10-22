import { describe, it, expect } from 'vitest';
import {
  MAX_MENTION_PINGS,
  filterMentionCandidates,
  findBotMentions,
  isCompletedMention,
  mentionInsertAt,
  mentionQueryAt,
  mentionableBotsContext,
} from './mentions';

const bots = [
  { id: 'deal', name: 'Deal' },
  { id: 'scout', name: 'Deal Scout' },
  { id: 'atlas', name: 'Atlas' },
  { id: 'nova', name: 'Nova' },
  { id: 'orion', name: 'Orion' },
];
const ids = (list: { id: string }[]) => list.map((b) => b.id);

describe('findBotMentions', () => {
  it('matches the longest bot name, case-insensitively', () => {
    expect(ids(findBotMentions('ask @deal scout for targets', bots))).toEqual(['scout']);
    expect(ids(findBotMentions('ask @Deal, then @ATLAS.', bots))).toEqual(['deal', 'atlas']);
  });

  it('needs a word boundary after the name and a non-word character before the @', () => {
    expect(findBotMentions('@Atlassian is a company', bots)).toEqual([]);
    expect(findBotMentions('mail me at nova@atlas.com', bots)).toEqual([]);
    expect(ids(findBotMentions('(@Nova)', bots))).toEqual(['nova']);
  });

  it('matches primary-style names with an apostrophe', () => {
    const primary = [{ id: 'copilot', name: "Nico's bot" }];
    expect(ids(findBotMentions("ask @Nico's bot to summarize", primary))).toEqual(['copilot']);
    expect(ids(findBotMentions("(@Nico's bot)", primary))).toEqual(['copilot']);
  });

  it('lists each bot once, in order of first mention, without the sender', () => {
    expect(ids(findBotMentions('@Nova @Atlas @Nova', bots))).toEqual(['nova', 'atlas']);
    expect(ids(findBotMentions('@Nova @Atlas', bots, { excludeId: 'nova' }))).toEqual(['atlas']);
  });

  it(`pings at most ${MAX_MENTION_PINGS} bots`, () => {
    expect(findBotMentions('@Deal @Atlas @Nova @Orion', bots)).toHaveLength(MAX_MENTION_PINGS);
  });

  it('pings every mentioned bot when the limit is lifted (a user message)', () => {
    expect(findBotMentions('@Deal @Atlas @Nova @Orion', bots, { limit: Infinity })).toHaveLength(4);
  });
});

describe('mentionQueryAt', () => {
  it('returns the partial name after an @ before the caret', () => {
    expect(mentionQueryAt('hi @Dea', 7)).toEqual({ start: 3, query: 'Dea' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQueryAt('hi @Deal Sc', 11)).toEqual({ start: 3, query: 'Deal Sc' });
  });

  it('is null outside a mention: no @, an email, or a new line since the @', () => {
    expect(mentionQueryAt('hello', 5)).toBeNull();
    expect(mentionQueryAt('a@b', 3)).toBeNull();
    expect(mentionQueryAt('@Nova\nnext', 10)).toBeNull();
  });

  it('reads the @ nearest the caret when a message has several mentions', () => {
    const text = '@Nova hi @At';
    expect(mentionQueryAt(text, text.length)).toEqual({ start: 9, query: 'At' });
    expect(mentionQueryAt(text, 5)).toEqual({ start: 0, query: 'Nova' });
  });
});

describe('mentionInsertAt', () => {
  it('matches the picked insert until the text at that offset changes', () => {
    expect(mentionInsertAt('@Deal scout ', 0, 'Deal ')).toBe(true);
    expect(mentionInsertAt('hi @Deal scout ', 3, 'Deal ')).toBe(true);
    expect(mentionInsertAt('@De scout ', 0, 'Deal ')).toBe(false);
  });
});

describe('filterMentionCandidates', () => {
  it('puts names that start with the query before names that contain it', () => {
    expect(ids(filterMentionCandidates(bots, 'o'))).toEqual(['orion', 'scout', 'nova']);
    expect(filterMentionCandidates(bots, '')).toHaveLength(bots.length);
  });
});

describe('isCompletedMention', () => {
  it('treats a full name followed by a space as finished, whatever the case', () => {
    expect(isCompletedMention(bots, 'Atlas ')).toBe(true);
    expect(isCompletedMention(bots, 'deal scout ')).toBe(true);
    expect(isCompletedMention([{ id: 'n', name: "Nico's bot" }], "Nico's bot ")).toBe(true);
  });

  it('keeps a mention open while it is still being typed', () => {
    expect(isCompletedMention(bots, 'Atlas')).toBe(false);
    expect(isCompletedMention(bots, 'Atl ')).toBe(false);
    expect(isCompletedMention(bots, '')).toBe(false);
  });

  it('keeps "@Deal " open while a longer name continues past it', () => {
    expect(isCompletedMention(bots, 'Deal ')).toBe(false);
  });
});

describe('mentionableBotsContext', () => {
  it('names the other bots and how to mention them', () => {
    const note = mentionableBotsContext(bots.slice(0, 3), 'deal');
    expect(note).toContain('Deal Scout, Atlas');
    expect(note).not.toContain('bots: Deal,');
    expect(note).toContain('@Deal Scout');
    expect(note).toContain('first call lookup_bot');
  });

  it('is empty when the bot is the only one', () => {
    expect(mentionableBotsContext([{ id: 'a', name: 'A' }], 'a')).toBe('');
  });
});
