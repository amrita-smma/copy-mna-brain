"use client";

import { motion, useReducedMotion } from 'framer-motion';
import type { AvatarState } from '@/lib/bots/avatarState';
import type { BotAvatarConfig } from '@/lib/bots/types';
import { cn } from '@/lib/utils';
import { BotAvatar } from './BotAvatar';

/** Avatar states that mean "this bot is responding": the cloud shows for these. */
const RESPONDING_STATES: ReadonlySet<AvatarState> = new Set(['thinking', 'working', 'talking']);

export function isRespondingState(state: AvatarState): boolean {
  return RESPONDING_STATES.has(state);
}

/** Three dots that rise in turn; still under `prefers-reduced-motion`. */
function ThinkingDots({ dotClassName }: { dotClassName: string }) {
  const reduce = useReducedMotion() ?? false;
  return (
    <span aria-hidden className="flex items-center gap-[3px]">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className={cn('block rounded-full bg-muted-foreground', dotClassName)}
          animate={reduce ? undefined : { y: [0, -2.5, 0], opacity: [0.45, 1, 0.45] }}
          transition={reduce ? undefined : { duration: 1.1, repeat: Infinity, delay: i * 0.18, ease: 'easeInOut' }}
        />
      ))}
    </span>
  );
}

/**
 * A small thought cloud badge for a bot's avatar: the bot is thinking,
 * working or typing. Sits at the avatar's top-right, its tail of two puffs
 * pointing down-left at the avatar. Opaque (`bg-card`), so whatever is behind
 * it never shows through.
 */
export function ThoughtCloud({ className, label }: { className?: string; label?: string }) {
  return (
    <motion.span
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-testid="bot-thought-cloud"
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.6 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      style={{ originX: 0, originY: 1 }}
      className={cn('pointer-events-none absolute z-10 block', className)}
    >
      <span className="flex h-3.5 items-center rounded-full border bg-card px-1.5 shadow-sm">
        <ThinkingDots dotClassName="h-[3px] w-[3px]" />
      </span>
      <span className="absolute -bottom-1 left-0.5 block h-1.5 w-1.5 rounded-full border bg-card" />
      <span className="absolute -bottom-2 -left-0.5 block h-1 w-1 rounded-full border bg-card" />
    </motion.span>
  );
}

const RESPONDING_LABEL: Partial<Record<AvatarState, string>> = {
  thinking: 'Thinking',
  working: 'Working',
  talking: 'Typing',
};

/**
 * The transcript's "responding" row: the bot's avatar with a thought cloud
 * beside it, saying what the bot is doing. Shown where the reply will land,
 * from the moment a message is sent until the answer's text starts, and
 * again whenever the bot goes back to running tools.
 */
export function ThinkingBubble({
  avatar,
  name,
  state,
  label,
  showAvatar = true,
}: {
  avatar?: BotAvatarConfig;
  name?: string;
  state: AvatarState;
  /** Overrides the state's own label (e.g. a background reply to another bot). */
  label?: string;
  /** Off when the message bubble already draws the avatar beside it. */
  showAvatar?: boolean;
}) {
  const text = label ?? RESPONDING_LABEL[state] ?? 'Thinking';
  return (
    <div className="flex items-start gap-2" data-testid="chat-thinking-bubble">
      {showAvatar && avatar && (
        // The same size as the avatar beside a finished answer (`xs`), so the
        // bot does not shrink the moment its first words arrive.
        <span className="mt-1 shrink-0 self-start">
          <BotAvatar avatar={avatar} state={state} size="xs" label={name} trackCursor={false} />
        </span>
      )}
      <motion.div
        initial={{ opacity: 0, scale: 0.85, y: 4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 420, damping: 30 }}
        style={{ originX: 0, originY: 1 }}
        className="relative mb-3 ml-1"
      >
        {/* The tail: two puffs trailing down-left toward the avatar. */}
        <span aria-hidden className="absolute -bottom-1.5 -left-1 block h-2.5 w-2.5 rounded-full border bg-card" />
        <span aria-hidden className="absolute -bottom-3.5 -left-2.5 block h-1.5 w-1.5 rounded-full border bg-card" />
        <div
          role="status"
          aria-live="polite"
          className="relative flex items-center gap-2.5 rounded-[1.25rem] border bg-card px-4 py-2 text-sm text-muted-foreground shadow-sm"
        >
          <ThinkingDots dotClassName="h-1.5 w-1.5" />
          <span>
            {name ? <span className="font-medium text-foreground">{name}</span> : null}
            {name ? ' is ' : ''}
            {name ? text.toLowerCase() : text}
            …
          </span>
        </div>
      </motion.div>
    </div>
  );
}
