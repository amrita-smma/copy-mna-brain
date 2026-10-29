"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  listBankers,
  type BankerListResult,
  type BankerListSort,
} from "@/lib/api/crmBankers";
import { AlertTriangle, FileUp, Loader2, Plus, Search, Users, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import posthog from "posthog-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

import { AddContactDialog } from "./crm/AddContactDialog";
import { AskBrainRow } from "./crm/AskBrainRow";
import { BankersTable } from "./crm/BankersTable";
import {
  ContactInsightsPanel,
  type ContactPanelSeed,
} from "./crm/ContactInsightsPanel";
import { CurationDialog } from "./crm/CurationDialog";
import { EmployerCard, FIRM_GRID } from "./crm/EmployerCard";
import { ImportContactsDialog } from "./crm/ImportContactsDialog";
import { CrmHeader } from "./crm/Header";
import { LastContactFilter } from "./crm/LastContactFilter";
import { Pagination } from "./crm/Pagination";
import { SortHeader } from "./crm/SortHeader";
import { TeamFilter } from "./crm/TeamFilter";
import { TopicFilter } from "./crm/TopicFilter";
import type {
  EmployerDetail,
  EmployerSummary,
  Insights,
  LastContactPreset,
  TeamMemberSummary,
  Topic,
} from "./crm/types";
import {
  LAST_CONTACT_LABELS,
  localMidnightIso,
  NEEDS_DEAL_LINKS,
  PAGE_SIZE,
  TOPIC_SUGGESTIONS,
} from "./crm/utils";
import {
  DEFAULT_EMPLOYER_LIST_SORT,
  EMPLOYER_LIST_SORT_DEFAULT_DIR,
  type EmployerListSort,
  type SortDirection,
} from "@/lib/crm/employerListSort";

type CrmView = "firms" | "bankers";

const VIEW_PARAM: Record<Exclude<CrmView, "firms">, string> = {
  bankers: "bankers",
};

const VIEW_LABEL: Record<CrmView, string> = {
  firms: "Firms",
  bankers: "Bankers",
};

const BANKERS_PAGE_SIZE = 25;

const BANKER_SORT_LABELS: Record<BankerListSort, string> = {
  recent: "Most recent contact",
  deals_brought: "Most deals brought",
  reached_l1: "Leads that reach L1",
  team_members: "Most team members",
  emails: "Most emails",
};

interface CRMProps {
  /** `CRM_BANKERS_VIEW_ENABLED`: the Firms | Bankers toggle and the Bankers list. */
  showBankersView?: boolean;
}

export default function CRM({ showBankersView = false }: CRMProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id ?? null;

  // Deep-link support: `?q=<text>` is the search box (kept in sync below, so a
  // searched view is shareable/reloadable); `?firm=<name>` is the older seed
  // from the dashboard's "Banker related companies" card; `?employerId=<id>`
  // picks which card to auto-expand. Read once on mount.
  const [initialFirm] = useState(
    () => searchParams.get("q") ?? searchParams.get("firm") ?? "",
  );
  const [initialEmployerId] = useState(() => searchParams.get("employerId"));
  // `?view=bankers` keeps the view across a reload (flag on only).
  const [view, setView] = useState<CrmView>(() => {
    const param = searchParams.get("view");
    if (showBankersView && param === VIEW_PARAM.bankers) return "bankers";
    return "firms";
  });
  const views: CrmView[] = ["firms", ...(showBankersView ? (["bankers"] as const) : [])];

  const [employers, setEmployers] = useState<EmployerSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState(initialFirm);
  const [debouncedSearch, setDebouncedSearch] = useState(initialFirm);
  // The search the current `employers` page was fetched with — lags
  // `debouncedSearch` while a fetch is in flight, so the auto-expand below
  // never acts on the previous search's rows.
  const [resultSearch, setResultSearch] = useState("");
  const autoExpandedFor = useRef<string | null>(null);

  const [lastContact, setLastContact] = useState<LastContactPreset | null>(
    null,
  );
  const [customDate, setCustomDate] = useState<string>("");
  const [topicFilter, setTopicFilter] = useState<Set<string>>(new Set());
  const [teamFilter, setTeamFilter] = useState<Set<string>>(new Set());

  const [topics, setTopics] = useState<Topic[]>([]);
  const [teamUsers, setTeamUsers] = useState<TeamMemberSummary[]>([]);

  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<EmployerListSort>(DEFAULT_EMPLOYER_LIST_SORT);
  const [sortDir, setSortDir] = useState<SortDirection>(
    EMPLOYER_LIST_SORT_DEFAULT_DIR[DEFAULT_EMPLOYER_LIST_SORT],
  );
  const [expandedId, setExpandedId] = useState<string | null>(initialEmployerId);
  const [details, setDetails] = useState<Record<string, EmployerDetail>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);

  const [addContactOpen, setAddContactOpen] = useState(false);
  const [addContactEmployerId, setAddContactEmployerId] = useState<
    string | null
  >(null);

  // ─── Bankers view state ───────────────────────────────────────────────────
  // The latest page fetched; null until the first one lands. A change to the
  // search, a filter or the sort sets `bankerPage` back to 1 in the same
  // handler, so no request is sent for the old page.
  const [bankers, setBankers] = useState<BankerListResult | null>(null);
  const [bankersLoading, setBankersLoading] = useState(false);
  const [bankerPage, setBankerPage] = useState(1);
  const [bankerSort, setBankerSort] = useState<BankerListSort>("recent");
  const [hasDealsOnly, setHasDealsOnly] = useState(false);
  const [active30, setActive30] = useState(false);
  const bankerRequestRef = useRef(0);

  // Record-scoped panel: open is derived from the selection
  // (.claude/rules/dialog-open-state.md); the panel fetches its own data.
  const [selectedContact, setSelectedContact] =
    useState<ContactPanelSeed | null>(null);

  const [curationOpen, setCurationOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const handleUnauthorized = useCallback(() => {
    toast.error("Your session has expired. Please sign in again.");
    router.replace("/login");
  }, [router]);

  // ─── Track CRM usage (fires once per mount) ───────────────────────────────
  useEffect(() => {
    posthog.capture("crm_viewed");
  }, []);

  // ─── Debounce search ──────────────────────────────────────────────────────
  useEffect(() => {
    const next = search.trim();
    if (next === debouncedSearch) return;
    // A new term starts both views from page 1 — keeping the old page would
    // ask for an offset past the end of a narrower result.
    const handle = setTimeout(() => {
      setDebouncedSearch(next);
      setPage(1);
      setBankerPage(1);
    }, 250);
    return () => clearTimeout(handle);
  }, [search, debouncedSearch]);

  // Mirror the search into `?q=`. `history.replaceState`, not router.replace:
  // it updates the URL bar without a Next.js soft navigation, so the server
  // page doesn't re-run on every debounced keystroke. `firm` was only a seed.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("firm");
    if (debouncedSearch) url.searchParams.set("q", debouncedSearch);
    else url.searchParams.delete("q");
    // With the flag off, a bookmarked `?view=…` lands on Firms.
    if (view === "firms") url.searchParams.delete("view");
    else url.searchParams.set("view", VIEW_PARAM[view]);
    if (url.href !== window.location.href) {
      window.history.replaceState(window.history.state, "", url);
    }
  }, [debouncedSearch, view]);

  // ─── Fetch employers ──────────────────────────────────────────────────────
  // Search, filters, sort and paging are all server-side; the page holds one
  // PAGE_SIZE slice. Only the latest request may write state: typing or
  // paging quickly leaves earlier requests in flight, and a slow one landing
  // late would replace the newer result, so superseded requests are aborted.
  const listAbortRef = useRef<AbortController | null>(null);

  const fetchEmployers = useCallback(async () => {
    if (authLoading || !userId) return;
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (lastContact) params.set("lastContact", lastContact);
      if (lastContact === "custom" && customDate)
        params.set("customDate", customDate);
      params.set("clientTodayIso", localMidnightIso());
      topicFilter.forEach((id) => params.append("topicId", id));
      teamFilter.forEach((id) => params.append("teamUserId", id));
      params.set("sort", sort);
      params.set("dir", sortDir);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));

      const res = await fetch(`/api/crm?${params.toString()}`, {
        credentials: "same-origin",
        signal: controller.signal,
      });
      const json = await res.json();
      if (controller.signal.aborted) return;
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) throw new Error(json.error || "Failed to load CRM");
      setEmployers(json.data);
      setResultSearch(debouncedSearch);
      setTotal(json.total);
    } catch (err) {
      if (controller.signal.aborted) return;
      toast.error((err as Error).message);
    } finally {
      if (listAbortRef.current === controller) {
        listAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [
    authLoading,
    userId,
    debouncedSearch,
    lastContact,
    customDate,
    topicFilter,
    teamFilter,
    sort,
    sortDir,
    page,
    handleUnauthorized,
  ]);

  useEffect(() => {
    fetchEmployers();
  }, [fetchEmployers]);

  useEffect(() => () => listAbortRef.current?.abort(), []);

  // ─── Insights bar ─────────────────────────────────────────────────────────
  // Workspace-wide counts that don't depend on the search, filters or page, so
  // they load once and refresh after a mutation — not on every keystroke.
  const fetchInsights = useCallback(async () => {
    if (authLoading || !userId) return;
    try {
      const params = new URLSearchParams({ clientTodayIso: localMidnightIso() });
      const res = await fetch(`/api/crm/insights?${params.toString()}`, {
        credentials: "same-origin",
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) return;
      const json = await res.json();
      setInsights(json.data ?? null);
    } catch {
      // The bar keeps its last values; the list is what matters.
    }
  }, [authLoading, userId, handleUnauthorized]);

  useEffect(() => {
    fetchInsights();
  }, [fetchInsights]);

  const refreshListAndInsights = useCallback(() => {
    fetchEmployers();
    fetchInsights();
  }, [fetchEmployers, fetchInsights]);

  // ─── Fetch bankers (Bankers view) ─────────────────────────────────────────
  // Sorting, filtering and paging are server-side; a request-id guard drops a
  // slow earlier response so it never paints over the latest filters.
  const fetchBankers = useCallback(async () => {
    if (authLoading || !userId || view !== "bankers") return;
    const requestId = ++bankerRequestRef.current;
    setBankersLoading(true);
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const data = await listBankers({
        q: debouncedSearch || undefined,
        sort: bankerSort,
        lastContact,
        customDate: lastContact === "custom" ? customDate : undefined,
        clientTodayIso: today.toISOString(),
        teamUserIds: Array.from(teamFilter),
        hasDeals: hasDealsOnly,
        active30,
        page: bankerPage,
        pageSize: BANKERS_PAGE_SIZE,
      });
      if (bankerRequestRef.current !== requestId) return;
      setBankers(data);
    } catch (err) {
      if (bankerRequestRef.current === requestId) {
        toast.error((err as Error).message || "Failed to load bankers");
      }
    } finally {
      if (bankerRequestRef.current === requestId) setBankersLoading(false);
    }
  }, [
    authLoading,
    userId,
    view,
    debouncedSearch,
    bankerSort,
    lastContact,
    customDate,
    teamFilter,
    hasDealsOnly,
    active30,
    bankerPage,
  ]);

  useEffect(() => {
    fetchBankers();
  }, [fetchBankers]);

  // Clicking the active column flips its direction; a new column starts in
  // its natural direction (A→Z, fastest, latest, most).
  const handleSort = useCallback(
    (column: EmployerListSort) => {
      if (column === sort) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSort(column);
        setSortDir(EMPLOYER_LIST_SORT_DEFAULT_DIR[column]);
      }
      setPage(1);
    },
    [sort],
  );
  const sortProps = { sort, direction: sortDir, onSort: handleSort };

  // ─── Load filter sources ──────────────────────────────────────────────────
  useEffect(() => {
    if (authLoading || !userId) return;
    fetch("/api/crm/topics", { credentials: "same-origin" })
      .then(async (r) => {
        const j = await r.json();
        if (r.status === 401) {
          handleUnauthorized();
          return null;
        }
        return j;
      })
      .then((j) => j && setTopics(j.data ?? []))
      .catch(() => undefined);
    fetch("/api/crm/team-users", { credentials: "same-origin" })
      .then(async (r) => {
        const j = await r.json();
        if (r.status === 401) {
          handleUnauthorized();
          return null;
        }
        return j;
      })
      .then((j) => j && setTeamUsers(j.data ?? []))
      .catch(() => undefined);
  }, [authLoading, userId, handleUnauthorized]);

  // ─── Card expand / detail load ────────────────────────────────────────────
  const loadDetail = useCallback(async (id: string) => {
    if (authLoading || !userId) return;
    setLoadingDetail(id);
    try {
      const res = await fetch(`/api/crm/employers/${id}`, {
        credentials: "same-origin",
      });
      const json = await res.json();
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) throw new Error(json.error || "Failed to load employer");
      setDetails((prev) => ({ ...prev, [id]: json.data }));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoadingDetail(null);
    }
  }, [authLoading, userId, handleUnauthorized]);

  const toggleExpand = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
    } else {
      setExpandedId(id);
      if (!details[id]) loadDetail(id);
    }
  };

  // A deep-linked employer (`?employerId=`) is expanded from the initial state
  // above; load its detail once auth is ready. Runs once — after that,
  // expand/collapse is driven by toggleExpand.
  useEffect(() => {
    if (authLoading || !userId) return;
    if (initialEmployerId && !details[initialEmployerId]) {
      loadDetail(initialEmployerId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, userId, initialEmployerId]);

  // A person search opens the first firm with a matching contact (the card
  // then shows only the matching people). Once per search term, so collapsing
  // it or paging doesn't keep re-opening it. One detail fetch, never a fan-out.
  useEffect(() => {
    if (!resultSearch) {
      autoExpandedFor.current = null;
      return;
    }
    if (resultSearch !== debouncedSearch) return;
    if (autoExpandedFor.current === resultSearch) return;
    autoExpandedFor.current = resultSearch;
    const first = employers.find((e) => (e.matched_contacts?.length ?? 0) > 0);
    if (!first) return;
    setExpandedId(first.id);
    loadDetail(first.id);
  }, [employers, resultSearch, debouncedSearch, loadDetail]);

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
          setBankerPage(1);
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
        clear: () => {
          setTeamFilter((s) => {
            const next = new Set(s);
            next.delete(id);
            return next;
          });
          setBankerPage(1);
        },
      });
    });
    if (view === "bankers") {
      if (hasDealsOnly) {
        tags.push({
          key: "hasDeals",
          label: "Has linked deals",
          clear: () => {
            setHasDealsOnly(false);
            setBankerPage(1);
          },
        });
      }
      if (active30) {
        tags.push({
          key: "active30",
          label: "Active in last 30 days",
          clear: () => {
            setActive30(false);
            setBankerPage(1);
          },
        });
      }
    }
    return tags;
  }, [lastContact, topicFilter, teamFilter, topics, teamUsers, view, hasDealsOnly, active30]);

  // Topic chips belong to the Firms view only.
  const visibleTags =
    view === "bankers"
      ? activeTags.filter((t) => !t.key.startsWith("topic:"))
      : activeTags;

  const clearBankerFilters = () => {
    setSearch("");
    setLastContact(null);
    setCustomDate("");
    setTeamFilter(new Set());
    setHasDealsOnly(false);
    setActive30(false);
    setBankerPage(1);
  };

  const bankerTotal = bankers?.total ?? 0;
  const bankerTotalPages = Math.max(1, Math.ceil(bankerTotal / BANKERS_PAGE_SIZE));

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <datalist id="topic-suggestions">
        {TOPIC_SUGGESTIONS.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div className="flex flex-col h-full">
        <CrmHeader
          insights={insights}
          onShowStale={() => {
            setLastContact("stale_30");
            setPage(1);
            setBankerPage(1);
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
          <div className="mx-auto flex max-w-screen-2xl flex-col gap-4 px-7 py-3">
            <AskBrainRow userId={userId} />
            <Card className="border bg-card">
              <CardContent className="pt-6">
                {/* Toolbar — search, the filters, then the actions pushed right;
                    the row wraps when it overflows. */}
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  {views.length > 1 && (
                    <div
                      role="group"
                      aria-label="CRM view"
                      className="inline-flex shrink-0 rounded-md border bg-muted p-0.5"
                      data-testid="crm-view-toggle"
                    >
                      {views.map((v) => (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={view === v}
                          onClick={() => setView(v)}
                          className={cn(
                            "rounded px-3 py-1 text-sm font-semibold transition-colors",
                            view === v
                              ? "bg-background text-foreground shadow-sm"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                          data-testid={`crm-view-${v}`}
                        >
                          {VIEW_LABEL[v]}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="relative min-w-[240px] flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder={
                        view === "bankers"
                          ? "Search by name, email or firm…"
                          : "Search by firm, contact name or email…"
                      }
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="pl-9 pr-9 bg-background"
                    />
                    {(view === "bankers"
                      ? bankersLoading
                      : loading && employers.length > 0) && (
                      <Loader2 className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                    )}
                  </div>

                  <LastContactFilter
                    value={lastContact}
                    customDate={customDate}
                    onChange={(v, custom) => {
                      setLastContact(v);
                      setCustomDate(custom ?? "");
                      setPage(1);
                      setBankerPage(1);
                    }}
                  />

                  {view === "firms" && (
                    <TopicFilter
                      topics={topics}
                      selected={topicFilter}
                      onChange={(next) => {
                        setTopicFilter(next);
                        setPage(1);
                      }}
                    />
                  )}

                  <TeamFilter
                    users={teamUsers}
                    selected={teamFilter}
                    onChange={(next) => {
                      posthog.capture("crm_banker_filter_applied", {
                        banker_count: next.size,
                        banker_ids: Array.from(next),
                      });
                      setTeamFilter(next);
                      setPage(1);
                      setBankerPage(1);
                    }}
                  />
                  {view === "bankers" && (
                    <>
                      <Select
                        value={bankerSort}
                        onValueChange={(v) => {
                          setBankerSort(v as BankerListSort);
                          setBankerPage(1);
                        }}
                      >
                        <SelectTrigger
                          className="h-9 w-[200px] bg-background"
                          aria-label="Sort bankers"
                          data-testid="crm-bankers-sort"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(Object.keys(BANKER_SORT_LABELS) as BankerListSort[]).map(
                            (key) => {
                              const disabled =
                                key === "reached_l1" && bankers?.hasDealLinks === false;
                              return disabled ? (
                                <Tooltip key={key}>
                                  <TooltipTrigger asChild>
                                    <div>
                                      <SelectItem value={key} disabled>
                                        {BANKER_SORT_LABELS[key]}
                                      </SelectItem>
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent side="left">
                                    {NEEDS_DEAL_LINKS}
                                  </TooltipContent>
                                </Tooltip>
                              ) : (
                                <SelectItem
                                  key={key}
                                  value={key}
                                  data-testid={`crm-bankers-sort-${key}`}
                                >
                                  {BANKER_SORT_LABELS[key]}
                                </SelectItem>
                              );
                            },
                          )}
                        </SelectContent>
                      </Select>

                      {(
                        [
                          ["has-deals", "Has linked deals", hasDealsOnly, setHasDealsOnly],
                          ["active30", "Active in last 30 days", active30, setActive30],
                        ] as const
                      ).map(([id, label, on, set]) => (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => {
                            set(!on);
                            setBankerPage(1);
                          }}
                          className={cn(
                            "h-9 rounded-md border px-3 text-sm font-medium transition-colors",
                            on
                              ? "border-primary bg-primary text-primary-foreground"
                              : "bg-background text-muted-foreground hover:text-foreground",
                          )}
                          data-testid={`crm-bankers-chip-${id}`}
                        >
                          {label}
                        </button>
                      ))}
                    </>
                  )}

                  <div className="ml-auto flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setImportOpen(true)}
                      data-testid="contact-import-open"
                    >
                      <FileUp className="mr-2 h-4 w-4" />
                      Import
                    </Button>

                    <Button
                      size="sm"
                      onClick={() => {
                        setAddContactEmployerId(null);
                        setAddContactOpen(true);
                      }}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add Contact
                    </Button>
                  </div>
                </div>

                {/* Active filter chips */}
                {visibleTags.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-1">
                    {visibleTags.map((t) => (
                      <button
                        key={t.key}
                        className="inline-flex items-center gap-1 rounded-md bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700 hover:bg-blue-600 hover:text-white dark:bg-blue-950 dark:text-blue-300"
                        onClick={t.clear}
                      >
                        {t.label}
                        <X className="h-3 w-3" />
                      </button>
                    ))}
                  </div>
                )}

                {view === "bankers" ? (
                  <>
                    <div
                      className="mb-2 flex items-center gap-3 text-sm text-muted-foreground"
                      data-testid="crm-bankers-count"
                    >
                      <span>
                        <strong className="text-foreground">{bankerTotal}</strong> of{" "}
                        {bankers?.totalUnfiltered ?? 0} bankers
                      </span>
                      {(visibleTags.length > 0 || debouncedSearch) && (
                        <button
                          type="button"
                          className="text-xs font-semibold text-primary hover:underline"
                          onClick={clearBankerFilters}
                          data-testid="crm-bankers-clear"
                        >
                          Clear all
                        </button>
                      )}
                      {bankersLoading && bankers && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                    </div>
                    {!bankers ? (
                      <div className="flex items-center justify-center py-16">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    ) : bankers.rows.length === 0 ? (
                      <div
                        className="flex flex-col items-center gap-2 py-16 text-muted-foreground"
                        data-testid="crm-bankers-empty"
                      >
                        <Users className="h-10 w-10 opacity-50" />
                        <p>No bankers match these filters.</p>
                        {(visibleTags.length > 0 || debouncedSearch) && (
                          <Button size="sm" variant="outline" onClick={clearBankerFilters}>
                            Clear all filters
                          </Button>
                        )}
                      </div>
                    ) : (
                      <BankersTable
                        rows={bankers.rows}
                        hasSyncedData={bankers.hasSyncedData}
                        hasDealLinks={bankers.hasDealLinks}
                        onOpen={(row) =>
                          setSelectedContact({
                            id: row.correspondentId,
                            name: row.name,
                            title: row.title,
                          })
                        }
                      />
                    )}
                    {bankerTotal > BANKERS_PAGE_SIZE && (
                      <div className="mt-6 flex items-center justify-between border-t pt-4">
                        <div className="text-sm text-muted-foreground">
                          Showing {(bankerPage - 1) * BANKERS_PAGE_SIZE + 1}–
                          {Math.min(bankerPage * BANKERS_PAGE_SIZE, bankerTotal)} of{" "}
                          <strong>{bankerTotal}</strong>
                        </div>
                        <Pagination
                          page={bankerPage}
                          totalPages={bankerTotalPages}
                          onChange={setBankerPage}
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {/* Column headers */}
                    <div className={cn(FIRM_GRID, "rounded-t-lg border border-b-0 bg-muted py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground")}>
                      <div><SortHeader column="name" {...sortProps}>Source</SortHeader></div>
                      <div><SortHeader column="industry" {...sortProps}>Industry</SortHeader></div>
                      <div><SortHeader column="primary_pic" {...sortProps}>PIC</SortHeader></div>
                      <div><SortHeader column="last_contact" {...sortProps}>Activity</SortHeader></div>
                      <div><SortHeader column="emails" {...sortProps}>Topics</SortHeader></div>
                      <div><SortHeader column="team_members" {...sortProps}>Team</SortHeader></div>
                      <div />
                    </div>

                    {/* Cards. Only show the full-list spinner on the INITIAL load
                        (no rows yet). A background refetch — e.g. after reclassifying a
                        topic, which calls onRefreshList to refresh the collapsed-row
                        topic summary — keeps the existing list rendered and updates it
                        in place. Blanking the list to a spinner on every refresh
                        unmounted the expanded card and reset its tab to Contacts. */}
                    {loading && employers.length === 0 ? (
                      <div className="flex items-center justify-center py-16">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    ) : employers.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
                        <Users className="h-10 w-10 opacity-50" />
                        <p>No employers match these filters.</p>
                      </div>
                    ) : (
                      <div className="divide-y overflow-hidden rounded-b-lg border">
                        {employers.map((emp) => (
                          <EmployerCard
                            key={emp.id}
                            employer={emp}
                            expanded={expandedId === emp.id}
                            searchTerm={resultSearch}
                            detail={details[emp.id]}
                            loadingDetail={loadingDetail === emp.id}
                            onToggle={() => toggleExpand(emp.id)}
                            onAddContact={() => {
                              setAddContactEmployerId(emp.id);
                              setAddContactOpen(true);
                            }}
                            onRefreshDetail={() => loadDetail(emp.id)}
                            onRefreshList={refreshListAndInsights}
                            onOpenContact={setSelectedContact}
                          />
                        ))}
                      </div>
                    )}

                    {/* Pagination */}
                    {total > 0 && (
                      <div className="mt-6 flex items-center justify-between border-t pt-4">
                        <div className="text-sm text-muted-foreground">
                          Showing {(page - 1) * PAGE_SIZE + 1}–
                          {Math.min(page * PAGE_SIZE, total)} of{" "}
                          <strong>{total}</strong>{" "}
                          {total === 1 ? "company" : "companies"}
                        </div>
                        {total > PAGE_SIZE && (
                          <Pagination
                            page={page}
                            totalPages={totalPages}
                            onChange={setPage}
                          />
                        )}
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
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
          refreshListAndInsights();
          if (addContactEmployerId) loadDetail(addContactEmployerId);
        }}
      />

      <ImportContactsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => {
          refreshListAndInsights();
          if (expandedId) loadDetail(expandedId);
        }}
      />

      {selectedContact && (
        <ContactInsightsPanel
          key={selectedContact.id}
          contact={selectedContact}
          open={!!selectedContact}
          onOpenChange={(open) => {
            if (!open) setSelectedContact(null);
          }}
          onChanged={view === "bankers" ? () => void fetchBankers() : undefined}
        />
      )}

      <CurationDialog
        open={curationOpen}
        onOpenChange={setCurationOpen}
        onResolved={refreshListAndInsights}
      />
    </>
  );
}
