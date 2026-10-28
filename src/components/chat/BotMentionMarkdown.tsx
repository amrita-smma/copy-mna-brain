'use client';

import { useMemo, type ComponentProps, type ReactNode } from 'react';
import { BotAvatar } from '@/components/bots/BotAvatar';
import type { MentionableBot } from '@/lib/bots/mentions';
import { MarkdownRenderer } from './MarkdownRenderer';
import { useChatActions, useChatThread } from './ChatProvider';

/**
 * A bot @mention in a message, drawn as that bot's chip: its avatar and name,
 * opening its chat (where it answers the mention). Falls back to the text as
 * written if the bot has since gone from the list.
 */
function BotMentionChip({ botId, children }: { botId: string; children?: ReactNode }) {
  const { bots } = useChatThread();
  const { selectBot } = useChatActions();
  const bot = bots.find((b) => b.id === botId);
  if (!bot) return <span>{children}</span>;
  return (
    <button
      type="button"
      onClick={() => selectBot(bot.id)}
      title={`Open ${bot.name}`}
      data-testid="bot-mention-chip"
      className="not-prose mx-0.5 inline-flex items-center gap-1 rounded-full border bg-card py-px pl-px pr-2 align-middle text-xs font-medium leading-5 !text-foreground transition-colors hover:bg-muted [&_*]:!text-foreground"
    >
      <BotAvatar avatar={bot.avatar} size="xs" trackCursor={false} />
      {bot.name}
    </button>
  );
}

/**
 * The bots that @mentions can name, kept at one array identity until a bot's
 * id or name changes: the bot list is replaced several times a turn, and a
 * new array would make every message re-parse its markdown.
 */
function useMentionableBots(): readonly MentionableBot[] {
  const { bots } = useChatThread();
  const key = bots.map((b) => `${b.id}\u0000${b.name}`).join('\u0001');
  // `bots` is read only when `key` changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => bots.map(({ id, name }) => ({ id, name })), [key]);
}

/** `MarkdownRenderer` for a chat message: each bot @mention in it is a chip. */
export function BotMentionMarkdown(props: Omit<ComponentProps<typeof MarkdownRenderer>, 'mentionBots' | 'BotMention'>) {
  const mentionBots = useMentionableBots();
  return <MarkdownRenderer {...props} mentionBots={mentionBots} BotMention={BotMentionChip} />;
}
