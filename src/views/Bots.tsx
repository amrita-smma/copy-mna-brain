"use client";

import { useState } from 'react';
import { CalendarClock, Info, ListChecks, MessageSquare, Pencil, Plus, Sparkles, Trash2, Users, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/PageHeader';
import { BetaChip } from '@/components/BetaChip';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { BotAvatar } from '@/components/bots/BotAvatar';
import { PrimaryStar } from '@/components/bots/PrimaryStar';
import { BotEditDialog, type BotDialogTab } from '@/components/bots/BotEditDialog';
import { personaText } from '@/lib/bots/persona';
import { useChatActions, useChatThread } from '@/components/chat/ChatProvider';
import { useLayoutControl } from '@/components/layout/LayoutControlContext';
import { archiveBot } from '@/lib/api/bots';
import type { BotDto } from '@/lib/bots/types';

/**
 * Manage Copilot bots (RFC 02). The list is the chat provider's, so the bot
 * switcher and this page never disagree; saving refreshes it for both.
 * The primary bot leads the Private section (each user's own name for it); it
 * is never edited (its card opens a read-only About instead).
 */
export default function Bots() {
  const { bots } = useChatThread();
  const { refreshBots, selectBot } = useChatActions();
  const { expandCopilot } = useLayoutControl();
  // The dialog is derived from this selection (`.claude/rules/dialog-open-state.md`):
  // `{ bot: null }` is "new bot", `null` is closed; `tab` picks the dialog's tab.
  const [editing, setEditing] = useState<{ bot: BotDto | null; tab?: BotDialogTab } | null>(null);
  const [archiving, setArchiving] = useState<BotDto | null>(null);

  // The primary bot is each person's own, so it leads the Private section.
  const shared = bots.filter((b) => !b.is_default && b.visibility === 'workspace');
  const mine = [
    ...bots.filter((b) => b.is_default),
    ...bots.filter((b) => !b.is_default && b.visibility !== 'workspace'),
  ];

  const chatWith = (bot: BotDto) => {
    selectBot(bot.id);
    expandCopilot();
  };

  const confirmArchive = async () => {
    const bot = archiving;
    setArchiving(null);
    if (!bot) return;
    try {
      await archiveBot(bot.id);
      toast.success(`${bot.name} archived`);
      await refreshBots();
    } catch (err) {
      toast.error((err as Error).message || 'Could not archive the bot');
    }
  };

  return (
    <div className="min-h-full">
      <PageHeader
        title="Bots"
        titleAdornment={
          <BetaChip
            className="px-2 py-0.5 text-xs"
            data-testid="bots-page-beta-chip"
          />
        }
        subtitle="Copilots with their own instructions, skills and look. Each bot keeps one ongoing chat per person."
        actions={
          <Button className="gap-2" onClick={() => setEditing({ bot: null })} data-testid="bot-new">
            <Plus className="h-4 w-4" />
            New bot
          </Button>
        }
      />

      <div className="space-y-8 p-6">
        {/* Everyone has a primary bot, so an empty list is still loading. */}
        {bots.length === 0 ? (
          <div className={GRID}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-44 rounded-xl" />
            ))}
          </div>
        ) : (
          <>
            <BotSection
              id="shared"
              title="Shared"
              description="Everyone in the workspace can chat with and edit these bots."
              empty="No shared bots yet. Turn on “Share with workspace” in a bot's settings to share it."
              bots={shared}
              onChat={chatWith}
              onEdit={(bot, tab) => setEditing({ bot, tab })}
              onArchive={setArchiving}
            />
            <BotSection
              id="private"
              title="Private"
              description="Only you can see these bots."
              empty="You have no private bots. New bots start private."
              bots={mine}
              onChat={chatWith}
              onEdit={(bot, tab) => setEditing({ bot, tab })}
              onArchive={setArchiving}
            />
          </>
        )}
      </div>

      {editing && (
        <BotEditDialog
          key={editing.bot?.id ?? 'new'}
          bot={editing.bot}
          initialTab={editing.tab}
          open={!!editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSaved={(saved) => {
            setEditing(null);
            void refreshBots();
            if (!editing.bot) chatWith(saved);
          }}
          onArchived={() => {
            setEditing(null);
            void refreshBots();
          }}
          onOpenChat={
            editing.bot
              ? () => {
                  const bot = editing.bot;
                  setEditing(null);
                  if (bot) chatWith(bot);
                }
              : undefined
          }
        />
      )}

      <AlertDialog
        open={archiving !== null}
        onOpenChange={(open) => {
          if (!open) setArchiving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {archiving?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The bot disappears for everyone it was shared with. Past chats with it are kept but
              can no longer be continued.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmArchive}>Archive</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Columns follow the page's own width, not the viewport's: opening or
 * widening the copilot pane narrows the page, and the grid drops a column
 * rather than squeezing the cards.
 */
const GRID = 'grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,18rem),1fr))]';

function BotSection({
  id,
  title,
  description,
  empty,
  bots,
  onChat,
  onEdit,
  onArchive,
}: {
  id: string;
  title: string;
  description: string;
  empty: string;
  bots: BotDto[];
  onChat: (bot: BotDto) => void;
  onEdit: (bot: BotDto, tab?: BotDialogTab) => void;
  onArchive: (bot: BotDto) => void;
}) {
  return (
    <section aria-labelledby={`bots-${id}`} data-testid={`bot-section-${id}`}>
      <div className="mb-3 flex items-baseline gap-2">
        <h2 id={`bots-${id}`} className="text-base font-semibold">
          {title}
        </h2>
        <span className="text-sm tabular-nums text-muted-foreground">{bots.length}</span>
        <p className="ml-2 hidden truncate text-sm text-muted-foreground sm:block">{description}</p>
      </div>
      {bots.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-card px-4 py-6 text-center text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className={GRID} data-testid={`bot-grid-${id}`}>
          {bots.map((bot) => (
            <BotCard key={bot.id} bot={bot} onChat={onChat} onEdit={onEdit} onArchive={onArchive} />
          ))}
        </ul>
      )}
    </section>
  );
}

function BotCard({
  bot,
  onChat,
  onEdit,
  onArchive,
}: {
  bot: BotDto;
  onChat: (bot: BotDto) => void;
  onEdit: (bot: BotDto, tab?: BotDialogTab) => void;
  onArchive: (bot: BotDto) => void;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-xl border bg-card p-4" data-testid={`bot-card-${bot.id}`}>
      <div className="flex items-start gap-3">
        <span className="relative shrink-0">
          <BotAvatar avatar={bot.avatar} size="md" />
          {bot.is_default && <PrimaryStar className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium">{bot.name}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {bot.is_default || personaText(bot.persona_md) ? 'Every skill' : 'Not set up yet'}
          </p>
        </div>
        <Badge variant="secondary" className="shrink-0 gap-1">
          {bot.is_default ? (
            <Sparkles className="h-3 w-3" />
          ) : bot.visibility === 'workspace' ? (
            <Users className="h-3 w-3" />
          ) : (
            <Lock className="h-3 w-3" />
          )}
          {bot.is_default ? 'Primary' : bot.visibility === 'workspace' ? (bot.is_owner ? 'Yours' : 'Shared') : 'Private'}
        </Badge>
      </div>

      <p className="line-clamp-2 min-h-[2.5rem] text-sm text-muted-foreground">
        {bot.is_default
          ? 'The master agent. Orchestrates your other bots. Always on.'
          : personaText(bot.persona_md) || 'Blank persona. Open its chat and tell it who it is.'}
      </p>

      <div className="mt-auto flex items-center gap-2 pt-1">
        <Button size="sm" className="gap-1.5" onClick={() => onChat(bot)}>
          <MessageSquare className="h-3.5 w-3.5" />
          Chat
        </Button>
        {bot.can_edit && (
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onEdit(bot)}>
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
        )}
        {bot.is_default && (
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onEdit(bot)}>
            <Info className="h-3.5 w-3.5" />
            About
          </Button>
        )}
        {/* Brain Bot's routines and task log are each person's own. */}
        {(bot.can_edit || bot.is_default) && (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0 text-muted-foreground"
              aria-label={`${bot.name}'s routines`}
              title="Routines"
              onClick={() => onEdit(bot, 'routines')}
            >
              <CalendarClock className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0 text-muted-foreground"
              aria-label={`${bot.name}'s task log`}
              title="Task log"
              onClick={() => onEdit(bot, 'tasks')}
            >
              <ListChecks className="h-4 w-4" />
            </Button>
          </>
        )}
        {bot.is_owner && !bot.is_default && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-8 w-8 p-0 text-muted-foreground"
            aria-label={`Archive ${bot.name}`}
            onClick={() => onArchive(bot)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </li>
  );
}
