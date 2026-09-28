'use client';

import { useState } from 'react';
import { Check, Loader2, AlertCircle } from 'lucide-react';
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
  resolve: (text: string) => void;
}

function getStoredResolution(storageKey: string | null | undefined): string | null {
  if (!storageKey || typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

export function useApprovalResolution(
  storageKey: string | null | undefined,
): UseApprovalResolutionReturn {
  const [stored] = useState(() => getStoredResolution(storageKey));
  const [status, setStatus] = useState<ApprovalStatus>(() =>
    stored ? 'resolved' : 'idle',
  );
  const [resolutionText, setResolutionText] = useState<string | null>(stored);
  const [error, setError] = useState<string | null>(null);

  const resolve = (text: string) => {
    setResolutionText(text);
    setStatus('resolved');
    if (storageKey && typeof window !== 'undefined') {
      try {
        localStorage.setItem(storageKey, text);
      } catch {
        // ignore
      }
    }
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
