'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { AskAIButton } from '@/components/chat/AskAIButton';
import { getBankerRelatedCompanies } from '@/lib/api/bankerRelatedCompanies';
import type { BankerRelatedCompaniesRow } from '@/lib/services/crmService';
import { nameInitials } from '@/lib/companyDisplay';
import { Handshake, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

/** Bankers shown per page in the card. */
const PAGE_SIZE = 6;

const AVATAR_TINTS = [
  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
];

function avatarTint(name: string): string {
  return AVATAR_TINTS[(name.charCodeAt(0) || 0) % AVATAR_TINTS.length];
}

/** Deep-link into the CRM with a specific banker (employer) opened: `firm`
 * seeds the CRM search so the row surfaces in the filtered list, `employerId`
 * tells the CRM which card to auto-expand. */
function crmHref(row: BankerRelatedCompaniesRow): string {
  const params = new URLSearchParams({
    employerId: row.employerId,
    firm: row.employerName,
  });
  return `/crm?${params.toString()}`;
}

/**
 * Compact dashboard card ranking bankers by how many related companies are
 * attached to each. Self-fetching (this is CRM data, kept out of the pipeline
 * insights payload), paginated in place, and each banker links straight into
 * the CRM with that firm's card opened.
 */
export function BankerRelatedCompaniesCard({ onAsk }: { onAsk?: () => void }) {
  const [rows, setRows] = useState<BankerRelatedCompaniesRow[] | null>(null);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let active = true;
    getBankerRelatedCompanies()
      .then((data) => {
        if (active) setRows(data);
      })
      .catch((err) => {
        console.error('Failed to load banker related companies', err);
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const max = rows && rows.length ? Math.max(...rows.map((r) => r.relatedCompanyCount), 1) : 1;
  const totalPages = rows ? Math.max(1, Math.ceil(rows.length / PAGE_SIZE)) : 1;
  const pageRows = useMemo(
    () => (rows ? rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE) : []),
    [rows, page],
  );

  return (
    <Card className="border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Handshake className="h-4 w-4 text-muted-foreground" /> Banker related companies
          </CardTitle>
          {onAsk && (
            <AskAIButton label="Analyze banker related companies with AI" onClick={onAsk} />
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">Bankers ranked by companies attached</p>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Could not load banker related companies.
          </p>
        ) : rows == null ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No related companies linked to bankers yet.
          </p>
        ) : (
          <>
            <div className="space-y-1">
              {pageRows.map((r) => (
                <WorkspaceLink
                  key={r.employerId}
                  href={crmHref(r)}
                  title={`Open ${r.employerName} in CRM`}
                  className="flex items-center gap-2.5 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/60"
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9.5px] font-bold ${avatarTint(
                      r.employerName,
                    )}`}
                  >
                    {nameInitials(r.employerName, '—')}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {r.employerName}
                  </span>
                  <div className="hidden h-1.5 w-20 shrink-0 overflow-hidden rounded bg-muted sm:block">
                    <div
                      className="h-full rounded bg-primary/70"
                      style={{ width: `${(r.relatedCompanyCount / max) * 100}%` }}
                    />
                  </div>
                  <span className="w-8 shrink-0 text-right font-mono text-xs font-semibold tabular-nums">
                    {r.relatedCompanyCount}
                  </span>
                </WorkspaceLink>
              ))}
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-3">
                <span className="text-[11px] text-muted-foreground">
                  {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, rows.length)} of{' '}
                  {rows.length}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    aria-label="Previous page"
                    className="inline-flex h-6 w-6 items-center justify-center rounded border text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    aria-label="Next page"
                    className="inline-flex h-6 w-6 items-center justify-center rounded border text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
