"use client";

import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useChatContext } from "./ChatProvider";

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

export function ChatSidebar({ className }: { className?: string }) {
  const { chatId, setChatId, newChat, chats } = useChatContext();

  return (
    <aside
      className={cn(
        "flex flex-col w-64 border-r bg-background/40 min-h-0",
        className,
      )}
    >
      <div className="p-3 border-b flex-shrink-0">
        <Button
          onClick={newChat}
          variant="default"
          className="w-full gap-2 bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-700 hover:to-purple-600"
        >
          <MessageSquarePlus className="h-4 w-4" />
          New Chat
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0 [&>[data-radix-scroll-area-viewport]>div]:!block">
        <ul className="p-2 space-y-1">
          {chats.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-muted-foreground">
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
                  onClick={() => setChatId(c.id)}
                  className={cn(
                    "w-full flex items-start gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                    isActive
                      ? "bg-purple-500/10 text-purple-700 dark:text-purple-300"
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
      </ScrollArea>
    </aside>
  );
}
