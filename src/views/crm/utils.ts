import { nameInitials } from "@/lib/companyDisplay";
import type { LastContactPreset } from "./types";

export const PAGE_SIZE = 50;

export const LAST_CONTACT_LABELS: Record<LastContactPreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Last 7 days",
  month: "Last 30 days",
  stale_30: "More than 30 days",
  custom: "Custom date",
};

// Tab trigger styling for expanded-card tabs — strips the shadcn pill highlight
// and replaces it with a blue bottom border on the active tab.
export const tabTriggerCls =
  "relative -mb-px rounded-none border-b-2 border-transparent bg-transparent px-3 py-2 text-sm font-medium text-muted-foreground shadow-none transition-colors data-[state=active]:border-blue-600 data-[state=active]:bg-transparent data-[state=active]:text-blue-700 data-[state=active]:shadow-none dark:data-[state=active]:text-blue-300";

const AVATAR_GREY = "from-slate-400 to-slate-500 dark:from-slate-500 dark:to-slate-600";

/**
 * Returns a grey avatar gradient for a given id (or any string).
 * Kept as a function so call sites stay stable if per-id colours return later.
 */
export function colorForId(_id: string): string {
  return AVATAR_GREY;
}

/**
 * Humanises a response-time p50 (seconds) for the CRM list, e.g. "3 days",
 * "5 hrs", "12 mins". Returns "—" when there is no value. Sub-minute gaps round
 * up to "1 min" so a near-instant reply never shows "0".
 */
export function formatResponseP50(seconds: number | null): string {
  if (seconds == null) return "—";
  const days = seconds / 86400;
  if (days >= 1) {
    const d = Math.round(days);
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  const hours = seconds / 3600;
  if (hours >= 1) {
    const h = Math.round(hours);
    return `${h} hr${h === 1 ? "" : "s"}`;
  }
  const mins = Math.max(1, Math.round(seconds / 60));
  return `${mins} min${mins === 1 ? "" : "s"}`;
}

export function initialsOf(name: string): string {
  // English-only initials so non-Latin / special characters never leak into the
  // avatar. Empty when nothing resolves (callers render their own placeholder).
  return nameInitials(name, "");
}

// Seed list shown inside the Add-tag input's <datalist>. The full menu of
// existing topics still comes from /api/crm/topics.
export const TOPIC_SUGGESTIONS = [
  "CMP slurry",
  "lithography",
  "wet processing",
  "acquisition",
  "mandate",
  "TIM",
  "carve-out",
  "financing",
  "buy-side",
  "PE exit",
  "packaging",
  "Korea",
  "specialty chem",
  "semiconductors",
];
