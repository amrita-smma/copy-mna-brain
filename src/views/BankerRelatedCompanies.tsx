'use client';

import { useEffect, useMemo, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getBankerRelatedCompanies } from '@/lib/api/bankerRelatedCompanies';
import type { BankerRelatedCompaniesRow } from '@/lib/services/crmService';
import { nameInitials } from '@/lib/companyDisplay';
import { Handshake, Loader2 } from 'lucide-react';

interface BankerRelatedCompaniesProps {
  showCompanyGraph?: boolean;
}

/** Deterministic avatar tint per banker, keyed off the name's first char.
 * Mirrors the dashboard's banker avatars so the two surfaces read alike. */
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

function formatLastSeen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function BankerRelatedCompanies({
  showCompanyGraph = false,
}: BankerRelatedCompaniesProps) {
  const [rows, setRows] = useState<BankerRelatedCompaniesRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setError(false);
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

  const maxCount = useMemo(
    () => (rows && rows.length ? Math.max(...rows.map((r) => r.relatedCompanyCount), 1) : 1),
    [rows],
  );

  return (
    <DashboardLayout showCompanyGraph={showCompanyGraph}>
      <div className="p-6 lg:p-8 space-y-6 animate-fade-in">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Handshake className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Banker related companies</h1>
            <p className="text-sm text-muted-foreground">
              Bankers ranked by the number of related companies attached to them.
            </p>
          </div>
        </div>

        <Card className="border bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">
              Ranking{rows ? ` · ${rows.length} banker${rows.length === 1 ? '' : 's'}` : ''}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {error ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Could not load banker related companies.
              </p>
            ) : rows == null ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : rows.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                No related companies are linked to any banker yet.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-12 text-xs uppercase tracking-wide text-muted-foreground">
                      #
                    </TableHead>
                    <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                      Banker
                    </TableHead>
                    <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                      Related companies
                    </TableHead>
                    <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                      In Master Data
                    </TableHead>
                    <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                      Last activity
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => (
                    <TableRow key={r.employerId} className="hover:bg-muted/40">
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {i + 1}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <span
                            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9.5px] font-bold ${avatarTint(
                              r.employerName,
                            )}`}
                          >
                            {nameInitials(r.employerName, '—')}
                          </span>
                          <span className="text-sm font-medium">{r.employerName}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="h-2 w-32 overflow-hidden rounded bg-muted">
                            <div
                              className="h-full rounded bg-primary/70"
                              style={{ width: `${(r.relatedCompanyCount / maxCount) * 100}%` }}
                            />
                          </div>
                          <span className="font-mono text-sm font-semibold tabular-nums">
                            {r.relatedCompanyCount}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {r.matchedCompanyCount}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {formatLastSeen(r.lastSeenAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
