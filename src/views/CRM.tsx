"use client";

import DashboardLayout from "@/components/layout/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  formatDistanceToNow,
  formatDistanceToNowStrict,
  format,
} from "date-fns";
import {
  AlertTriangle,
  Calendar,
  Check,
  ChevronDown,
  Loader2,
  Mail,
  Plus,
  Search,
  Tag,
  Users,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

// ─── Types matching backend payloads ─────────────────────────────────────────

interface PrimaryPic {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
}

interface TopicChip {
  id: string;
  name: string;
  source: string;
  is_highlight: boolean;
}

interface TeamMemberSummary {
  id: string;
  name: string;
  email: string | null;
}

interface EmployerSummary {
  id: string;
  name: string;
  normalized_name: string;
  industry: string | null;
  status: string;
  curation_status: string;
  source: "auto" | "manual";
  created_at: string;
  updated_at: string;
  primary_pic: PrimaryPic | null;
  email_count: number;
  last_contact_at: string | null;
  topics: TopicChip[];
  team: TeamMemberSummary[];
}

interface Correspondent {
  id: string;
  employer_id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  type: string | null;
  is_primary: boolean;
  source: string;
}

interface EmployerNote {
  id: string;
  employer_id: string;
  content: string;
  created_at: string;
  updated_at: string;
}

interface EmployerTopicAssignment {
  id: string;
  topic_id: string;
  name: string;
  slug: string;
  source: string;
  is_highlight: boolean;
}

interface EmployerDetail {
  employer: {
    id: string;
    name: string;
    industry: string | null;
    status: string;
  };
  primary_pic: Correspondent | null;
  correspondents: Correspondent[];
  notes: EmployerNote[];
  topics: EmployerTopicAssignment[];
  team: TeamMemberSummary[];
  email_count: number;
  last_contact_at: string | null;
}

interface Insights {
  stale_employers: number;
  flagged_records: number;
  emails_today: number;
  email_accounts: number | null;
  last_synced_at: string | null;
  next_sync_at: string | null;
}

interface Topic {
  id: string;
  name: string;
  slug: string;
}

type LastContactPreset = "today" | "yesterday" | "week" | "month" | "custom";

const LAST_CONTACT_LABELS: Record<LastContactPreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Last 7 days",
  month: "Last 30 days",
  custom: "Custom date",
};

const PAGE_SIZE = 50;

// Tab trigger styling for expanded-card tabs — strips the shadcn pill highlight
// and replaces it with a purple bottom border on the active tab.
const tabTriggerCls =
  "relative -mb-px rounded-none border-b-2 border-transparent bg-transparent px-3 py-2 text-sm font-medium text-muted-foreground shadow-none transition-colors data-[state=active]:border-indigo-600 data-[state=active]:bg-transparent data-[state=active]:text-indigo-700 data-[state=active]:shadow-none dark:data-[state=active]:text-indigo-300";

// ─── Deterministic avatar palette ────────────────────────────────────────────

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
function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

