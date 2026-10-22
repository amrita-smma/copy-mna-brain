'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useMotionValue, useTransform } from 'framer-motion';
import { Activity, ListChecks, Mail, MailOpen, Pencil, Pin, PinOff, Plus, Search, X } from 'lucide-react';
import { SwipeRow, type SwipeAction } from './SwipeRow';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { isTaskOverdue, useUserTasks } from '@/hooks/useUserTasks';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { BotAvatar } from '@/components/bots/BotAvatar';
import { BotEditDialog } from '@/components/bots/BotEditDialog';
import { PrimaryStar } from '@/components/bots/PrimaryStar';
import { ThoughtCloud } from '@/components/bots/ThoughtCloud';
import { useBotPinning } from '@/components/bots/useBotPinning';
import { useChatActions, useChatThread } from '@/components/chat/ChatProvider';
import { LiquidGlass, LiquidGlassButton } from '@/components/ui/liquid-glass';
import { MOBILE_MAX_BOT_PINS, canPinOnMobile, splitMobileHome } from '@/lib/bots/order';
import { listTimeLabel, previewLine } from '@/lib/bots/preview';
import type { BotDto } from '@/lib/bots/types';

const NO_CALLOUT = 'select-none touch-manipulation [-webkit-touch-callout:none]';
/** Tactile press feedback, Apple style: a quick, small scale-down. */
const PRESS = 'transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100';

function initialsOf(name: string | undefined, email: string | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (email ?? '?').slice(0, 1).toUpperCase();
}

/**
 * The mobile landing: a bot picker, laid out like Grok's.
 *
 * - The top bar has the Profile button on the left, and Search and New bot on
 *   the right.
 * - Below it, the pinned tiles: large avatars in rows of three, named
 *   underneath. Timeline always comes first, Your tasks second (its icon turns
 *   red with a count when a reminder has passed) and Brain Bot third, then up
 *   to three pinned bots.
 * - Every other bot follows as a chat-list row: avatar, name, when it last
 *   spoke, its latest message, and an unread dot.
 *
 * Tapping a bot opens its chat full-screen. Swiping a bot right marks it read
 * or unread; swiping a row left reveals Pin and Edit (a long swipe pins), and
 * swiping a pinned tile left unpins it. Brain Bot is never unpinned.
 */
