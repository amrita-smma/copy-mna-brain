"use client";

import { memo, useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, Reorder } from 'framer-motion';
import { LayoutGrid, Plus, Settings2 } from 'lucide-react';
import { useChatActions, useChatStatus, useChatThread } from '@/components/chat/ChatProvider';
import { useWorkspaceHref } from '@/hooks/useWorkspaceHref';
import { mergeVisibleOrder, moveId, pickVisibleBots } from '@/lib/bots/order';
import type { BotDto } from '@/lib/bots/types';
import { cn } from '@/lib/utils';
import { useLayoutControl } from '@/components/layout/LayoutControlContext';
import { AllBotsMenu } from './AllBotsMenu';
import { BotAvatar, type BotAvatarSize } from './BotAvatar';
import { PrimaryStar } from './PrimaryStar';
import { BotEditDialog } from './BotEditDialog';
import { isRespondingState, ThoughtCloud } from './ThoughtCloud';
import { useBotAvatarState } from './useBotAvatarState';
import { useBotPinning } from './useBotPinning';
import { UnreadDot } from './UnreadDot';

export { UnreadDot };

/** The strip's `gap-1`, in px; tile widths are measured. */
const TILE_GAP_PX = 4;

/**
 * How many bot tiles fit beside the fixed tiles (New bot, Manage, and Show
 * all once the bots overflow), re-measured whenever the strip resizes — the
 * copilot pane is resizable.
 */
function useTileCapacity(botCount: number, compact: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLButtonElement>(null);
  const [capacity, setCapacity] = useState(Infinity);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const tile = (probeRef.current?.offsetWidth ?? 0) + TILE_GAP_PX;
      if (tile <= TILE_GAP_PX) return;
      const width = container.clientWidth + TILE_GAP_PX;
      const total = Math.floor(width / tile);
      // Everything fits with just New bot and Manage beside the bots.
      if (botCount + 2 <= total) setCapacity(Infinity);
      else setCapacity(Math.max(1, total - 3));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  // `compact` changes the tile width without resizing the strip.
  }, [botCount, compact]);

  return { containerRef, probeRef, capacity };
}

/**
 * The row of bots across the top of the copilot (RFC 02). Each bot has one
 * permanent thread, so picking a bot here is how a user moves between
 * conversations — it replaces New Chat and the chat history list. The active
 * bot's avatar is live (thinking, working, talking) and follows the cursor;
 * the others idle.
 *
 * Order: Brain Bot (fixed on the left), then the user's pinned bots, then the
 * rest by newest activity. Dragging a
 * tile (or Alt+arrow on it) pins it where it lands. As many tiles show as fit
 * the pane; the rest are behind "All bots", which lists every bot with pin
 * toggles. The active bot always shows.
 */