function initialsOf(name: string): string {
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
const TOPIC_SUGGESTIONS = [
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

// ─── Page ───────────────────────────────────────────────────────────────────

interface CRMProps {
  showCrm?: boolean;
  showAiWorkforce?: boolean;
  showVaultSync?: boolean;
}

export default function CRM({
  showCrm = false,
  showAiWorkforce = false,
  showVaultSync = false,
}: CRMProps) {
  const [employers, setEmployers] = useState<EmployerSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [lastContact, setLastContact] = useState<LastContactPreset | null>(
    null,
  );
  const [customDate, setCustomDate] = useState<string>("");
  const [topicFilter, setTopicFilter] = useState<Set<string>>(new Set());
  const [teamFilter, setTeamFilter] = useState<Set<string>>(new Set());

  const [topics, setTopics] = useState<Topic[]>([]);
  const [teamUsers, setTeamUsers] = useState<TeamMemberSummary[]>([]);

  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, EmployerDetail>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);

  const [addContactOpen, setAddContactOpen] = useState(false);
  const [addContactEmployerId, setAddContactEmployerId] = useState<
    string | null
  >(null);

  const [curationOpen, setCurationOpen] = useState(false);

  // ─── Debounce search ──────────────────────────────────────────────────────
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(handle);
  }, [search]);

  // ─── Fetch employers ──────────────────────────────────────────────────────
  const fetchEmployers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (lastContact) params.set("lastContact", lastContact);
      if (lastContact === "custom" && customDate)
        params.set("customDate", customDate);
      topicFilter.forEach((id) => params.append("topicId", id));
      teamFilter.forEach((id) => params.append("teamUserId", id));
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));

      const res = await fetch(`/api/crm?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load CRM");
      setEmployers(json.data);
      setTotal(json.total);
      setInsights(json.insights);
    } catch (err) {
      console.error(err);
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, lastContact, customDate, topicFilter, teamFilter, page]);

  useEffect(() => {
    fetchEmployers();
  }, [fetchEmployers]);

  // ─── Load filter sources ──────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/crm/topics")
      .then((r) => r.json())
      .then((j) => setTopics(j.data ?? []))
      .catch(() => undefined);
    fetch("/api/crm/team-users")
      .then((r) => r.json())
      .then((j) => setTeamUsers(j.data ?? []))
      .catch(() => undefined);
  }, []);

  // ─── Card expand / detail load ────────────────────────────────────────────
  const loadDetail = useCallback(async (id: string) => {
    setLoadingDetail(id);
    try {
      const res = await fetch(`/api/crm/employers/${id}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load employer");
      setDetails((prev) => ({ ...prev, [id]: json.data }));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoadingDetail(null);
    }
  }, []);

  const toggleExpand = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
    } else {
      setExpandedId(id);
      if (!details[id]) loadDetail(id);
    }
  };

  // ─── Active filter chips ──────────────────────────────────────────────────
  const activeTags = useMemo(() => {
    const tags: Array<{ key: string; label: string; clear: () => void }> = [];
    if (lastContact) {
      tags.push({
        key: "lc",
        label: `Last contact: ${LAST_CONTACT_LABELS[lastContact]}`,
        clear: () => {
          setLastContact(null);
          setCustomDate("");
        },
      });
    }
    topicFilter.forEach((id) => {
      const t = topics.find((x) => x.id === id);
      if (!t) return;
      tags.push({
        key: "topic:" + id,
        label: `Topic: ${t.name}`,
        clear: () =>
          setTopicFilter((s) => {
            const next = new Set(s);
            next.delete(id);
            return next;
          }),
      });
    });
    teamFilter.forEach((id) => {
      const u = teamUsers.find((x) => x.id === id);
      if (!u) return;
      tags.push({
        key: "team:" + id,
        label: u.name,
        clear: () =>
          setTeamFilter((s) => {
            const next = new Set(s);
            next.delete(id);
            return next;
          }),
      });
    });
    return tags;
  }, [lastContact, topicFilter, teamFilter, topics, teamUsers]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <DashboardLayout showCrm={showCrm} showAiWorkforce={showAiWorkforce}>
      <datalist id="topic-suggestions">
        {TOPIC_SUGGESTIONS.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div className="flex flex-col h-full">
        <PageHeader
          insights={insights}
          showVaultSync={showVaultSync}
          onOpenAddContact={() => {
            setAddContactEmployerId(null);
            setAddContactOpen(true);
          }}
          onShowStale={() => {
            setLastContact("month");
            setPage(1);
          }}
          onOpenCuration={() => setCurationOpen(true)}
        />

        {(insights?.flagged_records ?? 0) > 0 && (
          <div className="flex items-center gap-2 border-b border-orange-200/40 bg-orange-50 px-7 py-2 text-sm dark:bg-orange-950/20">
            <AlertTriangle className="h-4 w-4 text-orange-500" />
            <strong className="font-bold text-orange-600">
              {insights?.flagged_records} records
            </strong>
            <span className="text-muted-foreground">
              flagged. Hidden until approved.
            </span>
            <button
              className="ml-auto cursor-pointer text-xs font-bold text-orange-600 underline"
              onClick={() => setCurationOpen(true)}
            >
              Review now →
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-screen-2xl px-7 py-3">
            {/* Toolbar */}
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="relative min-w-[180px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search by firm name or PIC name…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>

              <LastContactFilter
                value={lastContact}
                customDate={customDate}
                onChange={(v, custom) => {
                  setLastContact(v);
                  setCustomDate(custom ?? "");
                  setPage(1);
                }}
              />

              <TopicFilter
                topics={topics}
                selected={topicFilter}
                onChange={(next) => {
                  setTopicFilter(next);
                  setPage(1);
                }}
              />

              <TeamFilter
                users={teamUsers}
                selected={teamFilter}
                onChange={(next) => {
                  setTeamFilter(next);
                  setPage(1);
                }}
              />
            </div>

            {/* Active filter chips */}
            {activeTags.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-1">
                {activeTags.map((t) => (
                  <button
                    key={t.key}
                    className="inline-flex items-center gap-1 rounded-md bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-600 hover:text-white dark:bg-indigo-950 dark:text-indigo-300"
                    onClick={t.clear}
                  >
                    {t.label}
                    <X className="h-3 w-3" />
                  </button>
                ))}
              </div>
            )}

            {/* Column headers */}
            <div className="mb-1 grid grid-cols-[36px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.1fr)_28px] gap-3 px-3 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              <div />
              <div>Source</div>
              <div>Industry Focus</div>
              <div>Primary PIC</div>
              <div>Last Contact</div>
              <div>Topics</div>
              <div>Team Member</div>
              <div />
            </div>

            {/* Cards */}
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : employers.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
                <Users className="h-10 w-10 opacity-50" />
                <p>No employers match these filters.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {employers.map((emp) => (
                  <EmployerCard
                    key={emp.id}
                    employer={emp}
                    expanded={expandedId === emp.id}
                    detail={details[emp.id]}
                    loadingDetail={loadingDetail === emp.id}
                    onToggle={() => toggleExpand(emp.id)}
                    onAddContact={() => {
                      setAddContactEmployerId(emp.id);
                      setAddContactOpen(true);
                    }}
                    onRefreshDetail={() => loadDetail(emp.id)}
                    onRefreshList={() => fetchEmployers()}
                  />
                ))}
              </div>
            )}

            {/* Pagination */}
            {total > PAGE_SIZE && (
              <div className="mt-6 flex items-center justify-between border-t pt-4">
                <div className="text-sm text-muted-foreground">
                  Showing {(page - 1) * PAGE_SIZE + 1}–
                  {Math.min(page * PAGE_SIZE, total)} of{" "}
                  <strong>{total}</strong> firms
                </div>
                <Pagination
                  page={page}
                  totalPages={totalPages}
                  onChange={setPage}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <AddContactDialog
        open={addContactOpen}
        onOpenChange={setAddContactOpen}
        employerId={addContactEmployerId}
        employers={employers}
        onCreated={() => {
          setAddContactOpen(false);
          fetchEmployers();
          if (addContactEmployerId) loadDetail(addContactEmployerId);
        }}
      />

      <CurationDialog
        open={curationOpen}
        onOpenChange={setCurationOpen}
        onResolved={() => fetchEmployers()}
      />
    </DashboardLayout>
  );
}

// ─── Page header (title + insight bar) ────────────────────────────────────

function PageHeader({
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

// ─── Last-contact filter ──────────────────────────────────────────────────

function LastContactFilter({
  value,
  customDate,
  onChange,
}: {
  value: LastContactPreset | null;
  customDate: string;
  onChange: (v: LastContactPreset | null, custom?: string) => void;
}) {
  const [draft, setDraft] = useState<LastContactPreset | null>(value);
  const [draftDate, setDraftDate] = useState(customDate);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setDraft(value);
    setDraftDate(customDate);
  }, [value, customDate, open]);

  // Trigger label stays "Last Contact" — the active selection is communicated
  // via the active-filter chip strip below the toolbar.
  const label = "Last Contact";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={value ? "default" : "outline"}
          size="sm"
          className={cn(
            "gap-1",
            value &&
              "bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-950 dark:text-indigo-200",
          )}
        >
          <Calendar className="h-3 w-3" />
          {label}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="start">
        <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          Show firms contacted…
        </div>
        <RadioGroup
          value={draft ?? ""}
          onValueChange={(v) => setDraft(v as LastContactPreset)}
        >
          {(
            [
              "today",
              "yesterday",
              "week",
              "month",
              "custom",
            ] as LastContactPreset[]
          ).map((preset) => (
            <label
              key={preset}
              className="flex cursor-pointer items-center gap-2 rounded-md p-1.5 text-sm hover:bg-muted"
            >
              <RadioGroupItem value={preset} />
              {LAST_CONTACT_LABELS[preset]}
            </label>
          ))}
        </RadioGroup>
        {draft === "custom" && (
          <Input
            type="date"
            value={draftDate}
            onChange={(e) => setDraftDate(e.target.value)}
            className="mt-2"
          />
        )}
        <div className="mt-3 flex items-center justify-between border-t pt-2">
          <button
            className="text-xs font-semibold text-muted-foreground hover:text-red-600"
            onClick={() => {
              setDraft(null);
              setDraftDate("");
              onChange(null);
              setOpen(false);
            }}
          >
            Clear
          </button>
          <Button
            size="sm"
            onClick={() => {
              onChange(draft, draftDate);
              setOpen(false);
            }}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Topic filter ─────────────────────────────────────────────────────────

function TopicFilter({
  topics,
  selected,
  onChange,
}: {
  topics: Topic[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Set<string>>(new Set(selected));

  useEffect(() => {
    if (open) setDraft(new Set(selected));
  }, [open, selected]);

  const filtered = topics.filter((t) =>
    t.name.toLowerCase().includes(query.toLowerCase()),
  );

  const first = topics.find((t) => selected.has(t.id));
  const label = selected.size === 0 ? "Topic" : (first?.name ?? "Topic");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={selected.size ? "default" : "outline"}
          size="sm"
          className={cn(
            "gap-1",
            selected.size &&
              "bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-950 dark:text-indigo-200",
          )}
        >
          <Tag className="h-3 w-3" />
          {label}
          {selected.size > 1 && (
            <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
              +{selected.size - 1}
            </Badge>
          )}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start">
        <Input
          placeholder="Search topics…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mb-2"
        />
        <div className="max-h-52 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              No topics
            </div>
          ) : (
            filtered.map((t) => {
              const on = draft.has(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md p-1.5 text-left text-sm hover:bg-muted",
                    on && "font-semibold text-indigo-700 dark:text-indigo-300",
                  )}
                  onClick={() => {
                    const next = new Set(draft);
                    on ? next.delete(t.id) : next.add(t.id);
                    setDraft(next);
                  }}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary",
                      on && "bg-primary text-primary-foreground",
                    )}
                  >
                    {on && <Check className="h-3 w-3" />}
                  </span>
                  {t.name}
                </button>
              );
            })
          )}
        </div>
        <div className="mt-3 flex items-center justify-between border-t pt-2">
          <button
            className="text-xs font-semibold text-muted-foreground hover:text-red-600"
            onClick={() => {
              setDraft(new Set());
              onChange(new Set());
              setOpen(false);
            }}
          >
            Clear all
          </button>
          <Button
            size="sm"
            onClick={() => {
              onChange(new Set(draft));
              setOpen(false);
            }}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Team filter ──────────────────────────────────────────────────────────

