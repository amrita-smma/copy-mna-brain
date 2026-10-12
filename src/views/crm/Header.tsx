"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageHeader } from "@/components/layout/PageHeader";
import { cn } from "@/lib/utils";
import { formatDistanceToNow, formatDistanceToNowStrict } from "date-fns";
import {
  AlertTriangle,
  LayoutGrid,
  Plus,
  Sparkles,
  Mail,
} from "lucide-react";
import type { Insights } from "./types";

export function CrmHeader({
  insights,
  onOpenAddContact,
  onShowStale,
  onOpenCuration,
}: {
  insights: Insights | null;
  onOpenAddContact: () => void;
  onShowStale: () => void;
  onOpenCuration: () => void;
}) {
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
        titleAdornment={
          <span className="inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-md border border-blue-500/30 px-2.5 py-1 text-xs font-medium leading-tight text-blue-600 dark:text-blue-400">
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            Auto-extracted
          </span>
        }
        actions={
          <Button size="sm" onClick={onOpenAddContact}>
            <Plus className="mr-2 h-4 w-4" />
            Add Contact
          </Button>
        }
      />

      <div className="px-7 pb-5">
        <Card className="border bg-card">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <LayoutGrid className="h-5 w-5 text-foreground" />
              <CardTitle className="text-lg font-semibold">Overview</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <InsightItem
                tone="red"
                icon={<AlertTriangle className="h-3.5 w-3.5" />}
                label="Companies"
                title={`${insights?.stale_employers ?? 0}`}
                description="No contact in 30+ days"
                cta={{ label: "Follow up →", onClick: onShowStale }}
              />
              <InsightItem
                tone="amber"
                icon={<AlertTriangle className="h-3.5 w-3.5" />}
                label="Records"
                title={`${insights?.flagged_records ?? 0}`}
                description="Awaiting curation"
                cta={{ label: "Review →", onClick: onOpenCuration }}
              />
              <InsightItem
                tone="green"
                icon={<Mail className="h-3.5 w-3.5" />}
                label="Emails"
                title={`${insights?.emails_today ?? 0}`}
                description="Received today"
                subline={
                  <SyncSubline
                    lastSyncedAt={insights?.last_synced_at ?? null}
                    nextSyncAt={insights?.next_sync_at ?? null}
                  />
                }
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </header>
  );
}

function InsightItem({
  tone,
  icon,
  label,
  title,
  description,
  cta,
  subline,
}: {
  tone: "red" | "amber" | "green";
  icon: React.ReactNode;
  label: string;
  title: string;
  description: string;
  cta?: { label: string; onClick: () => void };
  /** Optional fourth line when there is no CTA. */
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
    <div className="flex items-start gap-3 rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
      <div
        className={cn(
          "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg",
          toneClasses,
        )}
      >
        {icon}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-muted-foreground">
          {description}
        </span>
        <strong className="text-3xl font-semibold text-foreground leading-tight">
          {title}
        </strong>
        <span>{label}</span>
        {cta ? (
          <button
            className="w-fit cursor-pointer text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400"
            onClick={cta.onClick}
          >
            {cta.label}
          </button>
        ) : (
          subline && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {subline}
            </div>
          )
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
