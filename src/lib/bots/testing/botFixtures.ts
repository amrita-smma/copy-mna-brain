/** Fixtures shared by the bot tool tests (test-only; not imported by app code). */
import type { BotDto } from '@/lib/bots/types';

export function botDto(over: Partial<BotDto> = {}): BotDto {
  return {
    id: 'scout',
    name: 'Deal Scout',
    persona_md: 'Find deals.',
    avatar: { hue: 152, eyes: 'round', mood: 'calm', shape: 'orbit' },
    visibility: 'workspace',
    is_default: false,
    owner_user_id: 'u1',
    can_edit: true,
    is_owner: true,
    thread_id: 'chat-scout',
    unread: false,
    busy: false,
    pinned: false,
    last_activity_at: null,
    last_message: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

export const BOT_TOOL_CONFIG = { configurable: { userId: 'u1', botId: 'copilot' } };