function TeamFilter({
  users,
  selected,
  onChange,
}: {
  users: TeamMemberSummary[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Set<string>>(new Set(selected));

  useEffect(() => {
    if (open) setDraft(new Set(selected));
  }, [open, selected]);

  const filtered = users.filter((u) =>
    u.name.toLowerCase().includes(query.toLowerCase()),
  );
  const first = users.find((u) => selected.has(u.id));
  const label =
    selected.size === 0 ? "Team member" : (first?.name.split(" ")[0] ?? "Team");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={selected.size ? "default" : "outline"}
          size="sm"
          className={cn(
            "gap-1",
            selected.size &&
              "bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-950 dark:text-indigo-200",
          )}
        >
          <Users className="h-3 w-3" />
          {label}
          {selected.size > 1 && (
            <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
              +{selected.size - 1}
            </Badge>
          )}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-3" align="start">
        <Input
          placeholder="Search members…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mb-2"
        />
        <div className="max-h-52 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              No members
            </div>
          ) : (
            filtered.map((u) => {
              const on = draft.has(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md p-1.5 text-left text-sm hover:bg-muted",
                    on && "font-semibold text-indigo-700 dark:text-indigo-300",
                  )}
                  onClick={() => {
                    const next = new Set(draft);
                    on ? next.delete(u.id) : next.add(u.id);
                    setDraft(next);
                  }}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary",
                      on && "bg-primary text-primary-foreground",
                    )}
                  >
                    {on && <Check className="h-3 w-3" />}
                  </span>
                  {u.name}
                </button>
              );
            })
          )}
        </div>
        <div className="mt-3 flex items-center justify-between border-t pt-2">
          <button
            className="text-xs font-semibold text-muted-foreground hover:text-red-600"
            onClick={() => {
              setDraft(new Set());
              onChange(new Set());
              setOpen(false);
            }}
          >
            Clear all
          </button>
          <Button
            size="sm"
            onClick={() => {
              onChange(new Set(draft));
              setOpen(false);
            }}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Employer card ────────────────────────────────────────────────────────

