"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  deriveAvatarState,
  type AvatarState,
  type ChatStatus,
  type StreamActivity,
} from '@/lib/bots/avatarState';

/*
 * Whether the composer holds unsent text — the avatar's "listening" cue. A
 * tiny module store rather than React context: the composer writes it on every
 * keystroke, and only avatars should re-render for it.
 */
let composerHasText = false;
const listeners = new Set<() => void>();

export function setComposerHasText(value: boolean): void {
  if (composerHasText === value) return;
  composerHasText = value;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** How long the avatar stays "happy" after a turn finishes. */
const HAPPY_MS = 1600;

/**
 * The live avatar state for the transcript's last turn. `status` and
 * `activity` are what `useChatStatus()` publishes, so an avatar re-renders
 * when the turn changes phase, not on every streamed token.
 */
export function useBotAvatarState(status: ChatStatus, activity: StreamActivity): AvatarState {
  const hasText = useSyncExternalStore(subscribe, () => composerHasText, () => false);
  const [justFinished, setJustFinished] = useState(false);
  const prevStatus = useRef(status);

  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = status;
    if (status === 'ready' && (was === 'streaming' || was === 'submitted')) {
      setJustFinished(true);
      const t = setTimeout(() => setJustFinished(false), HAPPY_MS);
      return () => clearTimeout(t);
    }
    if (status !== 'ready') setJustFinished(false);
    return undefined;
  }, [status]);

  return deriveAvatarState({ status, activity, composerHasText: hasText, justFinished });
}
