'use client';

import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BotAvatar } from '@/components/bots/BotAvatar';
import { useChatActions } from '@/components/chat/ChatProvider';
import type { BotMessagePayload } from '@/lib/bots/approval';
import { cn } from '@/lib/utils';

/**
 * Shows that this bot messaged another one with the retired message_bot tool;
 * still rendered for history from before @mentions. The other bot answered in
 * the user's chat with it, so the card links there.
 */
export function BotMessageCard({ payload, className }: { payload: BotMessagePayload; className?: string }) {
  const { selectBot } = useChatActions();
  return (
    <div
      data-testid="bot-message-card"
      className={cn('w-full rounded-2xl border bg-card p-4 shadow-sm', className)}
    >
      <div className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-400">
        <Send className="h-3.5 w-3.5" />
        Sent to {payload.name}
      </div>
      <div className="flex items-start gap-3">
        <BotAvatar avatar={payload.avatar} size="sm" label={payload.name} trackCursor={false} />
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm text-foreground">{payload.message}</p>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{payload.name} will reply in its own chat.</p>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 text-xs"
          onClick={() => selectBot(payload.bot_id)}
          data-testid="bot-message-open"
        >
          Open {payload.name}
        </Button>
      </div>
    </div>
  );
}
