'use client';

import { useEffect, useState } from 'react';
import { Check, Loader2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { saveCardDecision } from '@/lib/api/chatCards';
import type { ActionCardDecisionStatus } from '@/lib/chat/actionCards';
import { useActionCardDecision } from './ActionCardDecisions';
import { useOptionalChatThread } from './ChatProvider';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type ApprovalStatus = 'idle' | 'submitting' | 'resolved';

export interface UseApprovalResolutionReturn {
  status: ApprovalStatus;
  setStatus: React.Dispatch<React.SetStateAction<ApprovalStatus>>;
  resolutionText: string | null;
  setResolutionText: React.Dispatch<React.SetStateAction<string | null>>;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  isResolved: boolean;
  isSubmitting: boolean;
  /** The stored decision's detail (what was picked, the row created, …), once decided. */
  decisionData: Record<string, unknown> | null;
  /**
   * Show the card as decided and record the decision in the database, where
   * it follows the user to other devices and reaches the agent's next turns.
   */
  resolve: (
    text: string,
    status: ActionCardDecisionStatus,
    data?: Record<string, unknown> | null,
  ) => void;
}

/**
 * Where each card kept its resolution text before decisions were stored in
 * the database. Read only, so a card resolved back then does not offer its
 * buttons again; never written.
 */
const LEGACY_STORAGE_PREFIX: Readonly<Record<string, string>> = {
  propose_bulk_drop_companies: 'bulk_drop_resolved_',
  propose_bulk_promote_companies: 'bulk_promote_resolved_',
  propose_create_bot: 'bot_change_resolved_',
  update_bot: 'bot_change_resolved_',
  propose_create_routine: 'bot_routine_resolved_',
  propose_insight_create: 'insight_create_resolved_',
  propose_insight_edit: 'insight_edit_resolved_',
  propose_insight_refresh: 'insight_refresh_resolved_',
  propose_report_plan: 'report_plan_resolved_',
  offer_options: 'option_card_',
};

function legacyResolution(card: { cardId: string | null | undefined; toolName: string } | null): string | null {
  const prefix = card ? LEGACY_STORAGE_PREFIX[card.toolName] : undefined;
  if (!prefix || !card?.cardId || typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(`${prefix}${card.cardId}`);
  } catch {
    return null;
  }
}

/**
 * A card's decision state, stored in `copilot_chat_cards` (not the browser):
 * starts from the decision the history page laid onto the card, and `resolve`
 * writes the user's decision. `card` is null for a card with no id to key it
 * on; it then resolves on screen only.
 */
export function useApprovalResolution(
  card: { cardId: string | null | undefined; toolName: string } | null,
): UseApprovalResolutionReturn {
  const cardId = card?.cardId ?? null;
  const stored = useActionCardDecision(cardId);
  const chatId = useOptionalChatThread()?.chatId ?? null;
  const [legacy] = useState(() => (stored ? null : legacyResolution(card)));
  const [status, setStatus] = useState<ApprovalStatus>(() =>
    stored || legacy ? 'resolved' : 'idle',
  );
  const [resolutionText, setResolutionText] = useState<string | null>(
    stored?.resolutionText ?? legacy,
  );
  const [decisionData, setDecisionData] = useState<Record<string, unknown> | null>(
    stored?.data ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  // A decision that arrives after mount (the history page reloaded with it).
  useEffect(() => {
    if (!stored) return;
    setStatus((prev) => (prev === 'idle' ? 'resolved' : prev));
    setResolutionText((prev) => prev ?? stored.resolutionText);
    setDecisionData((prev) => prev ?? stored.data);
  }, [stored]);

  const resolve: UseApprovalResolutionReturn['resolve'] = (text, decision, data = null) => {
    setResolutionText(text);
    setDecisionData(data);
    setStatus('resolved');
    if (!cardId || !card || !chatId) return;
    saveCardDecision(chatId, cardId, {
      toolName: card.toolName,
      status: decision,
      resolutionText: text,
      data,
    })
      .then((saved) => {
        // Decided first elsewhere: show the decision that stands.
        if (saved.alreadyDecided) {
          setResolutionText(saved.decision.resolutionText);
          setDecisionData(saved.decision.data);
        }
      })
      .catch((err: unknown) => {
        console.error('[chat] failed to save the card decision:', err);
        toast.warning('Your decision was applied but could not be saved', {
          description: 'Other devices and the assistant may not see it.',
        });
      });
  };

  return {
    status,
    setStatus,
    resolutionText,
    setResolutionText,
    error,
    setError,
    isResolved: status === 'resolved',
    isSubmitting: status === 'submitting',
    decisionData,
    resolve,
  };
}

export interface ApprovalCardShellProps {
  testId?: string;
  className?: string;
  isResolved: boolean;
  isSubmitting: boolean;
  resolutionText: string | null;
  error?: string | null;
  errorTitle?: string;
  errorDescription?: React.ReactNode;
  resolvedBgClassName?: string;
  resolvedBannerBorderClassName?: string;
  tagIcon: React.ReactNode;
  tagLabel: string;
  onReject: () => void;
  onApprove: () => void;
  rejectLabel?: string;
  approveLabel: React.ReactNode;
  submittingLabel: string;
  rejectTestId?: string;
  approveTestId?: string;
  approveDisabled?: boolean;
  children: React.ReactNode;
}

export function ApprovalCardShell({
  testId,
  className,
  isResolved,
  isSubmitting,
  resolutionText,
  error,
  errorTitle,
  errorDescription,
  resolvedBgClassName,
  resolvedBannerBorderClassName,
  tagIcon,
  tagLabel,
  onReject,
  onApprove,
  rejectLabel = 'Reject',
  approveLabel,
  submittingLabel,
  rejectTestId,
  approveTestId,
  approveDisabled,
  children,
}: ApprovalCardShellProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'w-full rounded-2xl border shadow-sm overflow-hidden transition-colors',
        isResolved
          ? cn('border-border', resolvedBgClassName ?? 'bg-card')
          : 'border-indigo-200 dark:border-indigo-900 bg-card',
        className,
      )}
    >
      <div
        className={cn(
          'h-1 w-full',
          isResolved
            ? 'bg-emerald-500'
            : 'bg-gradient-to-r from-indigo-500 to-sky-600',
        )}
      />

      <div className="p-5">
        <div
          className={cn(
            'inline-flex items-center gap-1.5 text-[11px] font-bold tracking-wider uppercase mb-2 transition-colors',
            isResolved
              ? 'text-muted-foreground'
              : 'text-indigo-700 dark:text-indigo-400',
          )}
        >
          {isResolved ? (
            <Check className="h-3.5 w-3.5 text-emerald-600" />
          ) : (
            tagIcon
          )}
          {isResolved ? 'Resolved' : tagLabel}
        </div>

        {children}

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-destructive bg-card p-3 text-xs text-destructive flex items-start gap-2 mb-4"
          >
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <span className="font-semibold">{errorTitle ?? 'Error: '}</span>
              <span>{error}</span>
              {errorDescription}
            </div>
          </div>
        )}

        {isResolved ? (
          <div
            className={cn(
              'flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400 rounded-lg border bg-card px-3 py-2',
              resolvedBannerBorderClassName ?? 'border-emerald-200 dark:border-emerald-800',
            )}
          >
            <Check className="h-4 w-4" />
            <span>{resolutionText}</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <Button
              data-testid={rejectTestId}
              variant="outline"
              onClick={onReject}
              disabled={isSubmitting}
              className="bg-card text-foreground border-border hover:bg-muted"
            >
              {rejectLabel}
            </Button>
            <Button
              data-testid={approveTestId}
              onClick={onApprove}
              disabled={approveDisabled ?? isSubmitting}
              className="bg-gradient-to-r from-emerald-600 to-teal-700 hover:from-emerald-700 hover:to-teal-800 text-white"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  {submittingLabel}
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 mr-1.5" />
                  {approveLabel}
                </>
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
