"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, Check, AlertCircle, Plus, Trash2 } from "lucide-react";
import {
  updateCompany,
  updateCompanyFinancials,
  getBankerNames,
  getUsers,
  promoteCompany,
  type FinancialEditRow,
  type UserSummary,
} from "@/lib/api/pipeline";
import UserSelectCombobox from "@/components/pipeline/UserSelectCombobox";
import StatusCombobox, {
  DEFAULT_INBOUND_STATUS_OPTIONS,
  DEFAULT_OUTBOUND_STATUS_OPTIONS,
} from "@/components/pipeline/StatusCombobox";
import type { Tables } from "@/lib/repositories";
import { normalizeStake } from "@/lib/stake";
import TrackMultiSelect from "@/components/pipeline/TrackMultiSelect";
import type { TrackLike } from "@/lib/tracks/matchTracks";

/** Fields the dialog reads from a pipeline company. PipelineCompany is assignable. */
export interface UpdateCompanyData {
  id: string;
  target: string | null;
  project_name: string | null;
  segment: string | null;
  geography: string | null;
  source: string | null;
  remarks: string | null;
  deal_type: string | null;
  entered_by: string | null;
  last_activity_at: string | null;
  banker: string | null;
  advisor: string | null;
  doc_type: string | null;
  stake: string | null;
  deal_size: string | null;
  workflow_status: string | null;
  key_rationale: string | null;
  matched_track_ids?: string[] | null;
  financials_raw?: Tables<"company_financials">[];
}

interface UpdateCompanyDialogProps {
  company: UpdateCompanyData;
  /** Available tracks (investment theses) for the Matched Tracks selector. */
  tracks: TrackLike[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save so the parent can refetch. */
  onUpdate: () => void | Promise<void>;
  /** Suggested values for the free-text Status field. */
  statusOptions?: string[];
  /** When true, promotes the company from 'unreviewed' → 'L0' after saving. */
  promoteOnSave?: boolean;
}

type FinRow = {
  fiscal_year: number;
  revenue: string;
  ebitda: string;
};

type Form = {
  target: string;
  project_name: string;
  segment: string;
  geography: string;
  deal_type: string;
  entered_by: string;
  last_activity_at: string; // YYYY-MM-DD for the date input
  workflow_status: string;
  remarks: string;
  banker: string;
  advisor: string;
  doc_type: string;
  stake: string;
  deal_size: string;
  key_rationale: string;
  matched_track_ids: string[];
  finRows: FinRow[];
};

/** timestamptz ISO string -> YYYY-MM-DD for <input type="date">. */
const isoToDateInput = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0];
};

const defaultNewYear = (rows: Tables<"company_financials">[] | undefined): string => {
  const maxYear = rows?.reduce((max, r) => Math.max(max, r.fiscal_year), new Date().getFullYear() - 1) ?? new Date().getFullYear() - 1;
  return String(Math.min(maxYear + 1, 2100));
};

const buildForm = (c: UpdateCompanyData): Form => {
  const sorted = [...(c.financials_raw ?? [])].sort((a, b) => a.fiscal_year - b.fiscal_year);
  return {
    target: c.target ?? "",
    project_name: c.project_name ?? "",
    segment: c.segment ?? "",
    geography: c.geography ?? "",
    deal_type: c.deal_type ?? "",
    entered_by: c.entered_by ?? "",
    last_activity_at: isoToDateInput(c.last_activity_at),
    workflow_status: c.workflow_status ?? "",
    remarks: c.remarks ?? "",
    banker: c.banker ?? "",
    advisor: c.advisor ?? "",
    doc_type: c.doc_type ?? "",
    stake: c.stake ?? "",
    deal_size: c.deal_size ?? "",
    key_rationale: c.key_rationale ?? "",
    matched_track_ids: c.matched_track_ids ?? [],
    finRows: sorted.map((r) => ({
      fiscal_year: r.fiscal_year,
      revenue: r.revenue_usd_mn != null ? String(r.revenue_usd_mn) : "",
      ebitda: r.ebitda_usd_mn != null ? String(r.ebitda_usd_mn) : "",
    })),
  };
};

