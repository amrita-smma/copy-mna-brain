"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { AtSign, CalendarClock, ListChecks, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { listBotTasks } from '@/lib/api/bots';
import type { BotTaskDto, BotTaskSource } from '@/lib/bots/taskLogTypes';
import type { BotDto } from '@/lib/bots/types';

const SOURCE_META: Record<BotTaskSource, { icon: typeof MessageSquare; label: string }> = {
  chat: { icon: MessageSquare, label: 'Chat' },
  mention: { icon: AtSign, label: '@mention' },
  routine: { icon: CalendarClock, label: 'Routine' },
};

function dayLabel(iso: string): string {
  const day = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return 'Today';
  if (day.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return day.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function groupByDay(tasks: BotTaskDto[]): { day: string; tasks: BotTaskDto[] }[] {
  const groups: { day: string; tasks: BotTaskDto[] }[] = [];
  for (const task of tasks) {
    const day = dayLabel(task.created_at);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.tasks.push(task);
    else groups.push({ day, tasks: [task] });
  }
  return groups;
}

/**
 * What the bot has done, newest first, one line per task: tasks from the
 * user's own chats with it, @mentions handed to it, and its routine runs
 * (on a shared bot, everyone's routine runs — other people's chats stay
 * private). Picking a task opens the bot's chat.
 */
export function BotTaskLogTab({ bot, onOpenChat }: { bot: BotDto; onOpenChat?: () => void }) {
  const [tasks, setTasks] = useState<BotTaskDto[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Drops a slow earlier first load that lands after a newer one.
  const loadSeqRef = useRef(0);

  const loadFirst = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    try {
      const page = await listBotTasks(bot.id);
      if (seq !== loadSeqRef.current) return;
      setTasks(page.items);
      setCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setError((err as Error).message || 'Could not load the task log');
    }
  }, [bot.id]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listBotTasks(bot.id, cursor);
      setTasks((prev) => [...(prev ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError((err as Error).message || 'Could not load more tasks');
    } finally {
      setLoadingMore(false);
    }
  };

  if (error && tasks === null) {
    return <p className="rounded-md border bg-card px-3 py-4 text-sm text-destructive">{error}</p>;
  }
  if (tasks === null) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-10 rounded-md" />
        ))}
      </div>
    );
  }
  if (tasks.length === 0) {
    return (
      <div
        className="rounded-lg border border-dashed bg-card px-4 py-8 text-center text-sm text-muted-foreground"
        data-testid="bot-task-log-empty"
      >
        <ListChecks className="mx-auto mb-2 h-5 w-5" />
        No tasks yet. Each task {bot.name} does — in your chat, for an @mention, or for a routine — is listed here in
        one line.
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="bot-task-log">
      {groupByDay(tasks).map((group) => (
        <section key={group.day}>
          <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group.day}</h3>
          <ul className="divide-y rounded-lg border bg-card">
            {group.tasks.map((task) => {
              const { icon: Icon, label } = SOURCE_META[task.source];
              return (
                <li key={task.id}>
                  <button
                    type="button"
                    onClick={onOpenChat}
                    disabled={!onOpenChat}
                    className="flex w-full items-start gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-label={label} />
                    <span className="min-w-0 flex-1">
                      <span className="block">{task.summary}</span>
                      {(task.routine_title || !task.is_mine) && (
                        <span className="block text-xs text-muted-foreground">
                          {task.routine_title ? `Routine · ${task.routine_title}` : null}
                          {task.routine_title && !task.is_mine ? ' · ' : null}
                          {!task.is_mine ? 'ran for a teammate' : null}
                        </span>
                      )}
                    </span>
                    <time
                      dateTime={task.created_at}
                      className="shrink-0 text-xs tabular-nums text-muted-foreground"
                    >
                      {new Date(task.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                    </time>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {cursor && (
        <div className="flex justify-center">
          <Button size="sm" variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load older tasks'}
          </Button>
        </div>
      )}
    </div>
  );
}
