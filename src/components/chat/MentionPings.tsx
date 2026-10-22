'use client';

import { AtSign } from 'lucide-react';
import { BotAvatar } from '@/components/bots/BotAvatar';
import { findBotMentions } from '@/lib/bots/mentions';
import { cn } from '@/lib/utils';
import { useChatActions, useChatThread } from './ChatProvider';

/**
 * The bots a message @mentions, under the message: each was handed it and
 * answers in its own chat, so a chip opens that chat. Matched against the
 * user's bots with the server's own rule (`findBotMentions`), so the footer
 * names exactly the bots that were pinged; the bot this chat is with is left
 * out.
 */
export function MentionPings({
  text,
  fromUser = false,
  className,
}: {
  text: string;
  /** A user's message pings every bot it names; a bot reply at most three. */
  fromUser?: boolean;
  className?: string;
}) {
  const { bots, activeBot } = useChatThread();
  const { selectBot } = useChatActions();
  const pinged = findBotMentions(text, bots, { excludeId: activeBot?.id, ...(fromUser ? { limit: Infinity } : {}) });
  if (pinged.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)} data-testid="mention-pings">
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <AtSign className="h-3 w-3" />
        Pinged
      </span>
      {pinged.map((bot) => (
        <button
          key={bot.id}
          type="button"
          onClick={() => selectBot(bot.id)}
          title={`Open ${bot.name}: it answers in its own chat`}
          className="inline-flex items-center gap-1.5 rounded-full border bg-card py-0.5 pl-0.5 pr-2.5 text-xs font-medium transition-colors hover:bg-muted"
        >
          <BotAvatar avatar={bot.avatar} size="xs" trackCursor={false} />
          {bot.name}
        </button>
      ))}
    </div>
  );
}
