import { describe, it, expect } from 'vitest';
import { botNameList, readBotToolContext, resolveBotRef } from './toolContext';
import type { BotDto } from './types';

const bot = (id: string, name: string) => ({ id, name }) as BotDto;
const bots = [bot('b1', 'Copilot'), bot('b2', 'Deal Scout'), bot('b3', 'Deal Desk')];

describe('readBotToolContext', () => {
  it('reads the user and bot from configurable, never from arguments', () => {
    expect(readBotToolContext({ configurable: { userId: 'u1', botId: 'b1' } })).toEqual({ userId: 'u1', botId: 'b1' });
    expect(readBotToolContext({ configurable: { userId: 'u1' } })).toEqual({ userId: 'u1', botId: null });
  });

  it('is null outside a bot chat', () => {
    expect(readBotToolContext(undefined)).toBeNull();
    expect(readBotToolContext({ configurable: { userEmail: 'a@b.c' } })).toBeNull();
  });
});

describe('resolveBotRef', () => {
  it('matches an id, then an exact name in any case, then a unique partial name', () => {
    expect(resolveBotRef(bots, 'b2')?.name).toBe('Deal Scout');
    expect(resolveBotRef(bots, 'copilot')?.id).toBe('b1');
    expect(resolveBotRef(bots, 'scout')?.id).toBe('b2');
  });

  it('refuses an ambiguous or unknown reference', () => {
    expect(resolveBotRef(bots, 'deal')).toBeNull();
    expect(resolveBotRef(bots, 'nobody')).toBeNull();
    expect(resolveBotRef(bots, '  ')).toBeNull();
  });

  it('lists names for a not-found message', () => {
    expect(botNameList(bots)).toBe('Copilot, Deal Scout, Deal Desk');
    expect(botNameList([])).toBe('none');
  });
});
