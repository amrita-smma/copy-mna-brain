"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Reorder, useDragControls } from 'framer-motion';
import { GripVertical, Pin } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { moveId } from '@/lib/bots/order';
import type { BotDto } from '@/lib/bots/types';
import { cn } from '@/lib/utils';
import { BotAvatar } from './BotAvatar';
import { PrimaryStar } from './PrimaryStar';
import { ThoughtCloud } from './ThoughtCloud';
import { UnreadDot } from './UnreadDot';
import { useBotPinning } from './useBotPinning';

interface AllBotsMenuProps {
  bots: BotDto[];
  activeBotId: string | null;
  onSelect: (id: string) => void;
  /** The button that opens the menu (the strip's tile, the sidebar's row). */
  trigger: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}

/**
 * "All bots": the overflow of a bot list (the Copilot strip, the sidebar). A
 * large dropdown listing every bot in list order — pinned first, then newest
 * activity. Pick one to open its chat; drag a row by its handle (or focus the
 * handle and use the arrow keys) to pin it there; the pin button pins or
 * unpins. Brain Bot heads the menu on its own and is never moved or pinned.
 */
export function AllBotsMenu({ bots, activeBotId, onSelect, trigger, side, align = 'start' }: AllBotsMenuProps) {
  const [open, setOpen] = useState(false);
  const { moveBot, togglePinned } = useBotPinning();
  // The order while a row is being dragged (state to render, a ref to read on
  // drop) and the row being dragged; committed on drop.
  const [dragIds, setDragIds] = useState<string[] | null>(null);
  const dragRef = useRef<{ ids: string[]; movedId: string } | null>(null);
  const primary = bots.find((b) => b.is_default) ?? null;
  const orderable = bots.filter((b) => !b.is_default);
  const byId = new Map(orderable.map((b) => [b.id, b]));
  const rows = dragIds ? dragIds.map((id) => byId.get(id)).filter((b): b is BotDto => !!b) : orderable;
  const firstUnpinned = rows.findIndex((b) => !b.pinned);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        className="flex max-h-[min(70vh,36rem)] w-[min(26rem,calc(100vw-2rem))] flex-col p-0"
        data-testid="copilot-all-bots"
      >
        <div className="border-b px-4 py-3">
          <p className="text-sm font-semibold">All bots</p>
          <p className="text-xs text-muted-foreground">
            Pinned bots stay on top in your order; the rest follow the latest activity. Drag a
            handle to pin a bot where you drop it.
          </p>
        </div>
        {primary && (
          <div className="px-2 pt-2">
            <PrimaryRow
              bot={primary}
              active={primary.id === activeBotId}
              onPick={() => {
                setOpen(false);
                if (primary.id !== activeBotId) onSelect(primary.id);
              }}
            />
          </div>
        )}
        <Reorder.Group
          as="ol"
          axis="y"
          values={rows.map((b) => b.id)}
          onReorder={(ids: string[]) => {
            if (dragRef.current) dragRef.current.ids = ids;
            setDragIds(ids);
          }}
          className="min-h-0 flex-1 overflow-y-auto p-2"
          aria-label="Bots, in order"
        >
          {rows.map((bot, index) => (
            <BotRow
              key={bot.id}
              bot={bot}
              index={index}
              count={rows.length}
              active={bot.id === activeBotId}
              heading={
                // Section labels, hidden mid-drag: the split moves as rows do.
                dragIds
                  ? undefined
                  : index === 0 && bot.pinned
                    ? 'Pinned'
                    : index === firstUnpinned
                      ? 'Recent'
                      : undefined
              }
              onDragStart={() => {
                const ids = orderable.map((b) => b.id);
                dragRef.current = { ids, movedId: bot.id };
                setDragIds(ids);
              }}
              onDragEnd={() => {
                const drag = dragRef.current;
                dragRef.current = null;
                setDragIds(null);
                if (drag && drag.ids.join(',') !== orderable.map((b) => b.id).join(',')) {
                  moveBot(drag.ids, drag.movedId);
                }
              }}
              onMove={(delta) => {
                // The live order, so a key press mid-drag moves from where the row is.
                const ids = rows.map((b) => b.id);
                const next = moveId(ids, index, index + delta);
                if (dragIds) {
                  dragRef.current = dragRef.current ? { ...dragRef.current, ids: next } : null;
                  setDragIds(next);
                }
                moveBot(next, bot.id);
              }}
              onTogglePin={() => togglePinned(bot.id)}
              onPick={() => {
                setOpen(false);
                if (bot.id !== activeBotId) onSelect(bot.id);
              }}
            />
          ))}
        </Reorder.Group>
      </PopoverContent>
    </Popover>
  );
}

