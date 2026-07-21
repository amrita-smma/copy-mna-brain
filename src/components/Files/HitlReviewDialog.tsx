"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertCircle, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { MatchedCompanyCombobox, AUTO, type CompanyOption } from "./MatchedCompanyCombobox";
import type { ApproveFileInput } from "@/lib/services/fileService";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/useAuth";
import { getUsers, type UserSummary } from "@/lib/api/pipeline";
import UserSelectCombobox from "@/components/pipeline/UserSelectCombobox";

interface SuggestedCompany {
  target: string | null;
  project_name: string | null;
  segment: string | null;
  segment_related_offerings: string | null;
  company_focus: string | null;
  website: string | null;
  watchlist_status: string | null;
  comments: string | null;
  ownership: string | null;
  geography: string | null;
  remarks: string | null;
}

interface FinancialRow {
  fiscal_year: number;
  revenue_usd_mn: number | null;
  ebitda_usd_mn: number | null;
  ev_usd_mn: number | null;
  ebitda_margin: number | null;
  ev_ebitda: number | null;
  revenue_cagr_vs_prior: number | null;
}

interface ReviewData {
  file: { id: string; file_name: string; file_type: string | null };
  ai: {
    file_type: string | null;
    suggested_company: SuggestedCompany | null;
    suggested_banker: string | null;
    financials: FinancialRow[];
  };
  current: {
    company: Record<string, unknown> | null;
    financials: FinancialRow[];
  };
  conflicts: unknown[];
}

const FINANCIAL_COLUMNS: Array<{ key: keyof Omit<FinancialRow, "fiscal_year">; label: string; format: (v: number | null) => string }> = [
  { key: "revenue_usd_mn", label: "Revenue (USD mn)", format: (v) => (v == null ? "—" : v.toLocaleString()) },
  { key: "ebitda_usd_mn", label: "EBITDA (USD mn)", format: (v) => (v == null ? "—" : v.toLocaleString()) },
  { key: "ev_usd_mn", label: "EV (USD mn)", format: (v) => (v == null ? "—" : v.toLocaleString()) },
  { key: "ebitda_margin", label: "EBITDA margin", format: (v) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`) },
  { key: "ev_ebitda", label: "EV/EBITDA", format: (v) => (v == null ? "—" : v.toFixed(2)) },
  { key: "revenue_cagr_vs_prior", label: "Revenue CAGR YoY", format: (v) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`) },
];

/**
 * Identity fields — surfaced next to the matched-company picker (not in the
 * generic metadata table) because they uniquely identify a company together
 * with `target` (at least one is always filled).
 */
const IDENTITY_FIELDS: Array<{ key: "target" | "project_name"; label: string }> = [
  { key: "target", label: "Company name" },
  { key: "project_name", label: "Project name" },
];

const ENRICHABLE_FIELDS: Array<{ key: keyof SuggestedCompany; label: string }> = [
  { key: "segment", label: "Segment" },
  { key: "segment_related_offerings", label: "Related offerings" },
  { key: "company_focus", label: "Company focus" },
  { key: "website", label: "Website" },
  { key: "watchlist_status", label: "Watchlist status" },
  { key: "comments", label: "Comments" },
  { key: "ownership", label: "Ownership" },
  { key: "geography", label: "Geography" },
  { key: "remarks", label: "Remarks" },
];

interface Props {
  fileId: string;
  open: boolean;
  onClose: () => void;
  onApproved: () => void;
}