export function BotStrip({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { bots, activeBot } = useChatThread();
  const { selectBot, refreshBots } = useChatActions();
  const { moveBot } = useBotPinning();
  const manageHref = useWorkspaceHref('/bots');
  // Manage is a page in the console. While the copilot is full-screen the
  // console is hidden behind it, so the link docks the copilot first — the
  // same move the "Opened X" chip makes — or the click looks like it did nothing.
  const { revealConsole } = useLayoutControl();
  const [creating, setCreating] = useState(false);
  const { containerRef, probeRef, capacity } = useTileCapacity(bots.length, compact);
  // The visible tiles' order while a drag is in progress (state to render it,
  // a ref to read on drop) and the tile being dragged; committed on drop.
  const [dragIds, setDragIds] = useState<string[] | null>(null);
  const dragRef = useRef<{ ids: string[]; movedId: string } | null>(null);
  const draggedRef = useRef(false);

  const visible = pickVisibleBots(bots, activeBot?.id, capacity);
  const overflowing = visible.length < bots.length;
  // Brain Bot leads the list, so it is always visible; it sits outside the
  // reorderable tiles because it never moves.
  const primary = visible.find((b) => b.is_default) ?? null;
  const movable = visible.filter((b) => !b.is_default);
  const byId = new Map(bots.map((b) => [b.id, b]));
  const tiles = dragIds
    ? dragIds.map((id) => byId.get(id)).filter((b): b is BotDto => !!b)
    : movable;
  const hidden = overflowing ? bots.filter((b) => !visible.includes(b)) : [];

  const allKey = bots.map((b) => b.id).join(',');
  /** The visible tiles now read `visibleIds` after `movedId` moved: pin it there. */
  const commitVisible = useCallback(
    (visibleIds: string[], movedId: string) => {
      const allIds = allKey.split(',');
      const next = mergeVisibleOrder(allIds, visibleIds);
      if (next.some((id, i) => id !== allIds[i])) moveBot(next, movedId);
    },
    [allKey, moveBot],
  );

  const activeId = activeBot?.id ?? null;
  const onSelectTile = useCallback(
    (id: string) => {
      // A drag ends with a click on the tile it moved; that is not a pick.
      if (draggedRef.current) {
        draggedRef.current = false;
        return;
      }
      if (id !== activeId) selectBot(id);
    },
    [selectBot, activeId],
  );

  const onMoveTile = useCallback(
    (id: string, delta: -1 | 1) => {
      const ids = dragIds ?? movable.map((b) => b.id);
      const from = ids.indexOf(id);
      if (from < 0) return;
      const next = moveId(ids, from, from + delta);
      if (dragIds) {
        dragRef.current = dragRef.current ? { ...dragRef.current, ids: next } : null;
        setDragIds(next);
      }
      commitVisible(next, id);
    },
    [dragIds, movable, commitVisible],
  );

  const size: BotAvatarSize = compact ? 'sm' : 'md';
  const tileWidth = compact ? 'w-14' : 'w-[4.5rem]';
  const fixedTile = cn(
    // Quiet glass: the strip floats over the transcript, and a label with nothing
    // behind it is unreadable over the text scrolling past.
    'group liquid-glass liquid-glass-quiet flex shrink-0 flex-col items-center gap-1 rounded-2xl px-1 pb-1.5 pt-2 text-muted-foreground transition-colors hover:text-foreground',
    tileWidth,
  );
  const fixedIcon = cn(
    'flex items-center justify-center rounded-full',
    compact ? 'h-8 w-8' : 'h-12 w-12',
  );

  return (
    <div ref={containerRef} className={cn('min-w-0 overflow-hidden', className)}>
      <div className="mx-auto flex w-max items-end gap-1">
        {primary && (
          <div className="shrink-0" data-testid="copilot-bot-primary">
            <BotTile
              bot={primary}
              active={primary.id === activeBot?.id}
              size={size}
              widthClass={tileWidth}
              onSelect={onSelectTile}
              onMove={onMoveTile}
              fixed
            />
          </div>
        )}
        <Reorder.Group
          as="div"
          axis="x"
          values={tiles.map((b) => b.id)}
          onReorder={(ids: string[]) => {
            if (dragRef.current) dragRef.current.ids = ids;
            setDragIds(ids);
          }}
          role="group"
          aria-label="Bots"
          className="flex items-end gap-1"
          data-testid="copilot-bot-strip"
        >
          {tiles.map((bot) => (
            <Reorder.Item
              key={bot.id}
              as="div"
              value={bot.id}
              className="shrink-0 touch-pan-y"
              // A drag released off its tile never clicks; start each press clean.
              onPointerDownCapture={() => {
                draggedRef.current = false;
              }}
              onDragStart={() => {
                draggedRef.current = true;
                const ids = movable.map((b) => b.id);
                dragRef.current = { ids, movedId: bot.id };
                setDragIds(ids);
              }}
              onDragEnd={() => {
                const drag = dragRef.current;
                dragRef.current = null;
                setDragIds(null);
                if (!drag) return;
                const start = movable.map((b) => b.id).join(',');
                if (drag.ids.join(',') === start) return;
                commitVisible(drag.ids, drag.movedId);
              }}
            >
              <BotTile
                bot={bot}
                active={bot.id === activeBot?.id}
                size={size}
                widthClass={tileWidth}
                onSelect={onSelectTile}
                onMove={onMoveTile}
              />
            </Reorder.Item>
          ))}
        </Reorder.Group>
        {overflowing && (
          <AllBotsMenu
            bots={bots}
            activeBotId={activeBot?.id ?? null}
            onSelect={selectBot}
            trigger={
              <button
                type="button"
                aria-label={`Show all bots (${hidden.length} more)`}
                className={fixedTile}
                data-testid="copilot-bot-show-all"
              >
                <span className={cn('relative', fixedIcon, 'bg-muted')}>
                  <LayoutGrid className="h-4 w-4" />
                  <span className="absolute -bottom-1 -right-1 rounded-full bg-foreground px-1 text-[9px] font-semibold leading-4 text-background">
                    +{hidden.length}
                  </span>
                  {hidden.some((b) => b.busy) ? (
                    <ThoughtCloud className="-right-3 -top-2.5" label="A hidden bot is responding" />
                  ) : (
                    hidden.some((b) => b.unread) && <UnreadDot />
                  )}
                </span>
                <span className="text-[11px] font-medium">All bots</span>
              </button>
            }
          />
        )}
        <button
          ref={probeRef}
          type="button"
          aria-label="New bot"
          onClick={() => setCreating(true)}
          className={fixedTile}
          data-testid="copilot-bot-new"
        >
          <span
            className={cn(
              fixedIcon,
              'border-2 border-dashed border-muted-foreground/40 transition-colors group-hover:border-foreground/60',
            )}
          >
            <Plus className={compact ? 'h-4 w-4' : 'h-5 w-5'} />
          </span>
          <span className="text-[11px] font-medium">New bot</span>
        </button>
        <Link href={manageHref} aria-label="Manage bots" className={fixedTile} onClick={revealConsole} data-testid="copilot-bot-manage">
          <span className={cn(fixedIcon, 'bg-muted')}>
            <Settings2 className={compact ? 'h-4 w-4' : 'h-5 w-5'} />
          </span>
          <span className="text-[11px] font-medium">Manage</span>
        </Link>
      </div>

      {creating && (
        <BotEditDialog
          key="new"
          bot={null}
          open={creating}
          onOpenChange={(open) => {
            if (!open) setCreating(false);
          }}
          onSaved={(saved) => {
            setCreating(false);
            void refreshBots().then(() => selectBot(saved.id));
          }}
        />
      )}
    </div>
  );
}

function botTileAriaLabel(bot: BotDto, active: boolean): string {
  const parts = [bot.name];
  if (bot.is_default) parts.push('primary bot');
  if (active) parts.push('active');
  else if (bot.unread) parts.push('new messages');
  return parts.join(', ');
}

interface BotTileProps {
  bot: BotDto;
  active: boolean;
  size: BotAvatarSize;
  widthClass: string;
  onSelect: (id: string) => void;
  /** Move this tile one place left (-1) or right (1). */
  onMove: (id: string, delta: -1 | 1) => void;
  /** Brain Bot's tile: it never moves. */
  fixed?: boolean;
}

// Memoised: the strip sits above a streaming transcript, and only the active
// tile's avatar should re-render while tokens arrive.
const BotTile = memo(function BotTile({ bot, active, size, widthClass, onSelect, onMove, fixed = false }: BotTileProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (fixed || !e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    onMove(bot.id, e.key === 'ArrowLeft' ? -1 : 1);
  };
  return (
    <button
      type="button"
      onClick={() => onSelect(bot.id)}
      onKeyDown={onKeyDown}
      aria-keyshortcuts={fixed ? undefined : 'Alt+ArrowLeft Alt+ArrowRight'}
      aria-current={active ? 'true' : undefined}
      aria-label={botTileAriaLabel(bot, active)}
      title={bot.name}
      className={cn(
        'relative flex shrink-0 flex-col items-center gap-1 rounded-2xl px-1 pb-1.5 pt-2 outline-none focus-visible:ring-2 focus-visible:ring-ring',
        // Idle tiles wear the quiet glass themselves; the active one is backed
        // by the solid glass span below, which slides between tiles.
        !active && 'liquid-glass liquid-glass-quiet',
        !fixed && 'cursor-grab active:cursor-grabbing',
        widthClass,
      )}
      data-testid={`copilot-bot-option-${bot.id}`}
    >
      {active && (
        <motion.span
          layoutId="copilot-bot-strip-active"
          className="liquid-glass liquid-glass-solid absolute inset-0 rounded-2xl"
          transition={{ type: 'spring', stiffness: 420, damping: 34 }}
        />
      )}
      <motion.span
        className={cn('relative', !active && 'opacity-75 transition-opacity hover:opacity-100')}
        whileHover={active ? undefined : { scale: 1.08, y: -2 }}
        whileTap={{ scale: 0.94 }}
      >
        {active ? (
          <LiveAvatar bot={bot} size={size} />
        ) : (
          <BotAvatar avatar={bot.avatar} size={size} label={bot.name} trackCursor={false} />
        )}
        {bot.unread && !active && !bot.busy && <UnreadDot />}
        {bot.is_default && <PrimaryStar className={size === 'md' ? 'h-4 w-4' : undefined} />}
      </motion.span>
      {/* Outside the avatar's wrapper so an idle tile's dimming doesn't fade it. */}
      <AnimatePresence>
        {active ? (
          <ActiveThoughtCloud key="cloud" bot={bot} />
        ) : (
          bot.busy && <ThoughtCloud key="cloud" className={CLOUD_POSITION} label={`${bot.name} is responding`} />
        )}
      </AnimatePresence>
      <span
        className={cn(
          'relative w-full truncate text-center text-[11px]',
          active ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground',
        )}
      >
        {bot.name}
      </span>
    </button>
  );
});

/** Where a tile's thought cloud sits: over the avatar's top-right, inside the tile. */
const CLOUD_POSITION = 'right-0 top-0';

/**
 * The active bot's cloud: while its turn is thinking, running tools or
 * typing, or while it answers another bot in the background (its thread is
 * busy and this tab is not streaming).
 */
function ActiveThoughtCloud({ bot }: { bot: BotDto }) {
  const { status, activity } = useChatStatus();
  const state = useBotAvatarState(status, activity);
  const responding = isRespondingState(state) || (bot.busy && status === 'ready');
  return (
    <AnimatePresence>
      {responding && <ThoughtCloud key="cloud" className={CLOUD_POSITION} label={`${bot.name} is responding`} />}
    </AnimatePresence>
  );
}

/** The active bot reacts to the chat: thinking, working, talking, happy. */
function LiveAvatar({ bot, size }: { bot: BotDto; size: BotAvatarSize }) {
  const { status, activity } = useChatStatus();
  const state = useBotAvatarState(status, activity);
  return <BotAvatar avatar={bot.avatar} state={state} size={size} label={bot.name} />;
}
