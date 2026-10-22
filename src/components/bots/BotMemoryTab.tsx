"use client";

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { getBotMemory, saveBotMemory } from '@/lib/api/bots';
import {
  BOT_MEMORY_MAX_NOTES,
  BOT_MEMORY_NOTE_MAX_LENGTH,
  type BotMemoryNote,
} from '@/lib/bots/memoryTypes';
import type { BotDto } from '@/lib/bots/types';

function dateLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * What the bot remembers about the signed-in user: their own notes on it,
 * listed with a delete each and a box to add one. The bot writes the same
 * list when the user tells it to remember something in its chat. Nobody
 * else sees these; the persona on the Settings tab is the bot for everyone.
 */
export function BotMemoryTab({ bot }: { bot: BotDto }) {
  const [notes, setNotes] = useState<BotMemoryNote[] | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getBotMemory(bot.id)
      .then((data) => {
        if (!cancelled) setNotes(data.notes);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setNotes([]);
        toast.error((err as Error).message || 'Could not load the memory');
      });
    return () => {
      cancelled = true;
    };
  }, [bot.id]);

  const persist = useCallback(
    async (texts: string[]): Promise<boolean> => {
      setSaving(true);
      try {
        const data = await saveBotMemory(bot.id, texts);
        setNotes(data.notes);
        return true;
      } catch (err: unknown) {
        toast.error((err as Error).message || 'Could not save the memory');
        return false;
      } finally {
        setSaving(false);
      }
    },
    [bot.id],
  );

  const add = async () => {
    const text = draft.trim();
    if (!text || !notes) return;
    if (await persist([...notes.map((n) => n.text), text])) setDraft('');
  };

  const remove = (index: number) => {
    if (!notes) return;
    void persist(notes.filter((_, i) => i !== index).map((n) => n.text));
  };

  const full = (notes?.length ?? 0) >= BOT_MEMORY_MAX_NOTES;

  return (
    <div className="space-y-4" data-testid="bot-memory-tab">
      <p className="text-sm text-muted-foreground">
        What {bot.name} remembers about you: your preferences and standing requests for it. Only you
        see these, and they shape its answers to you alone. Tell it in its chat
        (&ldquo;remember that…&rdquo;) or add one here.
      </p>

      {notes === null ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : notes.length === 0 ? (
        <div className="rounded-md border bg-muted p-4 text-sm text-muted-foreground" data-testid="bot-memory-empty">
          Nothing yet.
        </div>
      ) : (
        <ul className="divide-y rounded-md border bg-card" data-testid="bot-memory-list">
          {notes.map((note, i) => (
            <li key={`${note.created_at}-${i}`} className="flex items-start gap-3 px-3 py-2">
              <p className="min-w-0 flex-1 break-words text-sm">{note.text}</p>
              <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">{dateLabel(note.created_at)}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={`Forget "${note.text}"`}
                title="Forget"
                disabled={saving}
                onClick={() => remove(i)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="space-y-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Label htmlFor="bot-memory-draft">Add a note</Label>
        <div className="flex gap-2">
          <Input
            id="bot-memory-draft"
            value={draft}
            maxLength={BOT_MEMORY_NOTE_MAX_LENGTH}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Remind me about stalled deals on Fridays"
            disabled={notes === null || saving || full}
            data-testid="bot-memory-draft"
          />
          <Button type="submit" disabled={!draft.trim() || notes === null || saving || full} className="gap-1.5">
            <Plus className="h-4 w-4" />
            Remember
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {notes?.length ?? 0} / {BOT_MEMORY_MAX_NOTES} notes
          {full ? ' — forget one to add another.' : ''}
        </p>
      </form>
    </div>
  );
}
