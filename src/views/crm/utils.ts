import { nameInitials } from "@/lib/companyDisplay";
import type {
  ContactFormValues,
  Correspondent,
  LastContactPreset,
} from "./types";

export const PAGE_SIZE = 50;

/** Why an email-derived field is empty while the workspace has nothing synced. */
export const SYNC_NOTICE = "Fills in after an email sync";

/** Why a deal figure is empty while the workspace has no deal links. */
export const NEEDS_DEAL_LINKS = "Needs deal links";

const STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** Last contact more than 30 days ago; never stale without a contact. */
export function isStaleContact(iso: string | null): boolean {
  return !!iso && Date.now() - new Date(iso).getTime() > STALE_MS;
}

/** "1 email", "3 emails". */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

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
  "relative -mb-px rounded-none border-b-2 border-transparent bg-transparent px-0 pb-3 pt-0 text-[15px] font-bold text-muted-foreground shadow-none transition-colors data-[state=active]:border-blue-600 data-[state=active]:bg-transparent data-[state=active]:text-blue-700 data-[state=active]:shadow-none dark:data-[state=active]:text-blue-300";

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

// Suggestion lists for the contact editor's free-text <datalist> fields. The
// underlying columns are plain text — these only speed up typing, they are not
// a closed enum, because desk naming varies firm to firm.
export const CONTACT_DEPARTMENTS = [
  "M&A",
  "ECM",
  "DCM",
  "Leveraged Finance",
  "Sector Coverage",
  "Restructuring",
  "Equity Research",
  "Sales & Trading",
  "Private Capital Markets",
  "Corporate Development",
];

export const CONTACT_SENIORITIES = [
  "Analyst",
  "Associate",
  "Vice President",
  "Director",
  "Executive Director",
  "Managing Director",
  "Partner",
  "Head of Desk",
];

export const CONTACT_TYPES = ["external", "internal"];

/** Blank → null, so clearing a field in the editor clears it in the DB. */
export function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Contact form state → the JSON body both contact endpoints accept. */
export function contactFormToPayload(
  values: ContactFormValues,
): Record<string, string | null> {
  return {
    name: values.name.trim(),
    title: blankToNull(values.title),
    email: blankToNull(values.email),
    phone: blankToNull(values.phone),
    type: blankToNull(values.type),
    department: blankToNull(values.department),
    specialization: blankToNull(values.specialization),
    seniority: blankToNull(values.seniority),
    coverage_region: blankToNull(values.coverage_region),
    linkedin_url: blankToNull(values.linkedin_url),
  };
}

/** An existing contact → editable form state (nulls become empty strings). */
export function contactToFormValues(c: Correspondent): ContactFormValues {
  return {
    name: c.name ?? "",
    title: c.title ?? "",
    email: c.email ?? "",
    phone: c.phone ?? "",
    type: c.type ?? "",
    department: c.department ?? "",
    specialization: c.specialization ?? "",
    seniority: c.seniority ?? "",
    coverage_region: c.coverage_region ?? "",
    linkedin_url: c.linkedin_url ?? "",
  };
}

/**
 * Returns a LinkedIn (or any) profile URL only when it is safe to put in an
 * `href`. Contact fields are free text, so a stored `javascript:` or `data:`
 * value would otherwise render as a clickable link in the CRM card. A
 * scheme-less value ("linkedin.com/in/jane") is upgraded to https rather than
 * being dropped, since that is how people paste it.
 */
export function safeProfileUrl(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