export function HitlReviewDialog({ fileId, open, onClose, onApproved }: Props) {
  const { user } = useAuth();
  // `loading` covers the FIRST fetch only — the body is replaced with a
  // spinner because there's nothing to show yet. `refreshing` is for
  // subsequent fetches (company switch, etc.) where we keep the existing
  // data mounted and just dim it during the in-flight request.
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reviewData, setReviewData] = useState<ReviewData | null>(null);

  const [fileType, setFileType] = useState<string>("other");
  const [matchedCompanyId, setMatchedCompanyId] = useState<string>(AUTO);
  const [createFromAi, setCreateFromAi] = useState(false);
  const [checkedFields, setCheckedFields] = useState<Record<string, boolean>>({});
  const [checkedYears, setCheckedYears] = useState<Record<number, boolean>>({});
  // Required L0 fields the user must fill when creating a new company from AI
  const [l0EnteredBy, setL0EnteredBy] = useState("");
  const [l0DealType, setL0DealType] = useState<"majority" | "minority" | "">("");
  const [l0Banker, setL0Banker] = useState("");
  const [l0Source, setL0Source] = useState<"inbound" | "outbound">("inbound");
  const [l0Geography, setL0Geography] = useState("");
  const [l0Segment, setL0Segment] = useState("");
  const [missingFields, setMissingFields] = useState<string[]>([]);
  // Users for the editable "Entered By" picker (entered_by is a uuid FK).
  const [users, setUsers] = useState<UserSummary[]>([]);

  // Initial load — fetch with no override so the server falls back to the
  // company stored on the file. Sets the initial matched-company state too.
  useEffect(() => {
    if (!open) return;
    setL0EnteredBy(user?.id ?? "");
    setL0DealType("");
    setL0Banker("");
    setL0Source("inbound");
    setL0Geography("");
    setL0Segment("");
    setMissingFields([]);
    if (users.length === 0) {
      getUsers()
        .then(setUsers)
        .catch((err) => console.error("Failed to load users:", err));
    }
    setLoading(true);
    fetch(`/api/ai-file-dump/${fileId}/review`)
      .then((r) => r.json())
      .then((res) => {
        if (!res.success) throw new Error(res.error);
        const data: ReviewData = res.data;
        setReviewData(data);
        setFileType(data.ai.file_type ?? "other");

        const matched = (data.file as unknown as { matched_companies?: Array<{ id?: string | null }> })
          .matched_companies ?? [];
        const firstWithId = matched.find((m) => typeof m?.id === "string" && m.id);
        setMatchedCompanyId(firstWithId?.id ?? AUTO);
        const willCreateFromAi = !firstWithId && !!data.ai.suggested_company;
        setCreateFromAi(willCreateFromAi);
        if (willCreateFromAi) {
          if (data.ai.suggested_banker) setL0Banker(data.ai.suggested_banker);
          // Pre-fill the required Geo / Sector inputs from what the AI extracted
          // so the reviewer only has to fill what's genuinely missing.
          if (data.ai.suggested_company?.geography) {
            setL0Geography(data.ai.suggested_company.geography);
          }
          if (data.ai.suggested_company?.segment) {
            setL0Segment(data.ai.suggested_company.segment);
          }
        }

        applyDefaultChecks(data);
      })
      .catch((err) => {
        toast.error("Failed to load review data");
        console.error(err);
      })
      .finally(() => setLoading(false));
    // Intentionally only depends on open/fileId — refetches on company change
    // are handled by the second effect below so we don't reset the user's
    // dropdown selection on every load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fileId]);

  // Refetch the diff when the user picks a different company in the
  // dropdown (or switches to / from AUTO). Skipped on the initial mount
  // because the load effect above already populated reviewData. Uses
  // `refreshing` (not `loading`) so the dialog body stays rendered —
  // prevents the flash of an empty spinner during company switches.
  useEffect(() => {
    if (!open || !reviewData) return;
    const initialCompanyId =
      (reviewData.current.company as { id?: string } | null)?.id ?? null;
    const targetCompanyId = matchedCompanyId === AUTO || createFromAi ? null : matchedCompanyId;
    if (targetCompanyId === initialCompanyId) return; // already in sync

    let cancelled = false;
    setRefreshing(true);
    const qs = targetCompanyId ? `?company_id=${encodeURIComponent(targetCompanyId)}` : "?company_id=";
    fetch(`/api/ai-file-dump/${fileId}/review${qs}`)
      .then((r) => r.json())
      .then((res) => {
        if (cancelled) return;
        if (!res.success) throw new Error(res.error);
        setReviewData(res.data);
        applyDefaultChecks(res.data);
      })
      .catch((err) => {
        if (!cancelled) {
          toast.error("Failed to refresh comparison");
          console.error(err);
        }
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedCompanyId, createFromAi, fileId]);

  function applyDefaultChecks(data: ReviewData) {
    if (data.ai.suggested_company) {
      const defaults: Record<string, boolean> = {};
      for (const { key } of [...IDENTITY_FIELDS, ...ENRICHABLE_FIELDS]) {
        const proposed = data.ai.suggested_company[key as keyof SuggestedCompany];
        const current = data.current.company
          ? (data.current.company as Record<string, unknown>)[key]
          : null;
        defaults[key] =
          proposed != null &&
          proposed !== "" &&
          (current == null || current === "");
      }
      setCheckedFields(defaults);
    }

    // Pre-check financial years that are NEW (not already in the DB).
    // Existing years stay unchecked so the user must opt-in to overwrite.
    const dbYears = new Set(data.current.financials.map((r) => r.fiscal_year));
    const yearDefaults: Record<number, boolean> = {};
    for (const row of data.ai.financials) {
      yearDefaults[row.fiscal_year] = !dbYears.has(row.fiscal_year);
    }
    setCheckedYears(yearDefaults);
  }

  const isExistingCompany = matchedCompanyId !== AUTO && !createFromAi;

  const handleCompanyChange = (val: string) => {
    setMatchedCompanyId(val);
    setCreateFromAi(false);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const company_field_updates: Record<string, string | null> = {};
      if (isExistingCompany && reviewData?.ai.suggested_company) {
        for (const { key } of [...IDENTITY_FIELDS, ...ENRICHABLE_FIELDS]) {
          if (checkedFields[key]) {
            company_field_updates[key] =
              reviewData.ai.suggested_company[key as keyof SuggestedCompany] ?? null;
          }
        }
      }

      const financial_years_to_apply = Object.entries(checkedYears)
        .filter(([, checked]) => checked)
        .map(([year]) => Number(year));

      const body: ApproveFileInput = {
        file_type: fileType as ApproveFileInput["file_type"],
        matched_company_id: isExistingCompany ? matchedCompanyId : null,
        create_company_from_ai: createFromAi,
        company_field_updates: Object.keys(company_field_updates).length > 0
          ? (company_field_updates as ApproveFileInput["company_field_updates"])
          : undefined,
        financial_years_to_apply: financial_years_to_apply.length > 0 ? financial_years_to_apply : undefined,
        ...(createFromAi && {
          entered_by: l0EnteredBy.trim() || null,
          deal_type: (l0DealType || null) as ApproveFileInput["deal_type"],
          banker: l0Banker.trim() || null,
          source: l0Source,
          geography: l0Geography.trim() || null,
          segment: l0Segment.trim() || null,
        }),
      };

      const res = await fetch(`/api/ai-file-dump/${fileId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json();

      if (res.status === 422 && result.missingFields) {
        setMissingFields(result.missingFields);
        return;
      }
      if (!result.success) throw new Error(result.error);

      toast.success("File approved successfully");
      onApproved();
      onClose();
    } catch (err) {
      toast.error("Failed to approve file");
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>Review & Approve: {reviewData?.file.file_name}</DialogTitle>
            {refreshing && (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Updating diff...
              </span>
            )}
          </div>
        </DialogHeader>

        {loading && !reviewData ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : reviewData ? (
          <div
            className="flex-1 min-h-0 overflow-y-auto pr-2 transition-opacity duration-200"
            style={{ opacity: refreshing ? 0.55 : 1 }}
            aria-busy={refreshing}
          >
            <div className="space-y-6 py-2">
              {/* Conflict warning */}
              {reviewData.conflicts.length > 0 && (
                <div className="flex items-center gap-2 rounded-md border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-700">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {reviewData.conflicts.length} other file{reviewData.conflicts.length > 1 ? "s are" : " is"} pending review for the same company.
                </div>
              )}

              {/* Classification */}
              <div className="space-y-1.5">
                <p className="text-sm font-medium">File type</p>
                <Select value={fileType} onValueChange={setFileType}>
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="prospectus">Prospectus</SelectItem>
                    <SelectItem value="mom">MoM</SelectItem>
                    <SelectItem value="banker_communications">Banker Comms</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
                {reviewData.ai.file_type && reviewData.ai.file_type !== fileType && (
                  <p className="text-xs text-muted-foreground">AI suggested: {reviewData.ai.file_type}</p>
                )}
              </div>

              {/* Company picker */}
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Matched company</p>
                <MatchedCompanyCombobox
                  value={matchedCompanyId}
                  onChange={handleCompanyChange}
                  fallbackOptions={
                    reviewData.current.company
                      ? ([
                          {
                            id: reviewData.current.company.id as string,
                            name: (reviewData.current.company.target as string | null) ?? "",
                            projectName: (reviewData.current.company.project_name as string | null) ?? null,
                          },
                        ] satisfies CompanyOption[])
                      : []
                  }
                  placeholder="Select existing company..."
                />
                <div className="flex items-center gap-2 mt-1">
                  <Checkbox
                    id="create-from-ai"
                    checked={createFromAi}
                    onCheckedChange={(checked) => {
                      setCreateFromAi(!!checked);
                      setMissingFields([]);
                      if (checked) {
                        setMatchedCompanyId(AUTO);
                        if (reviewData?.ai.suggested_banker && !l0Banker) {
                          setL0Banker(reviewData.ai.suggested_banker);
                        }
                        if (reviewData?.ai.suggested_company?.geography && !l0Geography) {
                          setL0Geography(reviewData.ai.suggested_company.geography);
                        }
                        if (reviewData?.ai.suggested_company?.segment && !l0Segment) {
                          setL0Segment(reviewData.ai.suggested_company.segment);
                        }
                      }
                    }}
                  />
                  <label htmlFor="create-from-ai" className="text-xs text-muted-foreground cursor-pointer">
                    Create new company from AI data
                  </label>
                </div>

                {createFromAi && (
                  <div className="mt-3 rounded-md border border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-900/10 p-3 space-y-3">
                    <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                      Required to add to L0
                    </p>
                    {missingFields.length > 0 && (
                      <div className="flex items-start gap-1.5 text-xs text-red-600">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        <span>Missing: {missingFields.join(" · ")}</span>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs">Entered By</Label>
                          {user && l0EnteredBy === user.id && (
                            <span className="text-[10px] text-muted-foreground">· auto-filled</span>
                          )}
                        </div>
                        <UserSelectCombobox
                          value={l0EnteredBy || null}
                          onChange={(v) => { setL0EnteredBy(v); setMissingFields([]); }}
                          users={users}
                          className="h-7 text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Inbound / Outbound</Label>
                        <Select
                          value={l0Source}
                          onValueChange={(v) => { setL0Source(v as "inbound" | "outbound"); setMissingFields([]); }}
                        >
                          <SelectTrigger className="h-7 text-xs">
                            <SelectValue placeholder="Select…" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="inbound">Inbound</SelectItem>
                            <SelectItem value="outbound">Outbound</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Deal Type</Label>
                        <Select
                          value={l0DealType || "__none__"}
                          onValueChange={(v) => { setL0DealType(v === "__none__" ? "" : v as "majority" | "minority"); setMissingFields([]); }}
                        >
                          <SelectTrigger className="h-7 text-xs">
                            <SelectValue placeholder="Select…" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">—</SelectItem>
                            <SelectItem value="majority">Majority</SelectItem>
                            <SelectItem value="minority">Minority</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs">Sector</Label>
                          {l0Segment && reviewData?.ai.suggested_company?.segment && l0Segment === reviewData.ai.suggested_company.segment && (
                            <span className="text-[10px] text-muted-foreground">· AI suggested</span>
                          )}
                        </div>
                        <Input
                          className="h-7 text-xs"
                          placeholder="e.g. Technology"
                          value={l0Segment}
                          onChange={(e) => { setL0Segment(e.target.value); setMissingFields([]); }}
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs">Geo</Label>
                          {l0Geography && reviewData?.ai.suggested_company?.geography && l0Geography === reviewData.ai.suggested_company.geography && (
                            <span className="text-[10px] text-muted-foreground">· AI suggested</span>
                          )}
                        </div>
                        <Input
                          className="h-7 text-xs"
                          placeholder="e.g. Indonesia"
                          value={l0Geography}
                          onChange={(e) => { setL0Geography(e.target.value); setMissingFields([]); }}
                        />
                      </div>
                      {l0Source !== "outbound" && (
                        <div className="space-y-1">
                          <div className="flex items-center gap-1.5">
                            <Label className="text-xs">Banker / Source</Label>
                            {l0Banker && reviewData?.ai.suggested_banker && l0Banker === reviewData.ai.suggested_banker && (
                              <span className="text-[10px] text-muted-foreground">· AI suggested</span>
                            )}
                          </div>
                          <Input
                            className="h-7 text-xs"
                            placeholder="e.g. Goldman Sachs"
                            value={l0Banker}
                            onChange={(e) => { setL0Banker(e.target.value); setMissingFields([]); }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Identity fields — company name + project name. Surfaced
                    here (not in the metadata table) because they together
                    identify the company. Only shown when the user picked an
                    existing company AND the AI extracted at least one. */}
                {isExistingCompany && reviewData.ai.suggested_company && (() => {
                  const visibleRows = IDENTITY_FIELDS.filter(({ key }) => {
                    const v = reviewData.ai.suggested_company![key as keyof SuggestedCompany];
                    return v != null && v !== "";
                  });
                  if (visibleRows.length === 0) return null;
                  return (
                    <div className="rounded-md border bg-muted/30 px-3 py-2 mt-2 space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground">
                        AI extracted from this document
                      </p>
                      {visibleRows.map(({ key, label }) => {
                        const proposed = reviewData.ai.suggested_company![key as keyof SuggestedCompany];
                        const current = reviewData.current.company
                          ? (reviewData.current.company as Record<string, unknown>)[key]
                          : null;
                        const same = current === proposed;
                        const currentDisplay =
                          current != null && current !== "" ? String(current) : null;
                        return (
                          <div key={key} className="flex items-start gap-2 text-xs">
                            <span className="w-28 shrink-0 text-muted-foreground">{label}:</span>
                            <div className="flex-1 min-w-0">
                              <span className="font-medium">{String(proposed)}</span>
                              {currentDisplay && !same && (
                                <span className="ml-2 text-muted-foreground">
                                  (current: <span className="line-through">{currentDisplay}</span>)
                                </span>
                              )}
                              {!currentDisplay && (
                                <span className="ml-2 text-muted-foreground italic">
                                  (current: empty)
                                </span>
                              )}
                            </div>
                            {!same && (
                              <label className="flex items-center gap-1 cursor-pointer shrink-0">
                                <Checkbox
                                  checked={!!checkedFields[key]}
                                  onCheckedChange={(checked) =>
                                    setCheckedFields((prev) => ({ ...prev, [key]: !!checked }))
                                  }
                                />
                                <span className="text-muted-foreground">
                                  {currentDisplay ? "overwrite" : "apply"}
                                </span>
                              </label>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

              {/* Preview — when "Create new from AI" is checked, show what
                  the new company row will contain. Pure read-only summary. */}
              {createFromAi && reviewData.ai.suggested_company && (() => {
                // Segment + geography are captured (and editable) in the
                // "Required to add to L0" box above, so leave them out here to
                // avoid showing a stale AI value the user may have just changed.
                const allFields = [
                  ...IDENTITY_FIELDS,
                  ...ENRICHABLE_FIELDS.filter(
                    ({ key }) => key !== "segment" && key !== "geography",
                  ),
                ];
                const filledFields = allFields.filter(({ key }) => {
                  const v = reviewData.ai.suggested_company![key as keyof SuggestedCompany];
                  return v != null && v !== "";
                });
                if (filledFields.length === 0) return null;
                return (
                  <div className="rounded-md border border-emerald-200 bg-emerald-50/40 dark:border-emerald-900/50 dark:bg-emerald-900/10 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      <p className="text-sm font-medium">New company preview</p>
                      <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300">
                        will be created
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      A new company row will be inserted with the values below. Pipeline stage starts at <code className="text-[11px] bg-muted px-1 rounded">L0</code>.
                    </p>
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                      {filledFields.map(({ key, label }) => {
                        const value = reviewData.ai.suggested_company![key as keyof SuggestedCompany];
                        return (
                          <div key={key} className="flex flex-col min-w-0">
                            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
                            <dd className="text-sm font-medium break-words">{String(value)}</dd>
                          </div>
                        );
                      })}
                    </dl>
                  </div>
                );
              })()}

              {/* Company metadata diff — only for existing company match */}
              {isExistingCompany && reviewData.ai.suggested_company && (() => {
                const visibleKeys = ENRICHABLE_FIELDS
                  .filter(({ key }) => {
                    const v = reviewData.ai.suggested_company![key];
                    return v != null && v !== "";
                  })
                  .map(({ key }) => key);
                const checkedCount = visibleKeys.filter((k) => checkedFields[k]).length;
                const metaAll =
                  visibleKeys.length === 0 ? false :
                  checkedCount === visibleKeys.length ? true :
                  checkedCount === 0 ? false : "indeterminate";
                const toggleAllMeta = () => {
                  const next = checkedCount < visibleKeys.length;
                  setCheckedFields((prev) => {
                    const updated = { ...prev };
                    for (const k of visibleKeys) updated[k] = next;
                    return updated;
                  });
                };
                return (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Company metadata</p>
                  <p className="text-xs text-muted-foreground">
                    Pre-checked fields are empty in the database and have a proposed value. Tick a row manually to overwrite an existing value.
                  </p>
                  <div className="rounded-md border overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[150px]">Field</TableHead>
                          <TableHead>Current</TableHead>
                          <TableHead>AI proposed</TableHead>
                          <TableHead className="w-[60px] text-center align-middle">
                            <Checkbox
                              checked={metaAll}
                              onCheckedChange={toggleAllMeta}
                              aria-label="Select all metadata fields"
                              title={
                                metaAll === true
                                  ? "Deselect all"
                                  : "Select all"
                              }
                            />
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {ENRICHABLE_FIELDS.map(({ key, label }) => {
                          const proposed = reviewData.ai.suggested_company![key];
                          if (proposed == null || proposed === "") return null;
                          const current = reviewData.current.company
                            ? (reviewData.current.company as Record<string, unknown>)[key]
                            : null;
                          return (
                            <TableRow key={key}>
                              <TableCell className="text-xs font-medium">{label}</TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {current != null && current !== "" ? String(current) : <span className="italic">—</span>}
                              </TableCell>
                              <TableCell className="text-xs">{String(proposed)}</TableCell>
                              <TableCell className="text-center">
                                <Checkbox
                                  checked={!!checkedFields[key]}
                                  onCheckedChange={(checked) =>
                                    setCheckedFields((prev) => ({ ...prev, [key]: !!checked }))
                                  }
                                />
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </div>
                );
              })()}

              {/* Financials per-year diff */}
              {reviewData.ai.financials.length > 0 && (() => {
                const allYears = reviewData.ai.financials.map((r) => r.fiscal_year);
                const checkedCount = allYears.filter((y) => checkedYears[y]).length;
                const finAll =
                  allYears.length === 0 ? false :
                  checkedCount === allYears.length ? true :
                  checkedCount === 0 ? false : "indeterminate";
                const toggleAllYears = () => {
                  const next = checkedCount < allYears.length;
                  setCheckedYears((prev) => {
                    const updated = { ...prev };
                    for (const y of allYears) updated[y] = next;
                    return updated;
                  });
                };
                return (
                <div className="space-y-1.5">
                  <span className="text-sm font-medium">Financials</span>
                  <p className="text-xs text-muted-foreground">
                    New years are pre-checked. Years already in the database are unchecked — tick to overwrite. Each cell shows current → proposed when both differ.
                  </p>
                  <div className="rounded-md border overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[60px] text-center align-middle">
                            <Checkbox
                              checked={finAll}
                              onCheckedChange={toggleAllYears}
                              aria-label="Select all financial years"
                              title={
                                finAll === true ? "Deselect all" : "Select all"
                              }
                            />
                          </TableHead>
                          <TableHead className="w-[70px]">Year</TableHead>
                          {FINANCIAL_COLUMNS.map(({ key, label }) => (
                            <TableHead key={key} className="text-xs whitespace-nowrap">{label}</TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {reviewData.ai.financials
                          .slice()
                          .sort((a, b) => a.fiscal_year - b.fiscal_year)
                          .map((row) => {
                            const dbRow = reviewData.current.financials.find(
                              (r) => r.fiscal_year === row.fiscal_year,
                            );
                            const isExisting = !!dbRow;
                            return (
                              <TableRow key={row.fiscal_year}>
                                <TableCell className="text-center">
                                  <Checkbox
                                    checked={!!checkedYears[row.fiscal_year]}
                                    onCheckedChange={(checked) =>
                                      setCheckedYears((prev) => ({
                                        ...prev,
                                        [row.fiscal_year]: !!checked,
                                      }))
                                    }
                                  />
                                </TableCell>
                                <TableCell className="text-xs font-medium">
                                  {row.fiscal_year}
                                  {isExisting && (
                                    <Badge variant="outline" className="ml-1 text-[10px] py-0 px-1">existing</Badge>
                                  )}
                                </TableCell>
                                {FINANCIAL_COLUMNS.map(({ key, format }) => {
                                  const proposed = row[key];
                                  const current = dbRow ? dbRow[key] : null;
                                  const same = current === proposed;
                                  return (
                                    <TableCell key={key} className="text-xs whitespace-nowrap">
                                      {!isExisting || same ? (
                                        <span>{format(proposed)}</span>
                                      ) : (
                                        <span>
                                          <span className="text-muted-foreground line-through">{format(current)}</span>
                                          {" → "}
                                          <span className="font-medium">{format(proposed)}</span>
                                        </span>
                                      )}
                                    </TableCell>
                                  );
                                })}
                              </TableRow>
                            );
                          })}
                      </TableBody>
                    </Table>
                  </div>
                </div>
                );
              })()}
            </div>
          </div>
        ) : null}

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || loading}>
            {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Approving...</> : "Approve & Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
