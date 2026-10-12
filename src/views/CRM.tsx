"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AlertTriangle, Loader2, Search, Users, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import posthog from "posthog-js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";

import { AddContactDialog } from "./crm/AddContactDialog";
import { CurationDialog } from "./crm/CurationDialog";
import { EmployerCard } from "./crm/EmployerCard";
import { CrmHeader } from "./crm/Header";
import { LastContactFilter } from "./crm/LastContactFilter";
import { Pagination } from "./crm/Pagination";
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
import { LAST_CONTACT_LABELS, PAGE_SIZE, TOPIC_SUGGESTIONS } from "./crm/utils";

export default function CRM() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id ?? null;

  // Deep-link support (e.g. from the dashboard's "Banker related companies"
  // card): `?firm=<name>` seeds the search so the row surfaces in the list,
  // `?employerId=<id>` picks which card to auto-expand. Read once on mount.
  const [initialFirm] = useState(() => searchParams.get("firm") ?? "");
  const [initialEmployerId] = useState(() => searchParams.get("employerId"));

  const [employers, setEmployers] = useState<EmployerSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState(initialFirm);
  const [debouncedSearch, setDebouncedSearch] = useState(initialFirm);

  const [lastContact, setLastContact] = useState<LastContactPreset | null>(
    null,
  );
  const [customDate, setCustomDate] = useState<string>("");
  const [topicFilter, setTopicFilter] = useState<Set<string>>(new Set());
  const [teamFilter, setTeamFilter] = useState<Set<string>>(new Set());

  const [topics, setTopics] = useState<Topic[]>([]);
  const [teamUsers, setTeamUsers] = useState<TeamMemberSummary[]>([]);

  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(initialEmployerId);
  const [details, setDetails] = useState<Record<string, EmployerDetail>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);

  const [addContactOpen, setAddContactOpen] = useState(false);
  const [addContactEmployerId, setAddContactEmployerId] = useState<
    string | null
  >(null);

  const [curationOpen, setCurationOpen] = useState(false);

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
    const handle = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(handle);
  }, [search]);

  // ─── Fetch employers ──────────────────────────────────────────────────────
  const fetchEmployers = useCallback(async () => {
    if (authLoading || !userId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (lastContact) params.set("lastContact", lastContact);
      if (lastContact === "custom" && customDate)
        params.set("customDate", customDate);
      
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      params.set("clientTodayIso", today.toISOString());
      
      topicFilter.forEach((id) => params.append("topicId", id));
      teamFilter.forEach((id) => params.append("teamUserId", id));
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));
      const localMidnight = new Date();
      localMidnight.setHours(0, 0, 0, 0);
      params.set("clientTodayIso", localMidnight.toISOString());

      const res = await fetch(`/api/crm?${params.toString()}`, {
        credentials: "same-origin",
      });
      const json = await res.json();
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) throw new Error(json.error || "Failed to load CRM");
      setEmployers(json.data);
      setTotal(json.total);
      setInsights(json.insights);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [
    authLoading,
    userId,
    debouncedSearch,
    lastContact,
    customDate,
    topicFilter,
    teamFilter,
    page,
    handleUnauthorized,
  ]);

  useEffect(() => {
    fetchEmployers();
  }, [fetchEmployers]);

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
          onOpenAddContact={() => {
            setAddContactEmployerId(null);
            setAddContactOpen(true);
          }}
          onShowStale={() => {
            setLastContact("stale_30");
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
            <Card className="border bg-gradient-to-br from-muted/40 to-muted/10">
              <CardContent className="pt-6">
                {/* Toolbar */}
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <div className="relative min-w-[180px] flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="Search by company name or PIC name…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="pl-9 bg-background"
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
                      posthog.capture("crm_banker_filter_applied", {
                        banker_count: next.size,
                        banker_ids: Array.from(next),
                      });
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
                        className="inline-flex items-center gap-1 rounded-md bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700 hover:bg-blue-600 hover:text-white dark:bg-blue-950 dark:text-blue-300"
                        onClick={t.clear}
                      >
                        {t.label}
                        <X className="h-3 w-3" />
                      </button>
                    ))}
                  </div>
                )}

                {/* Column headers */}
                <div className="mb-1 grid grid-cols-[36px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.1fr)_28px] gap-3 px-3 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  <div />
                  <div>Source</div>
                  <div>Industry Focus</div>
                  <div>Primary PIC</div>
                  <div>Response p50</div>
                  <div>Last Contact</div>
                  <div>Topics</div>
                  <div>Team Member</div>
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
          fetchEmployers();
          if (addContactEmployerId) loadDetail(addContactEmployerId);
        }}
      />

      <CurationDialog
        open={curationOpen}
        onOpenChange={setCurationOpen}
        onResolved={() => fetchEmployers()}
      />
    </>
  );
}
