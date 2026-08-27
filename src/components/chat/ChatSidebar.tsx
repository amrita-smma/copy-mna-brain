"use client";

import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useChatContext } from "./ChatProvider";
import { useLayoutControl } from "@/components/layout/LayoutControlContext";
import {
  SidebarCollapsibleSection,
  useSidebarSectionOpen,
} from "@/components/layout/SidebarCollapsibleSection";
import { SidebarPagesNav } from "@/components/layout/SidebarPagesNav";

const NEW_CHAT_LABEL = "Untitled chat";

function ChatTitle({ label }: { label: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOverflows(el.scrollWidth > el.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [label]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span ref={ref} className="flex-1 min-w-0 truncate">
          {label}
        </span>
      </TooltipTrigger>
      {overflows && <TooltipContent side="right">{label}</TooltipContent>}
    </Tooltip>
  );
}

/**
 * The expanded sidebar's body: "New Chat", then the app's pages as collapsible
 * sections (Deal Flow, Intelligence), then Chat History.
 *
 * The pages and the chat list used to be two tabs of a strip at the top of this
 * panel, which made them mutually exclusive — opening a page meant losing sight
 * of the conversation list, and the tab you weren't on was invisible. Sections
 * put all of it on one scrollable surface and let the user fold away whatever
 * they don't use; each section remembers its own open/closed state.
 */
export function ChatSidebar({
  className,
  onNavigate,
}: {
  className?: string;
  /** Called after the user starts a new chat, selects an existing one, or opens
   *  a page. Used by the mobile drawer to close itself once something is
   *  chosen; the argument tells it whether the choice keeps the user in the chat
   *  (so the composer should keep the caret) or navigates away from it. */
  onNavigate?: (target: "chat" | "page") => void;
}) {
  const { chatId, setChatId, newChat, chats } = useChatContext();
  // Starting or opening a conversation should put the copilot in front of the
  // user. A no-op outside the app shell (and on mobile, where the copilot is
  // already full-screen whenever this list is reachable).
  const { expandCopilot } = useLayoutControl();
  // Owned here rather than inside the section so starting a chat can force the
  // list open — otherwise a user who folded Chat History away would click "New
  // Chat" and see nothing happen in the sidebar. (The old tab strip solved the
  // same problem by switching itself back to History.)
  const [historyOpen, setHistoryOpen] = useSidebarSectionOpen("chat-history");

  const handleNewChat = () => {
    newChat();
    expandCopilot();
    setHistoryOpen(true);
    onNavigate?.("chat");
  };

  const handleSelect = (id: string) => {
    setChatId(id);
    expandCopilot();
    onNavigate?.("chat");
  };

  return (
    <aside
      className={cn(
        "flex flex-col w-64 border-r bg-background/40 min-h-0",
        className,
      )}
    >
      <div className="p-3 border-b flex-shrink-0">
        <Button
          onClick={handleNewChat}
          variant="default"
          className="w-full gap-2 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-700 hover:to-blue-600"
        >
          <MessageSquarePlus className="h-4 w-4" />
          New Chat
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0 [&>[data-radix-scroll-area-viewport]>div]:!block">
        <div className="flex flex-col gap-1 py-2">
          <SidebarPagesNav onNavigate={() => onNavigate?.("page")} />
          <SidebarCollapsibleSection
            id="chat-history"
            label="Chat History"
            open={historyOpen}
            onOpenChange={setHistoryOpen}
          >
            <ul className="space-y-0.5">
              {chats.length === 0 && (
                <li className="px-3 py-4 text-center text-xs text-muted-foreground">
                  No chats yet. Start a new conversation.
                </li>
              )}
              {chats.map((c) => {
                const isActive = c.id === chatId;
                const label = c.title?.trim() || NEW_CHAT_LABEL;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => handleSelect(c.id)}
                      className={cn(
                        "w-full flex items-start gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors",
                        isActive
                          ? "bg-blue-500/10 text-blue-700 dark:text-blue-300"
                          : "hover:bg-muted text-foreground/80",
                      )}
                    >
                      <MessageSquare className="h-4 w-4 mt-0.5 flex-shrink-0 opacity-70" />
                      <ChatTitle label={label} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </SidebarCollapsibleSection>
        </div>
      </ScrollArea>
    </aside>
  );
}