export function MobileBotHome({ onOpenBot }: { onOpenBot: (id: string) => void }) {
  const { user } = useAuth();
  const { bots } = useChatThread();
  const { refreshBots } = useChatActions();
  const { togglePinned } = useBotPinning();
  // The tasks tile wears a red count of reminders that have passed; the same
  // cache the Tasks page and the reminder alerts read.
  const { tasks, now } = useUserTasks();
  const overdueTasks = tasks.filter((t) => isTaskOverdue(t, now)).length;
  const { setBotUnread } = useChatActions();
  // The one list row whose swipe actions rest open.
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [editing, setEditing] = useState<BotDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (query !== null) searchRef.current?.focus();
  }, [query !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const { primary, pinned, rest } = splitMobileHome(bots);
  const pinFull = !canPinOnMobile(bots);
  const searching = query !== null;
  const needle = (query ?? '').trim().toLowerCase();
  const found = needle ? bots.filter((b) => b.name.toLowerCase().includes(needle)) : bots;

  const togglePin = (bot: BotDto) => {
    setOpenRowId(null);
    if (!bot.pinned && pinFull) {
      toast.error(`You can pin up to ${MOBILE_MAX_BOT_PINS} bots. Unpin one first.`);
      return;
    }
    togglePinned(bot.id);
  };

  /** Swipe right: read ↔ unread. A thread with no reply yet has nothing to mark. */
  const toggleRead = (bot: BotDto) => {
    if (!bot.last_activity_at) return;
    setBotUnread(bot.id, !bot.unread);
  };

  const rowProps = (bot: BotDto) => ({
    bot,
    onOpen: onOpenBot,
    onToggleRead: toggleRead,
    onTogglePin: togglePin,
    onEdit: (b: BotDto) => setEditing(b),
    open: openRowId === bot.id,
    onOpenChange: (open: boolean) => setOpenRowId(open ? bot.id : null),
    pinFull,
  });

  return (
    <div className="relative h-full min-h-0 bg-background" data-testid="mobile-bot-home">
      {/* The controls float over the list: the list scrolls the full height
          beneath them, behind a fade that keeps the buttons legible. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[calc(env(safe-area-inset-top)+5.5rem)] bg-gradient-to-b from-background via-background/80 to-transparent" />
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center gap-3 px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        {searching ? (
          <>
            <LiquidGlass className="pointer-events-auto flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full px-4 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
              <Search className="h-[18px] w-[18px] shrink-0 text-muted-foreground" aria-hidden />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setQuery(null);
                }}
                placeholder="Search bots"
                aria-label="Search bots"
                className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
                data-testid="mobile-bot-search"
              />
            </LiquidGlass>
            <LiquidGlassButton onClick={() => setQuery(null)} aria-label="Close search" className="pointer-events-auto">
              <X />
            </LiquidGlassButton>
          </>
        ) : (
          <>
            <LiquidGlassButton asChild className="pointer-events-auto p-1">
              <WorkspaceLink href="/profile" aria-label="Profile" data-testid="mobile-pin-profile">
                <span className="flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-sm font-semibold text-white">
                  {initialsOf(user?.name, user?.email)}
                </span>
              </WorkspaceLink>
            </LiquidGlassButton>
            <div className="pointer-events-auto ml-auto flex items-center gap-2.5">
              <LiquidGlassButton onClick={() => setQuery('')} aria-label="Search bots">
                <Search />
              </LiquidGlassButton>
              <LiquidGlassButton onClick={() => setCreating(true)} aria-label="New bot" data-testid="mobile-new-bot">
                <Plus className="!h-[22px] !w-[22px]" />
              </LiquidGlassButton>
            </div>
          </>
        )}
      </header>

      <div className="h-full overflow-y-auto overscroll-contain pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-[calc(env(safe-area-inset-top)+4.25rem)]">
        {!searching && (
          <nav aria-label="Timeline, your tasks, your primary bot and pinned bots" className="grid grid-cols-3 gap-x-2 gap-y-5 px-3 pb-4 pt-6" data-testid="mobile-pinned">
            <WorkspaceLink
              href="/dashboard"
              className={cn('flex min-w-0 flex-col items-center gap-2', PRESS, NO_CALLOUT)}
              data-testid="mobile-pin-timeline"
            >
              <span className="liquid-glass flex h-24 w-24 items-center justify-center rounded-full text-foreground">
                <Activity className="h-9 w-9" strokeWidth={1.75} />
              </span>
              <span className="max-w-full truncate text-sm text-muted-foreground">Timeline</span>
            </WorkspaceLink>
            <WorkspaceLink
              href="/tasks"
              className={cn('flex min-w-0 flex-col items-center gap-2', PRESS, NO_CALLOUT)}
              aria-label={overdueTasks > 0 ? `Your tasks, ${overdueTasks} overdue` : 'Your tasks'}
              data-testid="mobile-pin-tasks"
            >
              <span className="liquid-glass relative flex h-24 w-24 items-center justify-center rounded-full text-foreground">
                <ListChecks
                  className={cn('h-9 w-9', overdueTasks > 0 && 'text-red-500')}
                  strokeWidth={1.75}
                />
                {overdueTasks > 0 && (
                  <span
                    aria-hidden
                    data-testid="mobile-tasks-overdue"
                    className="absolute right-0.5 top-0.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-red-500 px-1.5 text-xs font-semibold leading-none text-white ring-[3px] ring-background"
                  >
                    {overdueTasks > 9 ? '9+' : overdueTasks}
                  </span>
                )}
              </span>
              <span className="max-w-full truncate text-sm text-muted-foreground">Your tasks</span>
            </WorkspaceLink>
            {primary && (
              <PinnedTile bot={primary} onOpen={onOpenBot} onToggleRead={toggleRead} onUnpin={togglePin} fixed />
            )}
            {pinned.map((bot) => (
              <PinnedTile key={bot.id} bot={bot} onOpen={onOpenBot} onToggleRead={toggleRead} onUnpin={togglePin} />
            ))}
          </nav>
        )}

        {(searching ? found : rest).length > 0 ? (
          <ul data-testid="mobile-bot-list">
            {(searching ? found : rest).map((bot) => (
              <li key={bot.id}>
                <BotListRow {...rowProps(bot)} />
              </li>
            ))}
          </ul>
        ) : (
          searching && <p className="px-6 py-8 text-center text-sm text-muted-foreground">No bots match.</p>
        )}
        {!searching && bots.length > 0 && (
          <p className="px-6 pt-4 text-center text-xs text-muted-foreground">Swipe left to pin or edit a bot, right to mark it read or unread.</p>
        )}
      </div>


      {editing && (
        <BotEditDialog
          key={editing.id}
          bot={editing}
          open={!!editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            void refreshBots();
          }}
          onOpenChat={() => {
            const id = editing.id;
            setEditing(null);
            onOpenBot(id);
          }}
        />
      )}
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
            void refreshBots().then(() => onOpenBot(saved.id));
          }}
        />
      )}
    </div>
  );
}

/** How far a pinned tile must travel before letting go acts. */
const TILE_SWIPE_PX = 56;

/**
 * A pinned bot. It wobbles along with a sideways swipe and springs back:
 * left past the threshold unpins it, right marks it read or unread.
 */
function PinnedTile({
  bot,
  onOpen,
  onToggleRead,
  onUnpin,
  fixed = false,
}: {
  bot: BotDto;
  onOpen: (id: string) => void;
  onToggleRead: (bot: BotDto) => void;
  onUnpin: (bot: BotDto) => void;
  /** Brain Bot's tile: always pinned, so a left swipe does nothing. */
  fixed?: boolean;
}) {
  const x = useMotionValue(0);
  const draggedRef = useRef(false);
  const unpinHint = useTransform(x, [-TILE_SWIPE_PX, -12], [1, 0]);
  const readHint = useTransform(x, [12, TILE_SWIPE_PX], [0, 1]);
  const status = bot.busy ? ', responding' : bot.unread ? ', new reply' : '';
  const defaultLabel = bot.is_default ? ', your primary bot' : '';
  const swipeHint = fixed
    ? `Swipe right to mark ${bot.unread ? 'read' : 'unread'}.`
    : `Swipe left to unpin, right to mark ${bot.unread ? 'read' : 'unread'}.`;
  return (
    <div className="relative flex min-w-0 justify-center">
      {!fixed && (
        <motion.span aria-hidden style={{ opacity: unpinHint }} className="pointer-events-none absolute right-1 top-9 text-muted-foreground">
          <PinOff className="h-4 w-4" />
        </motion.span>
      )}
      <motion.span aria-hidden style={{ opacity: readHint }} className="pointer-events-none absolute left-1 top-9 text-blue-500">
        {bot.unread ? <MailOpen className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
      </motion.span>
      <motion.button
        type="button"
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={fixed ? { left: 0.08, right: 0.45 } : 0.45}
        dragSnapToOrigin
        style={{ x, touchAction: 'pan-y' }}
        onPointerDown={() => {
          draggedRef.current = false;
        }}
        onDragStart={() => {
          draggedRef.current = true;
        }}
        onDragEnd={(_, info) => {
          if (info.offset.x <= -TILE_SWIPE_PX) {
            if (!fixed) onUnpin(bot);
          }
          else if (info.offset.x >= TILE_SWIPE_PX) onToggleRead(bot);
        }}
        onClick={() => {
          if (draggedRef.current) {
            draggedRef.current = false;
            return;
          }
          onOpen(bot.id);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' && !fixed) {
            e.preventDefault();
            onUnpin(bot);
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            onToggleRead(bot);
          }
        }}
        className={cn('flex min-w-0 flex-col items-center gap-2', PRESS, NO_CALLOUT)}
        data-testid="mobile-pinned-bot"
        aria-label={`${bot.name}${defaultLabel}${status}. ${swipeHint}`}
      >
        <span className="relative">
          <BotAvatar avatar={bot.avatar} size="xl" />
          {bot.is_default && <PrimaryStar className="bottom-0.5 right-0.5 h-7 w-7 ring-[3px]" />}
          {bot.busy ? (
            <ThoughtCloud className="-right-2 -top-1" label={`${bot.name} is responding`} />
          ) : (
            bot.unread && (
              <span aria-hidden className="absolute right-1 top-1 h-3.5 w-3.5 rounded-full bg-blue-500 ring-[3px] ring-background" />
            )
          )}
        </span>
        <span className="max-w-full truncate text-sm text-muted-foreground">{bot.name}</span>
      </motion.button>
    </div>
  );
}

function BotListRow({
  bot,
  onOpen,
  onToggleRead,
  onTogglePin,
  onEdit,
  open,
  onOpenChange,
  pinFull,
}: {
  bot: BotDto;
  onOpen: (id: string) => void;
  onToggleRead: (bot: BotDto) => void;
  onTogglePin: (bot: BotDto) => void;
  onEdit: (bot: BotDto) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pinFull: boolean;
}) {
  const preview = bot.busy ? 'Responding…' : previewLine(bot.last_message);
  const when = listTimeLabel(bot.last_activity_at);
  // Brain Bot is always pinned and never edited: it has no trailing actions.
  const trailing: SwipeAction[] = bot.is_default ? [] : [
    {
      key: 'pin',
      label: bot.pinned ? 'Unpin' : 'Pin',
      icon: bot.pinned ? PinOff : Pin,
      // A full pin block greys the action; pressing it still explains why.
      className: !bot.pinned && pinFull ? 'bg-muted-foreground text-white' : 'bg-amber-500 text-white',
      onSelect: () => onTogglePin(bot),
    },
    ...(bot.can_edit
      ? [{ key: 'edit', label: 'Edit', icon: Pencil, className: 'bg-slate-400 text-white dark:bg-slate-600', onSelect: () => onEdit(bot) }]
      : []),
  ];
  const leading: SwipeAction | undefined = bot.last_activity_at
    ? {
        key: 'read',
        label: bot.unread ? 'Read' : 'Unread',
        icon: bot.unread ? MailOpen : Mail,
        className: 'bg-blue-500 text-white',
        onSelect: () => onToggleRead(bot),
      }
    : undefined;
  return (
    <SwipeRow leading={leading} trailing={trailing} open={open} onOpenChange={onOpenChange}>
    <button
      type="button"
      onClick={() => onOpen(bot.id)}
      className={cn('flex w-full items-center gap-3.5 px-5 py-2 text-left transition-colors active:bg-muted', NO_CALLOUT)}
      data-testid="mobile-bot-row"
      aria-label={`${bot.name}${bot.is_default ? ', your primary bot' : ''}${bot.unread ? ', new reply' : ''}.${bot.is_default ? '' : ` Swipe left to ${bot.pinned ? 'unpin' : 'pin'} or edit,`} Swipe right to mark ${bot.unread ? 'read' : 'unread'}.`}
    >
      <span className="relative shrink-0">
        {/* Cursor tracking off: one window listener per row adds up on a long list. */}
        <BotAvatar avatar={bot.avatar} size="md" trackCursor={false} />
        {bot.is_default && <PrimaryStar className="h-4 w-4" />}
        {/* The cloud, not only the "Responding…" preview line: the same sign as the strip and the pinned tiles. */}
        {bot.busy && <ThoughtCloud className="-right-2.5 -top-2" label={`${bot.name} is responding`} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-base font-medium leading-tight text-foreground">{bot.name}</span>
          {when && <span className="shrink-0 text-[13px] text-muted-foreground">{when}</span>}
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm text-muted-foreground',
              bot.busy && 'text-blue-600 dark:text-blue-400',
              !preview && 'italic',
            )}
          >
            {preview || 'No messages yet'}
          </span>
          {bot.unread && !bot.busy && (
            <span aria-hidden data-testid="bot-unread-dot" className="h-2.5 w-2.5 shrink-0 rounded-full bg-blue-500" />
          )}
          {bot.pinned && <Pin aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        </span>
      </span>
    </button>
    </SwipeRow>
  );
}
