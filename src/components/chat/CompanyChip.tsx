'use client';

import { ArrowUpRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { companyDisplayName } from '@/lib/companyDisplay';
import { companyDetailPath, companyLinkId, type CompanyRef } from '@/lib/navigation/companyPath';
import { useLayoutControl } from '@/components/layout/LayoutControlContext';
import posthog from 'posthog-js';
import { CHAT_NAVIGATION_CLICKED, chatNavigationProperties } from '@/lib/posthog-chat';
import { cn } from '@/lib/utils';

/**
 * A company mentioned in the chat, rendered as a chip that opens the company.
 *
 * Falls back to an inert badge when the mention carries no id — a file's
 * `matched_companies` can hold bare name strings, and the model can name a
 * company that isn't in the pipeline. Those must not render as links to
 * nowhere.
 *
 * Clicking docks the copilot first (`revealConsole`), so the company page is on
 * screen when the user arrives instead of loading behind an expanded chat.
 */
export function CompanyChip({
  company,
  prefix,
  className,
}: {
  /** A company row, a `matched_companies` entry, or a bare name. */
  company: string | CompanyRef | null | undefined;
  /**
   * Verb shown before the name, e.g. `"Open"`. Use it where the chip stands on
   * its own as a call to action; omit it in a list already labelled as
   * companies, where repeating the verb on every row is just noise.
   */
  prefix?: string;
  className?: string;
}) {
  const { revealConsole } = useLayoutControl();

  const label =
    typeof company === 'string' ? company : companyDisplayName(company, 'Unknown company');
  const companyId = companyLinkId(company);

  if (!companyId) {
    return (
      <Badge variant="outline" className={cn('text-xs', className)}>
        {label}
      </Badge>
    );
  }

  const href = companyDetailPath(companyId);

  return (
    <WorkspaceLink
      href={href}
      onClick={() => {
        posthog.capture(
          CHAT_NAVIGATION_CLICKED,
          chatNavigationProperties({
            source: 'company_chip',
            path: href,
            companyId,
            label,
          }),
        );
        revealConsole();
      }}
      // The whole chip is one link rather than a label with a nested button:
      // a bigger click target, and one tab stop instead of two.
      aria-label={`Open ${label}`}
      title={`Open ${label}`}
      className={cn(
        'group/company inline-flex max-w-full items-center gap-1 rounded-full',
        'border border-blue-500/30 bg-blue-500/5 py-0.5 pl-2 pr-1',
        'text-xs font-medium text-blue-700 transition-colors',
        'hover:border-blue-500/50 hover:bg-blue-500/10 dark:text-blue-300',
        className,
      )}
    >
      <span className="truncate">
        {prefix ? `${prefix} ${label}` : label}
      </span>
      {/* An explicit navigate affordance next to the name. Without it a chip
          reads as a passive tag, and the fact that a company can be opened from
          the chat isn't discoverable. */}
      <span
        aria-hidden
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
          'bg-blue-500/15 transition-colors group-hover/company:bg-blue-500/30',
        )}
      >
        <ArrowUpRight className="h-3 w-3" />
      </span>
    </WorkspaceLink>
  );
}

/**
 * The bare "navigate to company" button, for places that already render the
 * company's name themselves — the bulk drop/promote approval cards.
 *
 * `stopPropagation` is load-bearing: these cards put each company in a row that
 * toggles its selection on click, so without it, opening a company would also
 * flip that company in or out of a pending drop or promotion.
 */
export function CompanyNavigateButton({
  companyId,
  label,
  className,
}: {
  companyId: string;
  /** Company name, for the accessible label. */
  label: string;
  className?: string;
}) {
  const { revealConsole } = useLayoutControl();

  const href = companyDetailPath(companyId);

  return (
    <WorkspaceLink
      href={href}
      aria-label={`Open ${label}`}
      title={`Open ${label}`}
      onClick={(event) => {
        event.stopPropagation();
        posthog.capture(
          CHAT_NAVIGATION_CLICKED,
          chatNavigationProperties({
            source: 'bulk_card',
            path: href,
            companyId,
            label,
          }),
        );
        revealConsole();
      }}
      className={cn(
        'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
        'bg-blue-500/15 text-blue-700 transition-colors',
        'hover:bg-blue-500/35 dark:text-blue-300',
        className,
      )}
    >
      <ArrowUpRight className="h-3 w-3" />
    </WorkspaceLink>
  );
}
