"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDistanceToNow, formatDistanceToNowStrict } from "date-fns";
import {
  AlertTriangle,
  Loader2,
  Mail,
  Plus,
  Users,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { Insights } from "./types";

export function PageHeader({
  insights,
  showVaultSync,
  onOpenAddContact,
  onShowStale,
  onOpenCuration,
}: {
  insights: Insights | null;
  showVaultSync: boolean;
  onOpenAddContact: () => void;
  onShowStale: () => void;
  onOpenCuration: () => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/crm/vault-export", { method: "POST" });
      if (res.ok) toast.success("Vault sync started");
      else {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error || "Failed to start vault sync");
      }
    } finally {
      setSyncing(false);
    }
  };

  return (
    <header className="border-b bg-background px-7 pt-4">
      <div className="mb-3 flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-200 to-indigo-300 dark:from-indigo-900 dark:to-indigo-700">
          <Users className="h-4 w-4 text-indigo-700 dark:text-indigo-200" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-extrabold tracking-tight">
              CRM — Banker Relationships
            </h1>
            <Badge variant="outline" className="text-[10px] font-medium">
              <Zap className="mr-1 h-3 w-3" />
              Auto-extracted
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Auto-extracted from Google Vault
            {insights?.email_accounts != null && (
              <> · {insights.email_accounts} email accounts</>
            )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {showVaultSync && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleSync}
              disabled={syncing}
            >
              {syncing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Mail className="mr-2 h-4 w-4" />
              )}
              Sync Vault (1d)
            </Button>
          )}
          <Button size="sm" onClick={onOpenAddContact}>
            <Plus className="mr-2 h-4 w-4" />
            Add Contact
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-stretch border-t text-sm">
        <InsightItem
          tone="red"
          icon={<AlertTriangle className="h-3 w-3" />}
          body={
            <>
              <strong className="text-foreground">
                {insights?.stale_employers ?? 0} firms
              </strong>{" "}
              silent 30+ days
            </>
          }
          cta={{ label: "Follow up →", onClick: onShowStale }}
        />
        <InsightItem
          tone="amber"
          icon={<AlertTriangle className="h-3 w-3" />}
          body={
            <>
              <strong className="text-foreground">
                {insights?.flagged_records ?? 0} records
              </strong>{" "}
              need curation
            </>
          }
          cta={{ label: "Review →", onClick: onOpenCuration }}
        />
        <InsightItem
          tone="green"
          icon={<Mail className="h-3 w-3" />}
          body={
            <>
              <strong className="text-foreground">
                {insights?.emails_today ?? 0} new emails
              </strong>{" "}
              today
            </>
          }
          subline={
            <SyncSubline
              lastSyncedAt={insights?.last_synced_at ?? null}
              nextSyncAt={insights?.next_sync_at ?? null}
            />
          }
        />
      </div>
    </header>
  );
}

function InsightItem({
  tone,
  icon,
  body,
  cta,
  subline,
}: {
  tone: "red" | "amber" | "green";
  icon: React.ReactNode;
  body: React.ReactNode;
  cta?: { label: string; onClick: () => void };
  /** Optional second line, e.g. the Vault sync state under "12 emails today". */
  subline?: React.ReactNode;
}) {
  const toneClasses = {
    red: "bg-red-100 text-red-600 dark:bg-red-950/40 dark:text-red-300",
    amber:
      "bg-orange-100 text-orange-600 dark:bg-orange-950/40 dark:text-orange-300",
    green:
      "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300",
  }[tone];
  return (
    <div className="flex items-start gap-2 border-r px-4 py-2 text-sm text-muted-foreground">
      <div
        className={cn(
          "mt-0.5 grid h-5 w-5 place-items-center rounded-md",
          toneClasses,
        )}
      >
        {icon}
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <div>{body}</div>
          {cta && (
            <button
              className="cursor-pointer text-xs font-semibold text-indigo-600 hover:underline"
              onClick={cta.onClick}
            >
              {cta.label}
            </button>
          )}
        </div>
        {subline && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {subline}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * "Synced N ago · next in M" subline rendered under the green "emails today"
 * insight. Hidden when we have no sync history at all.
 */
function SyncSubline({
  lastSyncedAt,
  nextSyncAt,
}: {
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
}) {
  if (!lastSyncedAt) return null;
  const synced = formatDistanceToNow(new Date(lastSyncedAt), {
    addSuffix: true,
  });
  const next =
    nextSyncAt && new Date(nextSyncAt).getTime() > Date.now()
      ? formatDistanceToNowStrict(new Date(nextSyncAt))
      : null;
  return (
    <>
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
      <span>
        Synced {synced}
        {next && <> · next in {next}</>}
      </span>
    </>
  );
}
