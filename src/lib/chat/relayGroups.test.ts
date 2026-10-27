import { describe, it, expect } from 'vitest';
import { groupRelayMessages, relayLabel, relaySender, relaySenders } from './relayGroups';
import type { FromBot } from './uiMessages';

const scout = { id: 'scout', name: 'Deal Scout', kind: 'bot_reply' as const };
const watch = { id: 'watch', name: 'Market Watch', kind: 'bot_reply' as const };
const mention = { id: 'scout', name: 'Deal Scout', kind: 'bot' as const };

const user = (id: string) => ({ id, role: 'user' });
const assistant = (id: string) => ({ id, role: 'assistant' });
const relay = (id: string, fromBot: FromBot) => ({ id, role: 'user', metadata: { fromBot } });

describe('relaySender', () => {
  it('is another bot’s reply or hand-off, never the user’s own words', () => {
    expect(relaySender(relay('r1', scout))).toEqual(scout);
    expect(relaySender(relay('r2', mention))).toEqual(mention);
    expect(relaySender(user('u1'))).toBeNull();
    expect(relaySender(assistant('a1'))).toBeNull();
    expect(relaySender({ id: 'u2', role: 'user', metadata: { fromBot: { id: 'x', name: 'X', kind: 'user_mention' } } })).toBeNull();
  });
});

describe('groupRelayMessages', () => {
  it('folds a run of other bots’ messages into one item and keeps everything else in place', () => {
    const items = groupRelayMessages([user('u1'), assistant('a1'), relay('r1', scout), relay('r2', watch), assistant('a2')]);

    expect(items.map((i) => i.kind)).toEqual(['message', 'message', 'relay', 'message']);
    const group = items[2];
    if (group.kind !== 'relay') throw new Error('expected a relay group');
    expect(group.id).toBe('r1');
    expect(group.messages.map((m) => m.id)).toEqual(['r1', 'r2']);
    expect(group.senders.map((s) => s.name)).toEqual(['Deal Scout', 'Market Watch']);
    expect(group.label).toBe('Reply from Deal Scout and 1 other');
    expect(group.lastIndex).toBe(3);
    expect(items[3]).toMatchObject({ kind: 'message', index: 4 });
  });

  it('keeps separate runs separate and counts the same bot once in the row', () => {
    const items = groupRelayMessages([relay('r1', scout), assistant('a1'), relay('r2', scout), relay('r3', scout)]);
    expect(items.map((i) => i.kind)).toEqual(['relay', 'message', 'relay']);
    const second = items[2];
    if (second.kind !== 'relay') throw new Error('expected a relay group');
    expect(second.senders).toHaveLength(1);
    expect(second.label).toBe('Replies from Deal Scout');
    expect(second.lastIndex).toBe(3);
  });

  it('indexes a leading group and a trailing message correctly', () => {
    const items = groupRelayMessages([relay('r1', scout), user('u1')]);
    expect(items[0]).toMatchObject({ kind: 'relay', lastIndex: 0 });
    expect(items[1]).toMatchObject({ kind: 'message', index: 1 });
  });
});

describe('fan-in replies', () => {
  const fanIn = { ...scout, others: [{ id: 'watch', name: 'Market Watch' }, { id: 'crm', name: 'CRM Concierge' }] };

  it('credits every bot one fan-in reply carries, with an avatar each', () => {
    const items = groupRelayMessages([assistant('a1'), relay('r1', fanIn)]);
    const group = items[1];
    if (group.kind !== 'relay') throw new Error('expected a relay group');
    expect(group.senders.map((s) => s.id)).toEqual(['scout', 'watch', 'crm']);
    expect(group.label).toBe('Reply from Deal Scout and 2 others');
  });

  it('merges a fan-in reply with a neighbouring reply from one of the same bots', () => {
    const items = groupRelayMessages([relay('r1', fanIn), relay('r2', watch)]);
    const group = items[0];
    if (group.kind !== 'relay') throw new Error('expected a relay group');
    expect(group.senders.map((s) => s.id)).toEqual(['scout', 'watch', 'crm']);
    expect(group.label).toBe('Reply from Deal Scout and 2 others');
  });

  it('lists the sender alone when it carries no others', () => {
    expect(relaySenders(scout)).toEqual([scout]);
    expect(relaySenders({ ...scout, others: [{ id: 'scout', name: 'Deal Scout' }] }).map((s) => s.id)).toEqual(['scout']);
  });
});

describe('relayLabel', () => {
  it('names the senders and what they did', () => {
    expect(relayLabel([{ fromBot: scout }])).toBe('Reply from Deal Scout');
    expect(relayLabel([{ fromBot: scout }, { fromBot: scout }])).toBe('Replies from Deal Scout');
    expect(relayLabel([{ fromBot: mention }])).toBe('Deal Scout mentioned this bot');
    expect(relayLabel([{ fromBot: mention }, { fromBot: watch }])).toBe('2 messages from Deal Scout and 1 other');
  });

  it('names the first of several bots and counts the rest', () => {
    expect(relayLabel([{ fromBot: scout }, { fromBot: watch }])).toBe('Reply from Deal Scout and 1 other');
    expect(relayLabel([{ fromBot: scout }, { fromBot: watch }, { fromBot: { id: 'c', name: 'CRM Concierge', kind: 'bot_reply' } }])).toBe(
      'Reply from Deal Scout and 2 others',
    );
  });
});
