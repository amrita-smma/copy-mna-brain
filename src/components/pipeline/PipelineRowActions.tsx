"use client";

import { Fragment, type ComponentType } from "react";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  Eye,
  Loader2,
  Pencil,
  RotateCcw,
  Sparkles,
  XCircle,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AskAIButton } from "@/components/chat/AskAIButton";
import { cn } from "@/lib/utils";
import { formatProjectName } from "@/lib/companyDisplay";
import { sourceTypeLabel } from "@/lib/pipeline/sourceType";
import { stageMoveLabel } from "@/lib/constants";
import { effectiveDealLead, type TrackLike } from "@/lib/tracks/matchTracks";
import type { PipelineCompany } from "@/views/Pipeline";

/**
 * Pinned-column classes shared by the pipeline company tables. Company sticks to
 * the left edge and Actions to the right edge while the managed columns scroll
 * between them. Both paint an opaque surface (and follow the row's hover tint)
 * so scrolled content never shows through.
 */
export const stickyCompanyHeadClass = "sticky left-0 z-20 bg-card border-r";
export const stickyCompanyCellClass =
  "sticky left-0 z-10 border-r bg-card group-hover:bg-muted";
export const stickyActionsHeadClass =
  "sticky right-0 z-20 bg-card border-l text-center whitespace-nowrap";
export const stickyActionsCellClass =
  "sticky right-0 z-10 border-l bg-card group-hover:bg-muted";

/**
 * Read-only Deal Sponsor (L0–L2) / Deal Captain (L3+) cell, the same value the
 * tables sort and filter by (`effectiveDealLead`): the stored override, else
 * the Deal Sponsor at Captain stages, else the matched Track's PIC. Editing
 * happens only in the company card, never inline.
 */
export function DealLeadCell({
  company,
  tracks,
  captainKeys,
}: {
  company: PipelineCompany;
  tracks: TrackLike[];
  /** The workspace's L3-onward stage keys, where the lead is the Deal Captain. */
  captainKeys: readonly string[];
}) {
  return (
    <span className="text-sm text-muted-foreground">
      {effectiveDealLead(company, company.pipeline_stage, tracks, captainKeys) || "—"}
    </span>
  );
}

/**
 * Company cell title: the name on its own line with the project codename muted
 * underneath, both opening the company detail.
 */
export function PipelineCompanyTitle({
  company,
  onClick,
}: {
  company: {
    target?: string | null;
    name?: string | null;
    project_name?: string | null;
  };
  onClick: () => void;
}) {
  const name = company.target?.trim() || company.name?.trim() || "";
  const project = formatProjectName(company.project_name);
  if (!name && !project) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/title flex flex-col text-left transition-colors"
    >
      {name && (
        <span className="font-medium group-hover/title:text-primary group-hover/title:underline">
          {name}
        </span>
      )}
      {project && (
        <span
          className={cn(
            "text-xs text-muted-foreground group-hover/title:text-primary",
            !name && "text-sm font-medium",
          )}
        >
          [{project}]
        </span>
      )}
    </button>
  );
}

/** Pipeline Status cell: green Active, or red Dropped for a dropped deal. */
export function PipelineStatusCell({ dropped }: { dropped: boolean }) {
  return dropped ? (
    <span className="text-sm font-semibold text-red-600 dark:text-red-400">
      Dropped
    </span>
  ) : (
    <span className="text-sm font-semibold text-green-700 dark:text-green-400">
      Active
    </span>
  );
}

/** Source Type cell: Inbound / Outbound, or a dash when the deal has none. */
export function SourceTypeCell({ source }: { source: string | null }) {
  const label = sourceTypeLabel(source);
  return label ? (
    <span className="text-sm whitespace-nowrap">{label}</span>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

/** Created At cell date, e.g. "12 Oct 26". */
export function formatCreatedAt(iso: string | null | undefined) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });
}

export interface PipelineMoveItem {
  key: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  onSelect: () => void;
  /** Red, destructive styling (drop / delete). */
  destructive?: boolean;
  disabled?: boolean;
  /** Tooltip, e.g. why an item is disabled. */
  title?: string;
  /** Extra classes for the icon (e.g. a spinner animation). */
  iconClassName?: string;
  /** Draw a separator above this item. */
  separatorBefore?: boolean;
}

/** A row's Run AI Screening state — offered on Pending Confirmation rows only. */
export interface RowScreening {
  running: boolean;
  onRun: () => void;
}

/**
 * The Run AI Screening menu item for a Pending Confirmation row. The run
 * matches the company to tracks when it has none, so it is never disabled for
 * want of matched tracks.
 */
