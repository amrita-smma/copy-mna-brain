import { apiRequest } from '@/lib/api/client';
import type { BotAvatarConfig, BotDto, BotVisibility } from '@/lib/bots/types';
import type { BotRoutineDto, BotRoutineInput, BotRoutinePatch } from '@/lib/bots/routineTypes';
import type { BotTaskPage } from '@/lib/bots/taskLogTypes';
import type { BotMemoryDto } from '@/lib/bots/memoryTypes';

/** What the bot remembers about the caller: their own notes on it. */
export function getBotMemory(botId: string): Promise<BotMemoryDto> {
  return apiRequest<BotMemoryDto>(`/api/bots/${encodeURIComponent(botId)}/memory`);
}

/** Replace the caller's notes on the bot (the Memory tab). */
export function saveBotMemory(botId: string, notes: string[]): Promise<BotMemoryDto> {
  return apiRequest<BotMemoryDto>(`/api/bots/${encodeURIComponent(botId)}/memory`, {
    method: 'PUT',
    body: JSON.stringify({ notes }),
  });
}

export interface BotInput {
  name?: string;
  /** The user's part of the persona markdown. */
  persona_md?: string;
  base_flavor?: string;
  avatar?: BotAvatarConfig;
  visibility?: BotVisibility;
}

/** The caller's visible bots; the server creates the workspace default bot if missing. */
export function listBots(): Promise<BotDto[]> {
  return apiRequest<BotDto[]>('/api/bots');
}

export function createBot(input: BotInput): Promise<BotDto> {
  return apiRequest<BotDto>('/api/bots', { method: 'POST', body: JSON.stringify(input) });
}

export function updateBot(id: string, input: BotInput): Promise<BotDto> {
  return apiRequest<BotDto>(`/api/bots/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function archiveBot(id: string): Promise<{ id: string }> {
  return apiRequest<{ id: string }>(`/api/bots/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Opens the caller's permanent thread with the bot; returns its chat id. */
export function openBotThread(id: string): Promise<{ chatId: string }> {
  return apiRequest<{ chatId: string }>(`/api/bots/${encodeURIComponent(id)}/thread`, {
    method: 'POST',
  });
}

/**
 * Stop the thread's running turn. A turn keeps running after the browser
 * disconnects, so aborting the request alone no longer stops it.
 */
export function stopChatTurn(chatId: string): Promise<{ stopped: boolean }> {
  return apiRequest<{ stopped: boolean }>(`/api/copilot/chats/${encodeURIComponent(chatId)}/stop`, {
    method: 'POST',
  });
}

/** Clear the bot's unread dot: the user has seen their thread with it. */
export function markBotUnread(id: string): Promise<{ id: string }> {
  return apiRequest<{ id: string }>(`/api/bots/${encodeURIComponent(id)}/read`, { method: 'DELETE' });
}

export function markBotRead(id: string): Promise<{ id: string }> {
  return apiRequest<{ id: string }>(`/api/bots/${encodeURIComponent(id)}/read`, { method: 'POST' });
}

/** Save the caller's pinned bots, in order; returns the list in its new order. */
export function savePinnedBots(botIds: string[]): Promise<BotDto[]> {
  return apiRequest<BotDto[]>('/api/bots/pins', {
    method: 'PUT',
    body: JSON.stringify({ bot_ids: botIds }),
  });
}

/** The bot's routines: its owner's for a private bot, everyone's for a shared one. */
export function listBotRoutines(botId: string): Promise<BotRoutineDto[]> {
  return apiRequest<BotRoutineDto[]>(`/api/bots/${encodeURIComponent(botId)}/routines`);
}

/** Schedule a routine on the bot; it runs as the caller. */
export function createBotRoutine(botId: string, input: BotRoutineInput): Promise<BotRoutineDto> {
  return apiRequest<BotRoutineDto>(`/api/bots/${encodeURIComponent(botId)}/routines`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateBotRoutine(botId: string, id: string, patch: BotRoutinePatch): Promise<BotRoutineDto> {
  return apiRequest<BotRoutineDto>(
    `/api/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
}

export function deleteBotRoutine(botId: string, id: string): Promise<{ id: string }> {
  return apiRequest<{ id: string }>(
    `/api/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}

/** Send the routine's message now, as the caller, in their chat with the bot. */
export function runBotRoutine(botId: string, id: string): Promise<{ id: string }> {
  return apiRequest<{ id: string }>(
    `/api/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(id)}/run`,
    { method: 'POST' },
  );
}

/** A page of the bot's task log, newest first; pass `nextCursor` as `before` for older tasks. */
export function listBotTasks(botId: string, before?: string | null): Promise<BotTaskPage> {
  const query = before ? `?before=${encodeURIComponent(before)}` : '';
  return apiRequest<BotTaskPage>(`/api/bots/${encodeURIComponent(botId)}/tasks${query}`);
}
