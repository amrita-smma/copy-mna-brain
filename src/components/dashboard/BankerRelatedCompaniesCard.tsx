'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { AskAIButton } from '@/components/chat/AskAIButton';
import { getBankerRelatedCompanies } from '@/lib/api/bankerRelatedCompanies';
import type { BankerRelatedCompaniesRow } from '@/lib/services/crmService';
import { nameInitials } from '@/lib/companyDisplay';
import { Handshake, ChevronRight, Loader2 } from 'lucide-react';

/** Top-N bankers shown in the compact dashboard card; the full ranking lives on
 * the Banker Related Companies page. */
const TOP_N = 6;

const AVATAR_TINTS = [
  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
];

function avatarTint(name: string): string {
  return AVATAR_TINTS[(name.charCodeAt(0) || 0) % AVATAR_TINTS.length];
}

/**
 * Compact dashboard card ranking bankers by how many related companies are
 * attached to each. Self-fetching (this is CRM data, kept out of the pipeline
 * insights payload) and links to the full Banker Related Companies page.
 */
export function BankerRelatedCompaniesCard({ onAsk }: { onAsk?: () => void }) {
  const [rows, setRows] = useState<BankerRelatedCompaniesRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    getBankerRelatedCompanies({ limit: TOP_N })
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
            <div className="space-y-2">
              {rows.map((r) => (
                <div key={r.employerId} className="flex items-center gap-2.5">
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
                </div>
              ))}
            </div>
            <div className="pt-3">
              <WorkspaceLink
                href="/banker-related-companies"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                View all bankers <ChevronRight className="h-3.5 w-3.5" />
              </WorkspaceLink>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