export function screeningMoveItem(screening: RowScreening): PipelineMoveItem {
  return screening.running
    ? {
        key: "screening",
        label: "AI Screening Running",
        icon: Loader2,
        iconClassName: "animate-spin text-blue-600",
        onSelect: () => {},
        disabled: true,
        separatorBefore: true,
      }
    : {
        key: "screening",
        label: "Run AI Screening",
        icon: Sparkles,
        iconClassName: "text-blue-600",
        onSelect: screening.onRun,
        title:
          "Same as Scan now for this company: match tracks, AI-screen, then auto drop or promote to L0 when your workspace has that enabled",
        separatorBefore: true,
      };
}

/**
 * Move-menu items for a live or dropped pipeline row: Drop Deal · Move Next ·
 * Move Back, then Run AI Screening when given (Pending Confirmation rows); a
 * dropped row only offers Restore. Moves with no target stage (first / last
 * stage) are omitted.
 */
export function pipelineMoveItems({
  isDropped,
  promoteTarget,
  demoteTarget,
  onPromote,
  onDemote,
  onDrop,
  onRestore,
  code,
  screening,
}: {
  isDropped: boolean;
  promoteTarget: string | null | undefined;
  demoteTarget: string | null | undefined;
  onPromote: () => void;
  onDemote: () => void;
  onDrop: () => void;
  onRestore: () => void;
  /** Maps a stage key to the code users see (`usePipelineStages().code`). */
  code: (key: string) => string;
  /** Pending Confirmation rows only; omitted elsewhere. */
  screening?: RowScreening;
}): PipelineMoveItem[] {
  if (isDropped) {
    return [
      { key: "restore", label: "Restore deal", icon: RotateCcw, onSelect: onRestore },
    ];
  }
  const items: PipelineMoveItem[] = [
    {
      key: "drop",
      label: "Drop Deal",
      icon: XCircle,
      onSelect: onDrop,
      destructive: true,
    },
  ];
  if (promoteTarget) {
    items.push({
      key: "next",
      label: `Move Next to ${stageMoveLabel(promoteTarget, code)}`,
      icon: ArrowRight,
      onSelect: onPromote,
    });
  }
  if (demoteTarget) {
    items.push({
      key: "back",
      label: `Move Back to ${stageMoveLabel(demoteTarget, code)}`,
      icon: ArrowLeft,
      onSelect: onDemote,
    });
  }
  if (screening) items.push(screeningMoveItem(screening));
  return items;
}

interface PipelineRowActionsProps {
  onEdit: () => void;
  /** Tooltip / accessible label for the pencil. */
  editLabel?: string;
  onView: () => void;
  /** Sends the row's prompt to the copilot. */
  onAsk: () => void;
  /** Stage moves and other row actions listed under "Move". */
  moveItems: PipelineMoveItem[];
}

const iconButtonClass =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Always-visible row action bar for the pipeline tables: Update · View · Ask ·
 * Move. Move opens a menu of the row's stage moves (rendered in a portal, so it
 * is not clipped by the table's scroll container or the sticky cell).
 */
export function PipelineRowActions({
  onEdit,
  editLabel = "Update",
  onView,
  onAsk,
  moveItems,
}: PipelineRowActionsProps) {
  return (
    <div className="flex items-center justify-center gap-0.5">
      <button
        type="button"
        onClick={onEdit}
        aria-label={editLabel}
        title={editLabel}
        className={iconButtonClass}
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onView}
        aria-label="View details"
        title="View details"
        className={iconButtonClass}
      >
        <Eye className="h-3.5 w-3.5" />
      </button>
      <AskAIButton variant="text" label="Analyze using AI" onClick={onAsk} />
      {moveItems.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Move"
              title="Move"
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:text-foreground"
            >
              <ArrowLeftRight className="h-3.5 w-3.5 shrink-0" />
              Move
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[180px]">
            {moveItems.map((item) => {
              const Icon = item.icon;
              return (
                <Fragment key={item.key}>
                  {item.separatorBefore && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    onClick={item.onSelect}
                    disabled={item.disabled}
                    title={item.title}
                    className={cn(
                      item.destructive &&
                        "text-destructive focus:text-destructive",
                    )}
                  >
                    <Icon
                      className={cn(
                        "mr-2 h-4 w-4",
                        item.destructive && "text-destructive",
                        item.iconClassName,
                      )}
                    />
                    {item.label}
                  </DropdownMenuItem>
                </Fragment>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
