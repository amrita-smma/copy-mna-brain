"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useChatActions, useChatThread } from "./ChatProvider";
import { useLayoutControl } from "@/components/layout/LayoutControlContext";
import { SidebarPagesNav } from "@/components/layout/SidebarPagesNav";
import { BotAvatar } from "@/components/bots/BotAvatar";
import { PrimaryStar } from "@/components/bots/PrimaryStar";
import { ThoughtCloud } from "@/components/bots/ThoughtCloud";
import { UnreadDot } from "@/components/bots/UnreadDot";
import { BotEditDialog } from "@/components/bots/BotEditDialog";
import { WorkspaceLink } from "@/components/WorkspaceLink";
import { pickVisibleBots } from "@/lib/bots/order";
import { findTabByPath, toLogicalPath } from "@/lib/navigation/consoleTabs";
import { Plus, SlidersHorizontal } from "lucide-react";

/** Bots listed in the sidebar before the rest fold behind "Show more". */
export const SIDEBAR_BOT_LIMIT = 5;

/**
 * The expanded sidebar's body: the user's bots, then the app's pages as
 * collapsible sections (Deal Flow, Intelligence). Each bot is one permanent
 * thread (RFC 02), so the bot list is the conversation list — there is no New
 * Chat and no chat history.
 *
 * The Bots header carries "+" (the create dialog) and "Manage" (the Bots page,
 * which the page-nav sections leave out). The list shows the first five bots
 * in list order (pinned, then newest activity; the active bot always among
 * them); "Show more (+N)" expands the rest in place.
 */
export function ChatSidebar({
  className,
  onNavigate,
}: {
  className?: string;
  /** Called after the user picks a bot or opens a page. Used by the mobile
   *  drawer to close itself once something is chosen; the argument tells it
   *  whether the choice keeps the user in the chat (so the composer should
   *  keep the caret) or navigates away from it. */
  onNavigate?: (target: "chat" | "page") => void;
}) {
  const { selectBot, refreshBots } = useChatActions();
  const { bots, activeBot } = useChatThread();
  // Picking a bot should put the copilot in front of the user. A no-op outside
  // the app shell (and on mobile, where the copilot is already full-screen
  // whenever this list is reachable).
  const { expandCopilot, revealConsole } = useLayoutControl();
  const pathname = usePathname();
  const onBotsPage = findTabByPath(toLogicalPath(pathname))?.slug === "bots";
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const firstBots = pickVisibleBots(bots, activeBot?.id, SIDEBAR_BOT_LIMIT);
  const hiddenBots = bots.filter((b) => !firstBots.includes(b));
  const shownBots = expanded ? bots : firstBots;

  const handleSelectBot = (id: string) => {
    selectBot(id);
    expandCopilot();
    onNavigate?.("chat");
  };

  return (
    <aside className={cn("flex flex-col w-64 border-r bg-background min-h-0", className)}>
      <ScrollArea className="flex-1 min-h-0 [&>[data-radix-scroll-area-viewport]>div]:!block">
        <div className="flex flex-col gap-4 py-3">
          <section aria-labelledby="sidebar-bots-heading" className="px-2">
            <div className="flex items-center gap-1 py-1 pl-2">
              <h2
                id="sidebar-bots-heading"
                className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70"
              >
                Bots
              </h2>
              <button
                type="button"
                onClick={() => setCreating(true)}
                aria-label="New bot"
                title="New bot"
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                data-testid="sidebar-bot-new"
              >
                <Plus className="h-4 w-4" />
              </button>
              <WorkspaceLink
                href="/bots"
                aria-current={onBotsPage ? "page" : undefined}
                // The copilot may be full-screen over the console; the page
                // would open out of sight behind it.
                onClick={() => {
                  revealConsole();
                  onNavigate?.("page");
                }}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-500/10 dark:text-blue-300",
                  onBotsPage && "bg-blue-500/10",
                )}
                data-testid="sidebar-bot-manage"
              >
                <SlidersHorizontal className="h-4 w-4" />
                Manage
              </WorkspaceLink>
            </div>

            <ul className="mt-1 space-y-0.5" data-testid="sidebar-bot-list">
              {shownBots.map((b) => {
                const isActive = b.id === activeBot?.id;
                return (
                  <li key={b.id} className="relative">
                    {/* The active bot's marker hangs on the sidebar's edge. */}
                    {isActive && (
                      <span
                        aria-hidden
                        className="absolute -left-2 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-blue-600 dark:bg-blue-400"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => handleSelectBot(b.id)}
                      aria-current={isActive ? "true" : undefined}
                      className={cn(
                        "w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
                        isActive
                          ? "bg-sky-50 font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                          : "text-foreground/80 hover:bg-muted",
                      )}
                    >
                      <span className="relative shrink-0">
                        <BotAvatar avatar={b.avatar} size="xs" />
                        {b.is_default && <PrimaryStar className="-bottom-1 -right-1" />}
                        {b.busy ? (
                          <ThoughtCloud className="-right-3 -top-2" label={`${b.name} is responding`} />
                        ) : (
                          b.unread && !isActive && <UnreadDot className="h-2 w-2" />
                        )}
                      </span>
                      {/* Long names wrap rather than truncate. */}
                      <span className="min-w-0 break-words leading-snug">{b.name}</span>
                      {b.is_default && <span className="sr-only">(primary bot)</span>}
                      {b.unread && !isActive && <span className="sr-only">(new messages)</span>}
                    </button>
                  </li>
                );
              })}
            </ul>

            {hiddenBots.length > 0 && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="mt-0.5 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                data-testid="sidebar-bot-show-more"
              >
                {expanded ? "Show less" : `Show more (+${hiddenBots.length})`}
                {!expanded && hiddenBots.some((b) => b.busy || b.unread) && (
                  <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                    {hiddenBots.some((b) => b.busy) ? (
                      <ThoughtCloud className="-right-2 -top-2" label="A hidden bot is responding" />
                    ) : (
                      <>
                        <UnreadDot className="h-2 w-2" />
                        <span className="sr-only">(new messages in collapsed bots)</span>
                      </>
                    )}
                  </span>
                )}
              </button>
            )}
          </section>
          <SidebarPagesNav onNavigate={() => onNavigate?.("page")} />
        </div>
      </ScrollArea>
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
            void refreshBots().then(() => handleSelectBot(saved.id));
          }}
        />
      )}
    </aside>
  );
}
