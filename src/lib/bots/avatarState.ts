/**
 * What a bot's avatar is doing, derived from state `useChat` already exposes
 * (RFC 02 §4). Pure and client-safe so it can be unit-tested and shared by
 * every place an avatar is drawn.
 */

export const AVATAR_STATES = [
  'idle',
  'listening',
  'thinking',
  'working',
  'talking',
  // Reserved: a workflow paused for human approval (durable runtime, RFC Phase 1).
  'waiting',
  // Reserved: an ask_bot call in progress (bot-to-bot, RFC Phase 5).
  'handoff',
  'happy',
  'error',
] as const;
export type AvatarState = (typeof AVATAR_STATES)[number];

/** `useChat`'s status. */
export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error';

/** The subset of a UIMessage part this reads. */
export interface AvatarPart {
  type: string;
  state?: string;
}

/**
 * What a streaming turn is doing right now, read off the last assistant
 * message's parts. A string so a context can publish it and change only when
 * the activity changes, not on every token (`useChatStatus().activity`).
 */
export type StreamActivity = 'thinking' | 'working' | 'talking';

export interface AvatarStateInput {
  status: ChatStatus;
  /** The parts of the last assistant message, when the last message is the assistant's. */
  lastAssistantParts?: readonly AvatarPart[] | null;
  /** Already-derived activity (`streamActivity`), used instead of the parts when given. */
  activity?: StreamActivity | null;
  /** The composer holds text the user has not sent. */
  composerHasText?: boolean;
  /** A turn just finished successfully (the caller clears this after a moment). */
  justFinished?: boolean;
}

function isToolPart(part: AvatarPart): boolean {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-');
}

function toolRunning(part: AvatarPart): boolean {
  return isToolPart(part) && part.state !== 'output-available' && part.state !== 'output-error';
}

/**
 * The activity of a streaming turn: working while any tool part has no
 * output yet, talking while the last part is text, thinking otherwise.
 */
export function streamActivity(lastAssistantParts?: readonly AvatarPart[] | null): StreamActivity {
  const parts = lastAssistantParts ?? [];
  if (parts.some(toolRunning)) return 'working';
  const last = parts[parts.length - 1];
  if (!last) return 'thinking';
  if (last.type === 'reasoning' && last.state !== 'done') return 'thinking';
  if (last.type === 'text') return 'talking';
  return 'thinking';
}

export function deriveAvatarState({
  status,
  lastAssistantParts,
  activity,
  composerHasText = false,
  justFinished = false,
}: AvatarStateInput): AvatarState {
  if (status === 'error') return 'error';

  if (status === 'submitted') return 'thinking';

  if (status === 'streaming') return activity ?? streamActivity(lastAssistantParts);

  if (justFinished) return 'happy';
  if (composerHasText) return 'listening';
  return 'idle';
}
