'use client';

import { useRef, useState } from 'react';
import { Check, CornerDownLeft, ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { optionAnswerText, type OptionCardPayload } from '@/lib/chat/optionCards';
import { useApprovalResolution } from './ApprovalCardShell';
import { useChatActions, useChatStatus } from './ChatProvider';

/**
 * Clickable choices a bot offered (`offer_options`). Single choice sends on
 * click; multi choice sends the ticked options; a custom answer sends what the
 * user typed (alongside any ticks). The pick goes back as the user's next
 * message, and the card then shows what was chosen — remembered across
 * reloads, like the approval cards.
 */
export function OptionCard({ payload, className }: { payload: OptionCardPayload; className?: string }) {
  const { sendMessage } = useChatActions();
  const { status: chatStatus } = useChatStatus();
  const { resolutionText, isResolved, isSubmitting, setStatus, resolve, error, setError } = useApprovalResolution(
    `option_card_${payload.card_id}`,
  );
  const [ticked, setTicked] = useState<string[]>([]);
  const [custom, setCustom] = useState('');
  const submittingRef = useRef(false);
  const multi = payload.mode === 'multi';
  // The chat is still answering: a pick now would start a second turn mid-stream.
  const chatBusy = chatStatus === 'streaming' || chatStatus === 'submitted';
  const locked = isResolved || isSubmitting || chatBusy;

  const submit = async (picked: string[], own?: string) => {
    const text = optionAnswerText(payload, picked, own);
    if (!text || locked || submittingRef.current) return;
    submittingRef.current = true;
    setStatus('submitting');
    setError(null);
    try {
      await sendMessage({ text });
      resolve([...picked, own?.trim()].filter(Boolean).join(', '));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send your answer');
      setStatus('idle');
      submittingRef.current = false;
    }
  };

  const toggle = (label: string, on: boolean) =>
    setTicked((prev) => (on ? [...prev, label] : prev.filter((l) => l !== label)));

  return (
    <div
      className={cn('w-full rounded-2xl border bg-card p-4 shadow-sm', className)}
      data-testid="option-card"
      data-mode={payload.mode}
    >
      <div className="mb-3 flex items-start gap-2">
        <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{payload.question}</p>
          {!isResolved && multi && <p className="text-xs text-muted-foreground">Pick any that apply.</p>}
        </div>
      </div>

      {isResolved ? (
        <p className="flex items-center gap-2 rounded-lg border bg-muted px-3 py-2 text-sm" data-testid="option-card-answer">
          <Check className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span className="min-w-0">
            <span className="text-muted-foreground">You chose </span>
            <span className="font-medium text-foreground">{resolutionText}</span>
          </span>
        </p>
      ) : (
        <>
          <div className={cn('grid gap-2', payload.options.length > 2 && 'sm:grid-cols-2')} role={multi ? 'group' : undefined}>
            {payload.options.map((option) =>
              multi ? (
                <label
                  key={option.label}
                  className={cn(
                    'flex cursor-pointer items-start gap-2.5 rounded-xl border bg-muted p-3 text-left transition-colors hover:border-foreground/30',
                    ticked.includes(option.label) && 'border-primary',
                    locked && 'cursor-default opacity-70',
                  )}
                >
                  <Checkbox
                    checked={ticked.includes(option.label)}
                    onCheckedChange={(v) => toggle(option.label, v === true)}
                    disabled={locked}
                    className="mt-0.5"
                  />
                  <OptionText option={option} />
                </label>
              ) : (
                <button
                  key={option.label}
                  type="button"
                  disabled={locked}
                  onClick={() => void submit([option.label])}
                  className="flex items-start gap-2.5 rounded-xl border bg-muted p-3 text-left transition-colors hover:border-primary hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-70 disabled:hover:border-border disabled:hover:bg-muted"
                  data-testid="option-card-option"
                >
                  <OptionText option={option} />
                </button>
              ),
            )}
          </div>

          {(payload.allow_custom || multi) && (
            <form
              className="mt-3 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void submit(multi ? ticked : [], custom);
              }}
            >
              {payload.allow_custom && (
                <Input
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  disabled={locked}
                  placeholder={multi ? 'Add your own (optional)…' : 'Or type your own answer…'}
                  aria-label="Your own answer"
                  className="h-9 bg-background text-sm"
                  data-testid="option-card-custom"
                />
              )}
              <Button
                type="submit"
                size="sm"
                disabled={locked || (multi ? ticked.length === 0 && !custom.trim() : !custom.trim())}
                className={cn('shrink-0 gap-1.5', !payload.allow_custom && 'ml-auto')}
                data-testid="option-card-send"
              >
                {isSubmitting ? 'Sending…' : 'Send'}
                <CornerDownLeft className="h-3.5 w-3.5" />
              </Button>
            </form>
          )}
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </>
      )}
    </div>
  );
}

function OptionText({ option }: { option: OptionCardPayload['options'][number] }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
        {option.label}
        {option.recommended && (
          <span className="rounded border bg-card px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recommended
          </span>
        )}
      </span>
      {option.description && <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>}
    </span>
  );
}