function EmployerCard({
  employer,
  expanded,
  detail,
  loadingDetail,
  onToggle,
  onAddContact,
  onRefreshDetail,
  onRefreshList,
}: {
  employer: EmployerSummary;
  expanded: boolean;
  detail?: EmployerDetail;
  loadingDetail: boolean;
  onToggle: () => void;
  onAddContact: () => void;
  onRefreshDetail: () => void;
  onRefreshList: () => void;
}) {
  const lastContact = employer.last_contact_at
    ? formatDistanceToNow(new Date(employer.last_contact_at), {
        addSuffix: true,
      })
    : "—";
  const isStale = employer.last_contact_at
    ? Date.now() - new Date(employer.last_contact_at).getTime() >
      30 * 24 * 60 * 60 * 1000
    : true;
  const initials = initialsOf(employer.name);
  const avatarGradient = colorForId(employer.id);
  const metaLabel = employer.status === "inbound" ? "Inbound" : "Outbound";
  const summaryTopics = [...employer.topics]
    .sort(
      (a, b) =>
        Number(b.is_highlight) - Number(a.is_highlight) ||
        (a.source === "auto" ? -1 : 1),
    )
    .slice(0, 2);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-card transition-all",
        expanded
          ? "border-indigo-500 shadow-md shadow-indigo-500/10"
          : "hover:border-foreground/20",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="grid w-full grid-cols-[36px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.1fr)_28px] items-center gap-3 px-3 py-2.5 text-left"
      >
        <div
          className={cn(
            "grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br text-xs font-bold text-white",
            avatarGradient,
          )}
        >
          {initials}
        </div>

        <div className="min-w-0">
          <div className="truncate text-sm font-bold">{employer.name}</div>
          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
            <span>{metaLabel}</span>
            <Badge
              variant="outline"
              className={cn(
                "inline-flex h-4 items-center gap-0.5 px-1.5 text-[9px] font-semibold uppercase",
                employer.source === "auto"
                  ? "border-orange-200 bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300"
                  : "text-muted-foreground",
              )}
            >
              {employer.source === "auto" && <Mail className="h-2.5 w-2.5" />}
              {employer.source}
            </Badge>
          </div>
        </div>

        <div className="min-w-0 truncate text-xs font-semibold text-muted-foreground">
          {employer.industry ?? "—"}
        </div>

        <div className="min-w-0">
          {employer.primary_pic ? (
            <>
              <div className="truncate text-sm font-semibold">
                {employer.primary_pic.name}
              </div>
              <div className="truncate text-[10px] text-muted-foreground">
                {employer.primary_pic.title ?? "—"}
              </div>
              {employer.primary_pic.email && (
                <div className="truncate font-mono text-[9px] text-indigo-600 dark:text-indigo-400">
                  {employer.primary_pic.email}
                </div>
              )}
            </>
          ) : (
            <span className="text-xs text-muted-foreground">No PIC yet</span>
          )}
        </div>

        <div className="min-w-0">
          <div
            className={cn(
              "truncate text-sm font-semibold",
              isStale ? "text-orange-600" : "text-emerald-600",
            )}
          >
            {lastContact}
          </div>
          {employer.last_contact_at && (
            <div className="truncate text-[10px] text-muted-foreground">
              {format(new Date(employer.last_contact_at), "MMM d, yyyy")}
            </div>
          )}
        </div>

        <div className="min-w-0">
          <div className="mb-0.5 truncate text-xs font-semibold">
            {employer.email_count} email{employer.email_count === 1 ? "" : "s"}
          </div>
          <div className="flex flex-nowrap items-center gap-1 overflow-hidden">
            {summaryTopics.length === 0 ? (
              <span className="text-[10px] text-muted-foreground">No tags</span>
            ) : (
              summaryTopics.map((t) => (
                <div key={t.id} className="min-w-0 flex-shrink truncate">
                  <TopicChipBadge topic={t} />
                </div>
              ))
            )}
          </div>
        </div>

        <div className="min-w-0">
          {employer.team.length === 0 ? (
            <span className="text-[10px] text-muted-foreground">—</span>
          ) : (
            <div className="flex flex-nowrap items-center gap-1 overflow-hidden">
              {employer.team.slice(0, 3).map((t) => (
                <Badge
                  key={t.id}
                  variant="outline"
                  className="h-4 max-w-[80px] flex-shrink-0 truncate px-1.5 text-[10px] font-semibold"
                >
                  {t.name.split(" ")[0]}
                </Badge>
              ))}
              {employer.team.length > 3 && (
                <Badge
                  variant="outline"
                  className="h-4 flex-shrink-0 px-1.5 text-[10px]"
                >
                  +{employer.team.length - 3}
                </Badge>
              )}
            </div>
          )}
        </div>

        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded && (
        <div className="border-t bg-background">
          {loadingDetail || !detail ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ExpandedTabs
              employerId={employer.id}
              detail={detail}
              onAddContact={onAddContact}
              onRefreshDetail={onRefreshDetail}
              onRefreshList={onRefreshList}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TopicChipBadge({
  topic,
}: {
  topic: TopicChip | EmployerTopicAssignment;
}) {
  const cls =
    topic.source === "auto"
      ? "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300"
      : "bg-muted text-foreground";
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-4 px-1.5 text-[10px] font-semibold",
        cls,
        topic.is_highlight && "ring-1 ring-indigo-300",
      )}
    >
      {topic.name}
    </Badge>
  );
}