export default function UpdateCompanyDialog({
  company,
  tracks,
  open,
  onOpenChange,
  onUpdate,
  statusOptions,
  promoteOnSave,
}: UpdateCompanyDialogProps) {
  const [form, setForm] = useState<Form>(() => buildForm(company));
  const [isSaving, setIsSaving] = useState(false);
  const [missingFields, setMissingFields] = useState<string[]>([]);
  const [bankerOptions, setBankerOptions] = useState<string[]>([]);
  const [userOptions, setUserOptions] = useState<UserSummary[]>([]);
  const [deletedYears, setDeletedYears] = useState<number[]>([]);
  const [newFinYear, setNewFinYear] = useState<string>(() => defaultNewYear(company.financials_raw));
  const isOutbound = company.source === "outbound";

  useEffect(() => {
    if (open) {
      setForm(buildForm(company));
      setMissingFields([]);
      setDeletedYears([]);
      setNewFinYear(defaultNewYear(company.financials_raw));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, company.id]);

  // Load existing banker names once, to suggest Banker / Source values.
  useEffect(() => {
    if (!open || bankerOptions.length > 0) return;
    getBankerNames()
      .then(setBankerOptions)
      .catch((err) => console.error("Failed to load bankers:", err));
  }, [open, bankerOptions.length]);

  // Load users once for the Entered By picker.
  useEffect(() => {
    if (!open || userOptions.length > 0) return;
    getUsers()
      .then(setUserOptions)
      .catch((err) => console.error("Failed to load users:", err));
  }, [open, userOptions.length]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const updateFinRow = (year: number, field: "revenue" | "ebitda", value: string) =>
    setForm((prev) => ({
      ...prev,
      finRows: prev.finRows.map((r) =>
        r.fiscal_year === year ? { ...r, [field]: value } : r,
      ),
    }));

  const removeFinRow = (year: number) => {
    const originalYears = new Set(company.financials_raw?.map((r) => r.fiscal_year) ?? []);
    if (originalYears.has(year)) setDeletedYears((prev) => [...prev, year]);
    setForm((prev) => ({ ...prev, finRows: prev.finRows.filter((r) => r.fiscal_year !== year) }));
  };

  const addFinRow = () => {
    const yr = parseInt(newFinYear);
    if (!Number.isInteger(yr) || yr < 1990 || yr > 2100) {
      toast.error("Enter a valid year (1990–2100)");
      return;
    }
    if (form.finRows.some((r) => r.fiscal_year === yr)) {
      toast.error(`Year ${yr} already exists`);
      return;
    }
    setForm((prev) => ({
      ...prev,
      finRows: [...prev.finRows, { fiscal_year: yr, revenue: "", ebitda: "" }].sort(
        (a, b) => a.fiscal_year - b.fiscal_year,
      ),
    }));
    setNewFinYear(String(Math.min(yr + 1, 2100)));
  };

  const handleSave = async () => {
    // Build financial rows from the multi-year editor.
    const financialRows: FinancialEditRow[] = [];
    for (const row of form.finRows) {
      const revTrimmed = row.revenue.trim();
      const ebitdaTrimmed = row.ebitda.trim();
      if (revTrimmed === "" && ebitdaTrimmed === "") continue;
      const entry: FinancialEditRow = { fiscal_year: row.fiscal_year };
      if (revTrimmed !== "") {
        const n = Number(revTrimmed);
        if (isNaN(n)) { toast.error(`Invalid revenue for ${row.fiscal_year}`); return; }
        entry.revenue_usd_mn = n;
      }
      if (ebitdaTrimmed !== "") {
        const n = Number(ebitdaTrimmed);
        if (isNaN(n)) { toast.error(`Invalid EBITDA for ${row.fiscal_year}`); return; }
        entry.ebitda_usd_mn = n;
      }
      financialRows.push(entry);
    }

    const stakeResult = normalizeStake(form.stake);
    if ("error" in stakeResult) {
      toast.error(stakeResult.error);
      return;
    }

    setIsSaving(true);
    setMissingFields([]);
    try {
      await updateCompany(company.id, {
        target: form.target.trim() || null,
        project_name: form.project_name.trim() || null,
        segment: form.segment.trim() || null,
        geography: form.geography.trim() || null,
        deal_type: form.deal_type || null,
        entered_by: form.entered_by.trim() || null,
        last_activity_at: form.last_activity_at
          ? new Date(form.last_activity_at).toISOString()
          : null,
        workflow_status: form.workflow_status.trim() || null,
        remarks: form.remarks.trim() || null,
        banker: form.banker.trim() || null,
        advisor: form.advisor.trim() || null,
        doc_type: form.doc_type || null,
        stake: stakeResult.value,
        deal_size: form.deal_size.trim() || null,
        key_rationale: form.key_rationale.trim() || null,
        matched_track_ids: form.matched_track_ids,
      });
      if (financialRows.length > 0 || deletedYears.length > 0) {
        await updateCompanyFinancials(company.id, { rows: financialRows, deletedYears });
      }
      if (promoteOnSave) {
        try {
          await promoteCompany(company.id, { currentStage: "unreviewed", nextStage: "L0" });
        } catch (promoteErr: any) {
          if (Array.isArray(promoteErr?.missingFields)) {
            setMissingFields(promoteErr.missingFields);
            return;
          }
          throw promoteErr;
        }
      }
      toast.success(promoteOnSave ? `Added to L0: ${form.target.trim() || "company"}` : `Updated: ${form.target.trim() || "company"}`);
      await onUpdate();
      onOpenChange(false);
    } catch (err: any) {
      console.error("Failed to update company:", err);
      toast.error(`Failed to save: ${err.message || "Unknown error"}`);
    } finally {
      setIsSaving(false);
    }
  };

  const resolvedStatusOptions =
    statusOptions ??
    (isOutbound
      ? DEFAULT_OUTBOUND_STATUS_OPTIONS
      : DEFAULT_INBOUND_STATUS_OPTIONS);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{promoteOnSave ? "Edit & Add to L0" : "Update Company"}</DialogTitle>
          <DialogDescription>
            {promoteOnSave
              ? "Fill in all required fields, then save to add this company to the L0 pipeline."
              : "Edit information for this entry"}
          </DialogDescription>
        </DialogHeader>

        {missingFields.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <span className="font-medium">Missing required fields: </span>
              {missingFields.join(", ")}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="u_target">Company</Label>
            <Input
              id="u_target"
              value={form.target}
              onChange={(e) => set("target", e.target.value)}
              disabled={isSaving}
            />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="u_project">Project</Label>
            <Input
              id="u_project"
              value={form.project_name}
              onChange={(e) => set("project_name", e.target.value)}
              placeholder="e.g. Project Phoenix"
              disabled={isSaving}
            />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="u_segment">{isOutbound ? "Segment" : "Sector"}</Label>
            <Input
              id="u_segment"
              value={form.segment}
              onChange={(e) => set("segment", e.target.value)}
              disabled={isSaving}
            />
          </div>
          {!isOutbound && (
            <div className="space-y-1.5">
              <Label htmlFor="u_geography">Geo</Label>
              <Input
                id="u_geography"
                value={form.geography}
                onChange={(e) => set("geography", e.target.value)}
                disabled={isSaving}
              />
            </div>
          )}
          <div className={`space-y-1.5 ${isOutbound ? "col-span-2" : ""}`}>
            <Label>Deal Type</Label>
            <Select
              value={form.deal_type || "__none__"}
              onValueChange={(v) => set("deal_type", v === "__none__" ? "" : v)}
              disabled={isSaving}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">-</SelectItem>
                <SelectItem value="majority">Majority</SelectItem>
                <SelectItem value="minority">Minority</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Financials — multi-year editor */}
          <div className="col-span-2 space-y-2">
            <Label>Financials (USD mn)</Label>
            {form.finRows.length > 0 && (
              <div className="rounded-md border text-sm overflow-hidden">
                <div className="grid grid-cols-[72px_1fr_1fr_32px] gap-x-2 px-3 py-1.5 text-xs font-medium text-muted-foreground bg-muted/40 border-b">
                  <span>Year</span>
                  <span>Revenue</span>
                  <span>EBITDA</span>
                  <span />
                </div>
                {form.finRows.map((row) => (
                  <div
                    key={row.fiscal_year}
                    className="grid grid-cols-[72px_1fr_1fr_32px] gap-x-2 items-center px-3 py-1.5 border-b last:border-b-0"
                  >
                    <span className="font-medium text-sm tabular-nums">{row.fiscal_year}</span>
                    <Input
                      type="number"
                      step="0.01"
                      value={row.revenue}
                      onChange={(e) => updateFinRow(row.fiscal_year, "revenue", e.target.value)}
                      placeholder="—"
                      className="h-7 text-xs"
                      disabled={isSaving}
                    />
                    <Input
                      type="number"
                      step="0.01"
                      value={row.ebitda}
                      onChange={(e) => updateFinRow(row.fiscal_year, "ebitda", e.target.value)}
                      placeholder="—"
                      className="h-7 text-xs"
                      disabled={isSaving}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      type="button"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => removeFinRow(row.fiscal_year)}
                      disabled={isSaving}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {form.finRows.length === 0 && (
              <p className="text-xs text-muted-foreground py-0.5">No financial data yet.</p>
            )}
            <div className="flex items-center gap-2">
              <Input
                type="number"
                placeholder="Year (e.g. 2024)"
                value={newFinYear}
                onChange={(e) => setNewFinYear(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addFinRow()}
                className="h-7 text-xs w-36"
                disabled={isSaving}
              />
              <Button
                variant="outline"
                size="sm"
                type="button"
                className="h-7 text-xs gap-1"
                onClick={addFinRow}
                disabled={isSaving}
              >
                <Plus className="h-3.5 w-3.5" />
                Add Year
              </Button>
            </div>
          </div>

          {/* % Stake — target ownership being pursued (both sources) */}
          <div className="space-y-1.5">
            <Label htmlFor="u_stake">% Stake</Label>
            <Input
              id="u_stake"
              value={form.stake}
              onChange={(e) => set("stake", e.target.value)}
              placeholder="e.g. 51%"
              title="Target ownership percentage being pursued"
              disabled={isSaving}
            />
          </div>

          {/* Inbound-only deal-sourcing fields */}
          {!isOutbound && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="u_deal_size">Deal Size</Label>
                <Input
                  id="u_deal_size"
                  value={form.deal_size}
                  onChange={(e) => set("deal_size", e.target.value)}
                  disabled={isSaving}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Banker / Source</Label>
                <StatusCombobox
                  value={form.banker || null}
                  options={bankerOptions}
                  placeholder="Set banker…"
                  searchPlaceholder="Search or add a banker…"
                  emptyText="No bankers yet."
                  onChange={(v) => set("banker", v)}
                  disabled={isSaving}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Advisor</Label>
                <StatusCombobox
                  value={form.advisor || null}
                  options={bankerOptions}
                  placeholder="Set advisor…"
                  searchPlaceholder="Search or add a banker…"
                  emptyText="No bankers yet."
                  onChange={(v) => set("advisor", v)}
                  disabled={isSaving}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Doc Type</Label>
                <Select
                  value={form.doc_type || "__none__"}
                  onValueChange={(v) =>
                    set("doc_type", v === "__none__" ? "" : v)
                  }
                  disabled={isSaving}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">-</SelectItem>
                    <SelectItem value="teaser">Teaser</SelectItem>
                    <SelectItem value="shopping_list">Shopping List</SelectItem>
                    <SelectItem value="market_study">Market Study</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {/* Outbound-only */}
          {isOutbound && (
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="u_key_rationale">Key Rationale</Label>
              <Textarea
                id="u_key_rationale"
                value={form.key_rationale}
                onChange={(e) => set("key_rationale", e.target.value)}
                rows={3}
                className="resize-y"
                disabled={isSaving}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Entered By</Label>
            <UserSelectCombobox
              value={form.entered_by || null}
              onChange={(v) => set("entered_by", v)}
              users={userOptions}
              disabled={isSaving}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="u_last_activity">Last Activity</Label>
            <Input
              id="u_last_activity"
              type="date"
              value={form.last_activity_at}
              onChange={(e) => set("last_activity_at", e.target.value)}
              disabled={isSaving}
            />
          </div>
          {tracks.length > 0 && (
            <div className="col-span-2 space-y-1.5">
              <Label>Matched Tracks</Label>
              <TrackMultiSelect
                tracks={tracks}
                value={form.matched_track_ids}
                onChange={(next) => set("matched_track_ids", next)}
                placeholder="Auto-matched — select to override…"
                disabled={isSaving}
              />
            </div>
          )}

          <div className="col-span-2 space-y-1.5">
            <Label>Status</Label>
            <StatusCombobox
              value={form.workflow_status || null}
              options={resolvedStatusOptions}
              placeholder={isOutbound ? "Set status…" : "Unreviewed"}
              onChange={(v) => set("workflow_status", v)}
              disabled={isSaving}
            />
          </div>

          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="u_remarks">Additional Remarks</Label>
            <Textarea
              id="u_remarks"
              value={form.remarks}
              onChange={(e) => set("remarks", e.target.value)}
              rows={3}
              className="resize-y"
              disabled={isSaving}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving} className="gap-1">
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
