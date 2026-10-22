import { describe, it, expect } from 'vitest';
import { mergeKeptUnread } from './keptUnread';
import type { BotDto } from '@/lib/bots/types';

function bot(id: string, unread: boolean): BotDto {
  return {
    id,
    name: id,
    persona_md: '',
    avatar: { shape: 'nova', eyes: 'round', mood: 'calm', hue: 0 },
    visibility: 'private',
    is_default: false,
    owner_user_id: 'u1',
    thread_id: null,
    can_edit: true,
    is_owner: true,
    unread,
    pinned: false,
    busy: false,
    last_activity_at: '2026-01-01T00:00:00Z',
    last_message: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

describe('mergeKeptUnread', () => {
  it('forces unread true for ids in kept', () => {
    const kept = new Set(['a']);
    expect(mergeKeptUnread([bot('a', false)], kept)).toEqual([bot('a', true)]);
    expect(kept.has('a')).toBe(true);
  });

  it('drops kept once the server already shows unread', () => {
    const kept = new Set(['a']);
    expect(mergeKeptUnread([bot('a', true)], kept)).toEqual([bot('a', true)]);
    expect(kept.has('a')).toBe(false);
  });

  it('leaves other bots unchanged', () => {
    const kept = new Set(['a']);
    expect(mergeKeptUnread([bot('b', false)], kept)).toEqual([bot('b', false)]);
  });
});