// ─── Expanded tabs ────────────────────────────────────────────────────────

function ExpandedTabs({
  employerId,
  detail,
  onAddContact,
  onRefreshDetail,
  onRefreshList,
}: {
  employerId: string;
  detail: EmployerDetail;
  onAddContact: () => void;
  onRefreshDetail: () => void;
  onRefreshList: () => void;
}) {
  return (
    <Tabs defaultValue="contacts" className="w-full">
      <TabsList className="h-auto w-full justify-start rounded-none border-b bg-background px-5 py-0">
        <TabsTrigger value="contacts" className={tabTriggerCls}>
          Contacts{" "}
          <span className="ml-1 text-xs">({detail.correspondents.length})</span>
        </TabsTrigger>
        <TabsTrigger value="topics" className={tabTriggerCls}>
          Topics Tag{" "}
          <span className="ml-1 text-xs">({detail.topics.length})</span>
        </TabsTrigger>
        <TabsTrigger value="notes" className={tabTriggerCls}>
          Notes
        </TabsTrigger>
      </TabsList>

      <TabsContent value="contacts" className="px-5 pb-5 pt-4">
        <div className="mb-3 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          <span>Contacts ({detail.correspondents.length})</span>
          <button
            className="text-xs font-bold normal-case text-indigo-600 hover:underline"
            onClick={onAddContact}
          >
            + Add contact
          </button>
        </div>
        <div className="divide-y">
          {detail.correspondents.length === 0 ? (
            <div className="py-6 text-sm text-muted-foreground">
              No contacts on file.
            </div>
          ) : (
            detail.correspondents.map((c) => (
              <div key={c.id} className="flex items-start gap-3 py-3">
                <div
                  className={cn(
                    "grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br text-[10px] font-bold text-white",
                    colorForId(c.id),
                  )}
                >
                  {initialsOf(c.name)}
                </div>
                <div className="flex-1">
                  <div className="text-sm font-bold">
                    {c.name}
                    {c.is_primary && (
                      <Badge
                        variant="outline"
                        className="ml-2 h-4 bg-emerald-50 px-1.5 text-[9px] font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                      >
                        Primary
                      </Badge>
                    )}
                  </div>
                  {c.title && (
                    <div className="text-xs text-muted-foreground">
                      {c.title}
                    </div>
                  )}
                  {c.email && (
                    <div className="mt-0.5 font-mono text-[11px] text-indigo-600 dark:text-indigo-400">
                      {c.email}
                    </div>
                  )}
                  {c.phone && (
                    <div className="text-[11px] text-muted-foreground">
                      {c.phone}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </TabsContent>

      <TabsContent value="topics" className="px-5 pb-5 pt-4">
        <TopicsTab
          employerId={employerId}
          topics={detail.topics}
          onChanged={() => {
            onRefreshDetail();
            onRefreshList();
          }}
        />
      </TabsContent>

      <TabsContent value="notes" className="px-5 pb-5 pt-4">
        <NotesTab
          employerId={employerId}
          notes={detail.notes}
          team={detail.team}
          onChanged={onRefreshDetail}
        />
      </TabsContent>
    </Tabs>
  );
}

// ─── Topics tab ────────────────────────────────────────────────────────────

function TopicsTab({
  employerId,
  topics,
  onChanged,
}: {
  employerId: string;
  topics: EmployerTopicAssignment[];
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [confirmRemove, setConfirmRemove] =
    useState<EmployerTopicAssignment | null>(null);

  const handleAdd = async () => {
    const v = name.trim();
    if (!v) {
      toast.error("Enter a tag name");
      return;
    }
    const res = await fetch(`/api/crm/employers/${employerId}/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: v }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(json.error || "Failed to add tag");
      return;
    }
    toast.success("Tag added");
    setName("");
    setAdding(false);
    onChanged();
  };

  const handleRemove = async (topic: EmployerTopicAssignment) => {
    const res = await fetch(
      `/api/crm/employers/${employerId}/topics/${topic.topic_id}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      toast.error("Failed to remove tag");
      return;
    }
    toast.success(
      topic.source === "auto" ? "Auto tag dismissed" : "Tag removed",
    );
    setConfirmRemove(null);
    onChanged();
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        <span>Topics ({topics.length})</span>
        <button
          className="text-xs font-bold normal-case text-indigo-600 hover:underline"
          onClick={() => setAdding(true)}
        >
          + Add tag
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {topics.length === 0 && (
          <span className="text-xs text-muted-foreground">
            No topic tags yet.
          </span>
        )}
        {topics.map((t) => (
          <div key={t.id} className="group relative">
            <TopicChipBadge topic={t} />
            <button
              className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border bg-background text-[10px] group-hover:flex"
              onClick={() => setConfirmRemove(t)}
              aria-label="Remove tag"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {adding && (
        <div className="mt-3 flex items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tag name…"
            list="topic-suggestions"
            className="max-w-[200px]"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
              if (e.key === "Escape") {
                setAdding(false);
                setName("");
              }
            }}
          />
          <Button size="sm" onClick={handleAdd}>
            Add
          </Button>
          <button
            className="text-xs font-semibold text-muted-foreground hover:text-foreground"
            onClick={() => {
              setAdding(false);
              setName("");
            }}
          >
            Cancel
          </button>
        </div>
      )}

      <div className="mt-3 text-[10px] text-muted-foreground">
        <span
          className="mr-1 inline-flex h-4 items-center rounded-full px-1.5 text-[9px] font-semibold text-orange-600"
          style={{ border: "1px solid #f97316" }}
        >
          Auto
        </span>{" "}
        from emails &nbsp;·&nbsp;{" "}
        <Badge variant="outline" className="mr-1 h-4 px-1.5 text-[9px]">
          manual
        </Badge>{" "}
        added by you
      </div>

      <Dialog
        open={!!confirmRemove}
        onOpenChange={(o) => !o && setConfirmRemove(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete topic?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {confirmRemove?.source === "auto" ? "Dismiss" : "Delete"} topic “
            {confirmRemove?.name}”? This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRemove(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirmRemove && handleRemove(confirmRemove)}
            >
              Yes, delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Notes tab ─────────────────────────────────────────────────────────────

function NotesTab({
  employerId,
  notes,
  team,
  onChanged,
}: {
  employerId: string;
  notes: EmployerNote[];
  team: TeamMemberSummary[];
  onChanged: () => void;
}) {
  const [content, setContent] = useState(notes[0]?.content ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setContent(notes[0]?.content ?? "");
  }, [notes]);

  const save = async () => {
    if (!content.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/crm/employers/${employerId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error("Save failed");
      toast.success("Note saved");
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-3 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        Notes
      </div>
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={5}
        placeholder="Add a note about this firm…"
      />
      <div className="mt-2 flex justify-end">
        <Button size="sm" onClick={save} disabled={saving || !content.trim()}>
          {saving ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
          Save note
        </Button>
      </div>
      {team.length > 0 && (
        <div className="mt-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Team
          <div className="flex gap-1">
            {team.map((m) => (
              <span
                key={m.id}
                className={cn(
                  "grid h-5 w-5 place-items-center rounded-full bg-gradient-to-br text-[8px] font-bold text-white",
                  colorForId(m.id),
                )}
                title={m.name}
              >
                {initialsOf(m.name)}
              </span>
            ))}
          </div>
          <span className="text-xs font-medium normal-case text-muted-foreground">
            {team.map((m) => m.name.split(" ")[0]).join(", ")}
          </span>
        </div>
      )}
      {notes.length > 1 && (
        <div className="mt-4 text-xs text-muted-foreground">
          Past notes:
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {notes.slice(1).map((n) => (
              <li key={n.id}>
                <span className="text-[10px] text-muted-foreground">
                  {format(new Date(n.created_at), "MMM d, yyyy")}
                </span>{" "}
                — {n.content.slice(0, 80)}
                {n.content.length > 80 ? "…" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Company picker (shared between Add Contact + Curation) ──────────────

interface CompanyPickerValue {
  name: string;
  /** Resolved employer id when an existing firm was picked. */
  id?: string;
  /** True when the user opted to create a new firm from typed text. */
  isNew?: boolean;
}

function CompanyPicker({
  value,
  locked,
  placeholder = "Select company",
  onChange,
}: {
  value: CompanyPickerValue | null;
  locked?: boolean;
  placeholder?: string;
  onChange: (next: CompanyPickerValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [items, setItems] = useState<EmployerSummary[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ limit: "20" });
    if (debounced) params.set("q", debounced);
    fetch(`/api/crm?${params.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setItems((j.data ?? []) as EmployerSummary[]);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, debounced]);

  const hasExact = debounced
    ? items.some((c) => c.name.toLowerCase() === debounced.toLowerCase())
    : false;

  const label = value?.name || placeholder;

  return (
    <Popover open={open && !locked} onOpenChange={(o) => !locked && setOpen(o)}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={locked}
          className={cn(
            "w-full justify-between gap-2 font-medium",
            value?.name &&
              "border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950 dark:text-indigo-200",
            locked && "cursor-default opacity-90",
          )}
        >
          <span className="truncate">{label}</span>
          {!locked && <ChevronDown className="h-3 w-3 flex-shrink-0" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start">
        <Input
          placeholder="Search companies…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mb-2"
          autoFocus
        />
        <div className="max-h-52 overflow-y-auto">
          {loading ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              Loading…
            </div>
          ) : items.length === 0 && !debounced ? (
            <div className="py-3 text-center text-xs text-muted-foreground">
              No companies in CRM yet
            </div>
          ) : items.length === 0 ? (
            <div className="py-3 text-center text-xs text-muted-foreground">
              No matching company
            </div>
          ) : (
            items.map((c) => {
              const isSel = value?.id === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md p-1.5 text-left text-sm hover:bg-muted",
                    isSel &&
                      "font-semibold text-indigo-700 dark:text-indigo-300",
                  )}
                  onClick={() => {
                    onChange({ name: c.name, id: c.id });
                    setOpen(false);
                  }}
                >
                  {c.name}
                </button>
              );
            })
          )}
        </div>
        {debounced && !hasExact && (
          <button
            type="button"
            className="mt-2 flex w-full items-center gap-2 border-t pt-2 text-left text-sm font-semibold text-indigo-600 hover:underline"
            onClick={() => {
              onChange({ name: debounced, isNew: true });
              setOpen(false);
            }}
          >
            <Plus className="h-3 w-3" />
            Create “{debounced}”
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ─── Add-contact dialog ───────────────────────────────────────────────────

function AddContactDialog({
  open,
  onOpenChange,
  employerId,
  employers,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  employerId: string | null;
  employers: EmployerSummary[];
  onCreated: () => void;
}) {
  const [firm, setFirm] = useState<CompanyPickerValue | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setFirm(null);
      setName("");
      setEmail("");
      setPhone("");
      setTitle("");
    } else if (employerId) {
      const existing = employers.find((e) => e.id === employerId);
      setFirm(existing ? { name: existing.name, id: existing.id } : null);
    }
  }, [open, employerId, employers]);

  const lockedFirm = !!employerId;

  const submit = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!firm?.name) {
      toast.error("Firm is required");
      return;
    }
    setSubmitting(true);
    try {
      const targetId = firm.id ?? (await ensureEmployer(firm.name));
      const res = await fetch(`/api/crm/employers/${targetId}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone, title }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Failed to create contact");
      }
      toast.success("Contact created");
      onCreated();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add new contact</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label className="mb-1 block text-[10px] uppercase">
              Company *
            </Label>
            <CompanyPicker
              value={firm}
              locked={lockedFirm}
              onChange={setFirm}
            />
          </div>
          <div>
            <Label className="text-[10px] uppercase">Full name *</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="John Doe"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[10px] uppercase">Email</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="john@example.com"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase">Phone</Label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 234 567 890"
              />
            </div>
          </div>
          <div>
            <Label className="text-[10px] uppercase">Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Managing Director"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            Create contact
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function ensureEmployer(name: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Firm name is required");
  const res = await fetch("/api/crm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: trimmed }),
  });
  const j = await res.json();
  if (res.status === 409) {
    // Already exists — re-fetch it to grab the id
    const list = await fetch("/api/crm?q=" + encodeURIComponent(trimmed)).then(
      (r) => r.json(),
    );
    const found = list.data?.find(
      (e: EmployerSummary) =>
        e.name.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (!found) throw new Error(j.error || "Could not resolve firm");
    return found.id;
  }
  if (!res.ok) throw new Error(j.error || "Failed to create firm");
  return j.data.id;
}

// ─── Curation dialog ───────────────────────────────────────────────────────

interface FlaggedEmployer {
  id: string;
  name: string;
  industry: string | null;
  status: string;
  primary_pic: {
    id: string;
    name: string;
    title: string | null;
    email: string | null;
    phone: string | null;
  } | null;
}

function CurationDialog({
  open,
  onOpenChange,
  onResolved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onResolved: () => void;
}) {
  const [queue, setQueue] = useState<FlaggedEmployer[]>([]);
  const [idx, setIdx] = useState(0);
  const [firm, setFirm] = useState<CompanyPickerValue | null>(null);
  const [picName, setPicName] = useState("");
  const [picTitle, setPicTitle] = useState("");
  const [picEmail, setPicEmail] = useState("");
  const [picPhone, setPicPhone] = useState("");

  useEffect(() => {
    if (!open) return;
    fetch("/api/crm/flagged")
      .then((r) => r.json())
      .then((j) => {
        setQueue((j.data ?? []) as FlaggedEmployer[]);
        setIdx(0);
      });
  }, [open]);

  const current = queue[idx];
  useEffect(() => {
    if (!current) return;
    setFirm({ name: current.name, id: current.id });
    setPicName(current.primary_pic?.name ?? "");
    setPicTitle(current.primary_pic?.title ?? "");
    setPicEmail(current.primary_pic?.email ?? "");
    setPicPhone(current.primary_pic?.phone ?? "");
  }, [current]);

  const advance = () => {
    if (idx + 1 < queue.length) setIdx(idx + 1);
    else {
      onOpenChange(false);
      onResolved();
    }
  };

  const decide = async (decision: "approve" | "skip") => {
    if (!current) return;
    const patch =
      decision === "approve"
        ? {
            name: firm?.name ?? current.name,
            primary_pic: {
              name: picName.trim() || null,
              title: picTitle.trim() || null,
              email: picEmail.trim() || null,
              phone: picPhone.trim() || null,
            },
          }
        : {};
    const res = await fetch(`/api/crm/employers/${current.id}/curate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, patch }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error || "Failed to record decision");
      return;
    }
    toast.success(
      decision === "approve"
        ? "Record approved and published"
        : "Skipped — left in queue",
    );
    advance();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Review flagged records</DialogTitle>
        </DialogHeader>
        {queue.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            Nothing to curate — the queue is clear.
          </p>
        ) : !current ? (
          <p className="py-4 text-sm text-muted-foreground">Done.</p>
        ) : (
          <>
            <div className="mb-2 flex items-center gap-3 text-xs text-muted-foreground">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-orange-100">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-orange-500 to-orange-400 transition-all"
                  style={{
                    width: `${((idx + 1) / queue.length) * 100}%`,
                  }}
                />
              </div>
              <span>
                Record {idx + 1} of {queue.length}
              </span>
            </div>
            <div className="space-y-3 rounded-lg border bg-muted/40 p-3">
              <div>
                <Label className="mb-1 block text-[10px] uppercase">
                  Company
                </Label>
                <CompanyPicker value={firm} onChange={setFirm} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-[10px] uppercase">PIC Name</Label>
                  <Input
                    value={picName}
                    onChange={(e) => setPicName(e.target.value)}
                    placeholder="Unknown — fill in"
                  />
                </div>
                <div>
                  <Label className="text-[10px] uppercase">Title</Label>
                  <Input
                    value={picTitle}
                    onChange={(e) => setPicTitle(e.target.value)}
                    placeholder="Unknown — fill in"
                  />
                </div>
                <div>
                  <Label className="text-[10px] uppercase">Email</Label>
                  <Input
                    value={picEmail}
                    onChange={(e) => setPicEmail(e.target.value)}
                    placeholder="Unknown — fill in"
                  />
                </div>
                <div>
                  <Label className="text-[10px] uppercase">Phone</Label>
                  <Input
                    value={picPhone}
                    onChange={(e) => setPicPhone(e.target.value)}
                    placeholder="Not found"
                  />
                </div>
              </div>
            </div>
          </>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => decide("skip")}
            disabled={!current}
          >
            Skip for now
          </Button>
          <Button onClick={() => decide("approve")} disabled={!current}>
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Pagination ────────────────────────────────────────────────────────────

function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (p: number) => void;
}) {
  const pages = useMemo(() => {
    const set = new Set<number>([1, totalPages, page - 1, page, page + 1]);
    return Array.from(set)
      .filter((n) => n >= 1 && n <= totalPages)
      .sort((a, b) => a - b);
  }, [page, totalPages]);
  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant="outline"
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={page <= 1}
      >
        ‹
      </Button>
      {pages.map((p, i) => (
        <span key={p} className="flex items-center">
          {i > 0 && pages[i - 1] !== p - 1 && (
            <span className="px-1 text-muted-foreground">…</span>
          )}
          <Button
            size="sm"
            variant={p === page ? "default" : "outline"}
            onClick={() => onChange(p)}
          >
            {p}
          </Button>
        </span>
      ))}
      <Button
        size="sm"
        variant="outline"
        onClick={() => onChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
      >
        ›
      </Button>
    </div>
  );
}
