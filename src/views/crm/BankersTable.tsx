"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { BankerRow } from "@/lib/api/crmBankers";
import { isAddressLikeName } from "@/lib/crm/contactName";
import { cn } from "@/lib/utils";
import { format, formatDistanceToNow } from "date-fns";
import { AlertTriangle } from "lucide-react";
import { initialsOf, isStaleContact, NEEDS_DEAL_LINKS, SYNC_NOTICE } from "./utils";

const BANKERS_GRID =
  "grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,0.8fr)_minmax(0,0.6fr)_minmax(0,0.6fr)] gap-3";

/** A muted "—" that explains itself: never a 0 where there is no data. */
function Missing({ reason = SYNC_NOTICE }: { reason?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help text-muted-foreground">
          —
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

function LastContact({ iso, synced }: { iso: string | null; synced: boolean }) {
  if (!iso) return synced ? <span className="text-muted-foreground">—</span> : <Missing />;
  const stale = isStaleContact(iso);
  return (
    <div className="min-w-0">
      <div
        className={cn(
          "flex items-center gap-1 truncate text-sm font-semibold",
          stale ? "text-destructive" : "text-success",
        )}
      >
        {stale && <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate">
          {formatDistanceToNow(new Date(iso), { addSuffix: true })}
        </span>
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {format(new Date(iso), "MMM d, yyyy")}
      </div>
    </div>
  );
}

function Team({ row }: { row: BankerRow }) {
  if (row.teamMemberCount === 0) return <span className="text-muted-foreground">—</span>;
  const extra = row.teamMemberCount - row.topTeamMembers.length;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {row.topTeamMembers.map((m) => (
        <span
          key={m.userId}
          className="inline-flex items-center gap-1 rounded-full bg-muted py-0.5 pl-0.5 pr-1.5 text-xs font-semibold"
          title={`${m.name ?? "Team member"} · ${m.total}`}
        >
          <span className="grid h-6 w-6 place-items-center rounded-full bg-muted-foreground text-xs font-bold text-background">
            {initialsOf(m.name ?? "") || "?"}
          </span>
          {m.total}
        </span>
      ))}
      {extra > 0 && (
        <span className="text-xs font-semibold text-muted-foreground">+{extra}</span>
      )}
    </div>
  );
}

/**
 * The CRM Bankers view (MB-858): one flat row per person. Clicking a row opens
 * the contact insights panel. Interaction cells show "—" (with the sync
 * notice) when the workspace has nothing synced; deal cells show "—" when the
 * workspace has no deal links at all.
 */
export function BankersTable({
  rows,
  hasSyncedData,
  hasDealLinks,
  onOpen,
}: {
  rows: BankerRow[];
  hasSyncedData: boolean;
  hasDealLinks: boolean;
  onOpen: (row: BankerRow) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-card" data-testid="crm-bankers-table">
      {/* Wide enough for the 12px headers ("Deals brought") in the 0.6fr columns. */}
      <div className="min-w-[1080px]">
        <div
          className={cn(
            BANKERS_GRID,
            "border-b bg-muted px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground",
          )}
        >
          <div>Name</div>
          <div>Firm</div>
          <div>Last contact</div>
          <div>Team</div>
          <div>Emails</div>
          <div>Deals brought</div>
          <div>Reached L1</div>
        </div>
        {rows.map((row) => {
          const nameIsAddress = isAddressLikeName(row.name, row.email);
          // Nothing synced, or synced but this person never emailed or met us:
          // "—" with the reason, never a row of zeros.
          const noInteractions =
            !hasSyncedData || (row.teamMemberCount === 0 && !row.lastContactAt);
          const missingReason = hasSyncedData
            ? "No emails with our team yet"
            : SYNC_NOTICE;
          return (
            <button
              key={row.correspondentId}
              type="button"
              onClick={() => onOpen(row)}
              className={cn(
                BANKERS_GRID,
                "w-full items-center border-b bg-card px-3 py-2 text-left text-xs transition-colors last:border-b-0 hover:bg-muted",
              )}
              data-testid="crm-banker-row"
            >
              <div className="min-w-0">
                {nameIsAddress ? (
                  <>
                    <div className="truncate font-mono text-xs" title={row.email ?? row.name}>
                      {row.email ?? row.name}
                    </div>
                    <div className="text-xs text-muted-foreground">No name yet</div>
                  </>
                ) : (
                  <>
                    <div className="truncate text-sm font-semibold" title={row.name}>
                      {row.name}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {row.title || row.email || "—"}
                    </div>
                  </>
                )}
              </div>
              <div className="min-w-0 truncate font-semibold text-muted-foreground" title={row.firm.name}>
                {row.firm.name || "—"}
              </div>
              <LastContact iso={row.lastContactAt} synced={hasSyncedData} />
              <div className="min-w-0">
                {noInteractions ? <Missing reason={missingReason} /> : <Team row={row} />}
              </div>
              <div className="min-w-0 whitespace-nowrap">
                {noInteractions ? (
                  <Missing reason={missingReason} />
                ) : (
                  <span title="Emails they sent us / emails we sent them">
                    {row.totals.emailsFromThem} in / {row.totals.emailsFromUs} out
                  </span>
                )}
              </div>
              <div>
                {hasDealLinks ? row.dealsBrought : <Missing reason={NEEDS_DEAL_LINKS} />}
              </div>
              <div>
                {!hasDealLinks ? (
                  <Missing reason={NEEDS_DEAL_LINKS} />
                ) : row.conversion === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <span title={`${Math.round(row.conversion * 100)}% of deals brought`}>
                    {row.reachedL1}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
