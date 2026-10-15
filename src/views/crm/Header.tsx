"use client";

import { PageHeader } from "@/components/layout/PageHeader";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, Inbox, Mail } from "lucide-react";
import type { Insights } from "./types";

/** A sync older than this reads as stale (red dot) in the stats strip. */
const SYNC_STALE_MS = 24 * 60 * 60 * 1000;

export function CrmHeader({
  insights,
  onShowStale,
  onOpenCuration,
}: {
  insights: Insights | null;
  onShowStale: () => void;
  onOpenCuration: () => void;
}) {
  const flagged = insights?.flagged_records ?? 0;
  return (
    <header className="border-b">
      <PageHeader
        title="CRM — Banker Relationships"
        subtitle={
          <>
            Auto-extracted from Google Vault
            {insights?.email_accounts != null && (
              <> · {insights.email_accounts} email accounts</>
            )}
          </>
        }
      />

      <div className="px-7 pb-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border bg-card px-4 py-3 text-sm">
          <button
            type="button"
            onClick={onShowStale}
            className="flex items-center gap-2.5 border-r pr-6 text-left"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-300">
              <AlertTriangle className="h-3.5 w-3.5" />
            </span>
            <span className="whitespace-nowrap leading-tight">
              <span className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                {insights?.stale_employers ?? 0}
              </span>{" "}
              <span className="font-semibold text-foreground">
                no contact in 30+ days
              </span>{" "}
              <span className="ml-1 text-[13px] font-bold text-blue-600 underline dark:text-blue-400">
                Follow up →
              </span>
            </span>
          </button>

          <div
            className={cn(
              "flex items-center gap-2 whitespace-nowrap border-r pr-6",
              flagged > 0 ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <Inbox className="h-3.5 w-3.5" />
            <span>
              <b className="font-bold">{flagged}</b> awaiting curation
            </span>
            <button
              type="button"
              onClick={onOpenCuration}
              className="text-[13px] font-semibold hover:underline"
            >
              Review →
            </button>
          </div>

          <div className="flex items-center gap-2 whitespace-nowrap border-r pr-6 text-foreground">
            <Mail className="h-3.5 w-3.5 text-emerald-600" />
            <span>
              <b className="font-bold">{insights?.emails_today ?? 0}</b>{" "}
              received today
            </span>
          </div>

          <SyncStatus lastSyncedAt={insights?.last_synced_at ?? null} />
        </div>
      </div>
    </header>
  );
}

/**
 * "Last sync: N ago" — red once the last sync is over a day old, so a stalled
 * Vault ingest is visible at a glance.
 */
function SyncStatus({ lastSyncedAt }: { lastSyncedAt: string | null }) {
  const stale =
    !lastSyncedAt ||
    Date.now() - new Date(lastSyncedAt).getTime() > SYNC_STALE_MS;
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 whitespace-nowrap text-[13px] font-semibold",
        stale ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          stale ? "bg-red-600" : "animate-pulse bg-emerald-500",
        )}
      />
      {lastSyncedAt
        ? `Last sync: ${formatDistanceToNow(new Date(lastSyncedAt), { addSuffix: true })}`
        : "Never synced"}
    </div>
  );
}