/** Brain Bot's row: no handle and no pin, since it always leads. */
function PrimaryRow({ bot, active, onPick }: { bot: BotDto; active: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg py-1.5 pl-9 pr-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
        active && 'bg-muted ring-1 ring-border',
      )}
      data-testid={`copilot-all-bots-row-${bot.id}`}
    >
      <span className="relative shrink-0">
        <BotAvatar avatar={bot.avatar} size="sm" label={bot.name} trackCursor={false} />
        <PrimaryStar />
        {bot.busy ? (
          <ThoughtCloud className="-right-3 -top-2" label={`${bot.name} is responding`} />
        ) : (
          bot.unread && !active && <UnreadDot />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-sm', active ? 'font-semibold' : 'font-medium')}>{bot.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {bot.busy ? 'Responding…' : bot.unread && !active ? 'New messages' : 'Your primary bot · every skill'}
        </span>
      </span>
    </button>
  );
}

interface BotRowProps {
  bot: BotDto;
  index: number;
  count: number;
  active: boolean;
  heading?: string;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (delta: -1 | 1) => void;
  onTogglePin: () => void;
  onPick: () => void;
}

function BotRow({
  bot,
  index,
  count,
  active,
  heading,
  onDragStart,
  onDragEnd,
  onMove,
  onTogglePin,
  onPick,
}: BotRowProps) {
  // Only the handle starts a drag, so the row stays clickable and the list
  // stays scrollable by touch.
  const controls = useDragControls();
  const onHandleKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    onMove(e.key === 'ArrowUp' ? -1 : 1);
  };
  return (
    <Reorder.Item
      as="li"
      value={bot.id}
      dragListener={false}
      dragControls={controls}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="bg-popover"
      data-testid={`copilot-all-bots-row-${bot.id}`}
    >
      {heading && (
        <p
          className={cn(
            'px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground',
            index > 0 && 'pt-3',
          )}
        >
          {heading}
        </p>
      )}
      <div className={cn('group flex items-center gap-2 rounded-lg pr-1', active && 'bg-muted ring-1 ring-border')}>
        <button
          type="button"
          aria-label={`Move ${bot.name} (position ${index + 1} of ${count}); arrow keys move and pin it`}
          aria-keyshortcuts="ArrowUp ArrowDown"
          onPointerDown={(e) => controls.start(e)}
          onKeyDown={onHandleKey}
          className="flex h-10 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onPick}
          aria-current={active ? 'true' : undefined}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="relative shrink-0">
            <BotAvatar avatar={bot.avatar} size="sm" label={bot.name} trackCursor={false} />
            {bot.busy ? (
              <ThoughtCloud className="-right-3 -top-2" label={`${bot.name} is responding`} />
            ) : (
              bot.unread && !active && <UnreadDot />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className={cn('block truncate text-sm', active ? 'font-semibold' : 'font-medium')}>
              {bot.name}
            </span>
            {(bot.unread || bot.busy) && (
              <span className="block truncate text-xs text-muted-foreground">
                {bot.busy ? 'Responding…' : 'New messages'}
              </span>
            )}
          </span>
        </button>
        <button
          type="button"
          onClick={onTogglePin}
          aria-pressed={bot.pinned}
          aria-label={bot.pinned ? `Unpin ${bot.name}` : `Pin ${bot.name}`}
          title={bot.pinned ? 'Unpin' : 'Pin to the top'}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            !bot.pinned && 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
          )}
        >
          <Pin className={cn('h-4 w-4', bot.pinned && 'fill-current text-foreground')} />
        </button>
      </div>
    </Reorder.Item>
  );
}
