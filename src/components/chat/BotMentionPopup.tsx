'use client';

import { useRef } from 'react';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { BotAvatar } from '@/components/bots/BotAvatar';
import type { BotDto } from '@/lib/bots/types';

interface BotMentionPopupProps {
  open: boolean;
  /** The bots matching what follows the `@`, already filtered. */
  bots: BotDto[];
  highlightedIndex: number;
  onHighlightChange: (index: number) => void;
  onSelect: (bot: BotDto) => void;
  onDismiss: () => void;
  /** The composer row this popup is anchored below. */
  children: React.ReactNode;
}

/**
 * The composer's `@` autocomplete: the user's other bots. Picking one writes
 * `@Name` into the message; when it is sent, that bot gets the message too and
 * answers in its own chat. Presentational, like `InsightTemplatePopup`: the
 * query, the filtering and the keyboard handling live in `ChatInput`.
 */
export function BotMentionPopup({
  open,
  bots,
  highlightedIndex,
  onHighlightChange,
  onSelect,
  onDismiss,
  children,
}: BotMentionPopupProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <PopoverAnchor asChild>
        <div ref={anchorRef}>{children}</div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        className="w-64 overflow-hidden p-0"
        data-testid="bot-mention-popup"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          // Typing in the composer is not a dismissal.
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
      >
        <Command
          shouldFilter={false}
          value={bots[highlightedIndex]?.id}
          onValueChange={(value) => {
            const idx = bots.findIndex((b) => b.id === value);
            if (idx !== -1) onHighlightChange(idx);
          }}
        >
          <CommandList className="max-h-64">
            <CommandGroup heading="Mention a bot">
              {bots.map((bot) => (
                <CommandItem key={bot.id} value={bot.id} onSelect={() => onSelect(bot)} className="gap-2">
                  <BotAvatar avatar={bot.avatar} size="xs" trackCursor={false} />
                  <span className="truncate">{bot.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          <p className="border-t px-2 py-1.5 text-[11px] text-muted-foreground">
            It gets your message and answers in its own chat.
          </p>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
