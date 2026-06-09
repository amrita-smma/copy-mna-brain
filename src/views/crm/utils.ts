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
// and replaces it with a purple bottom border on the active tab.
export const tabTriggerCls =
  "relative -mb-px rounded-none border-b-2 border-transparent bg-transparent px-3 py-2 text-sm font-medium text-muted-foreground shadow-none transition-colors data-[state=active]:border-indigo-600 data-[state=active]:bg-transparent data-[state=active]:text-indigo-700 data-[state=active]:shadow-none dark:data-[state=active]:text-indigo-300";

const AVATAR_PALETTE = [
  "from-indigo-500 to-violet-600",
  "from-amber-500 to-orange-600",
  "from-teal-500 to-emerald-600",
  "from-pink-500 to-rose-600",
  "from-slate-500 to-slate-700",
  "from-violet-500 to-purple-600",
  "from-sky-500 to-blue-600",
] as const;

/**
 * Deterministically picks an avatar gradient for a given id (or any string).
 * The same id always yields the same colour so cards / contact rows stay
 * stable across renders.
 */
export function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
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
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
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
