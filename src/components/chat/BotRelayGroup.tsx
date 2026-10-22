'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { UIMessage } from 'ai';
import { BotAvatar } from '@/components/bots/BotAvatar';
import type { FromBot } from '@/lib/chat/uiMessages';
import { cn } from '@/lib/utils';
import { ChatMessageBubble } from './ChatMessageBubble';
import { useChatThread } from './ChatProvider';

/**
 * A run of other bots' messages in the transcript — their replies back, or
 * their hand-offs to this bot — folded into one row: the senders' avatars
 * side by side and a one-line label, collapsed by default. The bot relays
 * what matters from them in its own answer, so showing them open would
 * repeat it; the row opens to the messages themselves on a click.
 */
export function BotRelayGroup({
  messages,
  senders,
  label,
}: {
  messages: UIMessage[];
  /** Each sender once, in order of first message. */
  senders: FromBot[];
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const { bots } = useChatThread();
  const avatarOf = (id: string) => bots.find((b) => b.id === id)?.avatar;

  return (
    <div className="mb-3 min-w-0" data-testid="bot-relay-group" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${label}: ${open ? 'hide' : 'show'} ${messages.length === 1 ? 'the message' : `the ${messages.length} messages`}`}
        className="group flex w-full items-center gap-2 rounded-xl px-1 py-1 text-left transition-colors hover:bg-muted"
        data-testid="bot-relay-toggle"
      >
        <span className="flex shrink-0 items-center">
          {senders.map((sender, i) => (
            <span
              key={sender.id}
              className={cn('rounded-full ring-2 ring-background', i > 0 && '-ml-2')}
              title={sender.name}
            >
              <BotAvatar avatar={avatarOf(sender.id)} size="xs" trackCursor={false} />
            </span>
          ))}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">{label}</span>
        <ChevronDown
          aria-hidden
          className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2 border-l-2 border-muted pl-2" data-testid="bot-relay-messages">
          {messages.map((message) => (
            <ChatMessageBubble key={message.id} message={message} />
          ))}
        </div>
      )}
    </div>
  );
}
