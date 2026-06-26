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
import { Loader2, Check } from "lucide-react";
import {
  updateCompany,
  updateCompanyFinancials,
  getBankerNames,
  getUsers,
  type FinancialEditRow,
  type UserSummary,
} from "@/lib/api/pipeline";
import StatusCombobox, {
  DEFAULT_INBOUND_STATUS_OPTIONS,
  DEFAULT_OUTBOUND_STATUS_OPTIONS,
} from "@/components/pipeline/StatusCombobox";
import type { Tables } from "@/lib/repositories";
import { normalizeStake } from "@/lib/stake";
import TrackMultiSelect from "@/components/pipeline/TrackMultiSelect";
import {
  matchedTrackPics,
  dealLeadField,
  dealLeadLabel,
  type TrackLike,
} from "@/lib/tracks/matchTracks";

/** Fields the dialog reads from a pipeline company. PipelineCompany is assignable. */
export interface UpdateCompanyData {
  id: string;
  target: string | null;
  project_name: string | null;
  segment: string | null;
  geography: string | null;
  source: string | null;
  pipeline_stage?: string | null;
  remarks: string | null;
  deal_type: string | null;
  last_activity_at: string | null;
  banker: string | null;
  doc_type: string | null;
  stake: string | null;
  deal_size: string | null;
  workflow_status: string | null;
  key_rationale: string | null;
  matched_track_ids?: string[] | null;
  deal_sponsor?: string | null;
  deal_captain?: string | null;
  financials_raw?: Tables<"company_financials">[];
}

interface UpdateCompanyDialogProps {
  company: UpdateCompanyData;
  /** Available tracks (investment theses) for the Matched Tracks selector. */
  tracks: TrackLike[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save so the parent can refetch. */
  onUpdate: () => void;
  /** Suggested values for the free-text Status field. */
  statusOptions?: string[];
}

type Form = {
  target: string;
  project_name: string;
  segment: string;
  geography: string;
  deal_type: string;
  last_activity_at: string; // YYYY-MM-DD for the date input
  workflow_status: string;
  remarks: string;
  banker: string;
  doc_type: string;
  stake: string;
  deal_size: string;
  revenue: string;
  revenue_year: string;
  ebitda: string;
  ebitda_year: string;
  key_rationale: string;
  matched_track_ids: string[];
  deal_sponsor: string;
  deal_captain: string;
};

/** timestamptz ISO string -> YYYY-MM-DD for <input type="date">. */
const isoToDateInput = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0];
};

/** Most recent fiscal year that has a non-null value for `key`. */
const latestFin = (
  rows: Tables<"company_financials">[] | undefined,
  key: "revenue_usd_mn" | "ebitda_usd_mn",
): { value: number | null; year: number | null } => {
  if (!rows?.length) return { value: null, year: null };
  let best: { value: number; year: number } | null = null;
  for (const r of rows) {
    const v = r[key] as number | null;
    if (v == null) continue;
    if (!best || r.fiscal_year > best.year)
      best = { value: v, year: r.fiscal_year };
  }
  return best ?? { value: null, year: null };
};

const buildForm = (c: UpdateCompanyData): Form => {
  const rev = latestFin(c.financials_raw, "revenue_usd_mn");
  const ebitda = latestFin(c.financials_raw, "ebitda_usd_mn");
  return {
    target: c.target ?? "",
    project_name: c.project_name ?? "",
    segment: c.segment ?? "",
    geography: c.geography ?? "",
    deal_type: c.deal_type ?? "",
    last_activity_at: isoToDateInput(c.last_activity_at),
    workflow_status: c.workflow_status ?? "",
    remarks: c.remarks ?? "",
    banker: c.banker ?? "",
    doc_type: c.doc_type ?? "",
    stake: c.stake ?? "",
    deal_size: c.deal_size ?? "",
    revenue: rev.value != null ? String(rev.value) : "",
    revenue_year: rev.year != null ? String(rev.year) : "",
    ebitda: ebitda.value != null ? String(ebitda.value) : "",
    ebitda_year: ebitda.year != null ? String(ebitda.year) : "",
    key_rationale: c.key_rationale ?? "",
    matched_track_ids: c.matched_track_ids ?? [],
    deal_sponsor: c.deal_sponsor ?? "",
    deal_captain: c.deal_captain ?? "",
  };
};

export default function UpdateCompanyDialog({
  company,
  tracks,
  open,
  onOpenChange,
  onUpdate,
  statusOptions,
}: UpdateCompanyDialogProps) {
  const [form, setForm] = useState<Form>(() => buildForm(company));
  const [isSaving, setIsSaving] = useState(false);
  const [bankerOptions, setBankerOptions] = useState<string[]>([]);
  const [userOptions, setUserOptions] = useState<string[]>([]);
  const isOutbound = company.source === "outbound";

  useEffect(() => {
    if (open) setForm(buildForm(company));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, company.id]);

  // Load existing banker names once, to suggest Banker / Source values.
  useEffect(() => {
    if (!open || bankerOptions.length > 0) return;
    getBankerNames()
      .then(setBankerOptions)
      .catch((err) => console.error("Failed to load bankers:", err));
  }, [open, bankerOptions.length]);

  // Load team-member names once, to suggest Deal Sponsor/Captain values.
  useEffect(() => {
    if (!open || userOptions.length > 0) return;
    getUsers()
      .then((users: UserSummary[]) =>
        setUserOptions(
          users.map((u) => u.name).filter((n): n is string => !!n),
        ),
      )
      .catch((err) => console.error("Failed to load users:", err));
  }, [open, userOptions.length]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const parseNum = (s: string): number | null | undefined => {
    const t = s.trim();
    if (t === "") return undefined; // leave untouched
    const n = Number(t);
    return Number.isNaN(n) ? null : n;
  };

  const parseYear = (s: string): number | null => {
    const t = s.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isInteger(n) && n >= 1990 && n <= 2100 ? n : null;
  };

  const handleSave = async () => {
    // Build financial rows, merging same-year revenue + ebitda.
    let financialRows: FinancialEditRow[] = [];
    {
      const revNum = parseNum(form.revenue);
      const ebitdaNum = parseNum(form.ebitda);
      const revYear = parseYear(form.revenue_year);
      const ebitdaYear = parseYear(form.ebitda_year);
      if (form.revenue.trim() !== "" && !revYear) {
        toast.error("Enter a valid Revenue Year (e.g. 2024)");
        return;
      }
      if (form.ebitda.trim() !== "" && !ebitdaYear) {
        toast.error("Enter a valid EBITDA Year (e.g. 2024)");
        return;
      }
      if (revNum === null || ebitdaNum === null) {
        toast.error("Revenue and EBITDA must be numbers");
        return;
      }
      const byYear = new Map<number, FinancialEditRow>();
      const ensure = (y: number) => {
        if (!byYear.has(y)) byYear.set(y, { fiscal_year: y });
        return byYear.get(y)!;
      };
      if (revYear && revNum !== undefined) ensure(revYear).revenue_usd_mn = revNum;
      if (ebitdaYear && ebitdaNum !== undefined)
        ensure(ebitdaYear).ebitda_usd_mn = ebitdaNum;
      financialRows = [...byYear.values()];
    }

    const stakeResult = normalizeStake(form.stake);
    if ("error" in stakeResult) {
      toast.error(stakeResult.error);
      return;
    }

    setIsSaving(true);
    try {
      await updateCompany(company.id, {
        target: form.target.trim() || null,
        project_name: form.project_name.trim() || null,
        segment: form.segment.trim() || null,
        geography: form.geography.trim() || null,
        deal_type: form.deal_type || null,
        last_activity_at: form.last_activity_at
          ? new Date(form.last_activity_at).toISOString()
          : null,
        workflow_status: form.workflow_status.trim() || null,
        remarks: form.remarks.trim() || null,
        banker: form.banker.trim() || null,
        doc_type: form.doc_type || null,
        stake: stakeResult.value,
        deal_size: form.deal_size.trim() || null,
        key_rationale: form.key_rationale.trim() || null,
        matched_track_ids: form.matched_track_ids,
        deal_sponsor: form.deal_sponsor.trim() || null,
        deal_captain: form.deal_captain.trim() || null,
      });
      if (financialRows.length > 0) {
        await updateCompanyFinancials(company.id, { rows: financialRows });
      }
      toast.success(`Updated: ${form.target.trim() || "company"}`);
      onUpdate();
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
          <DialogTitle>Update Company</DialogTitle>
          <DialogDescription>Edit information for this entry</DialogDescription>
        </DialogHeader>

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

          {/* Revenue & EBITDA — feed the Revenue/EBITDA columns (inbound) and
              the computed Financial Info column (outbound). */}
          <div className="space-y-1.5">
            <Label htmlFor="u_revenue">Revenue (USD mn)</Label>
            <Input
              id="u_revenue"
              type="number"
              step="0.01"
              value={form.revenue}
              onChange={(e) => set("revenue", e.target.value)}
              disabled={isSaving}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="u_revenue_year">Revenue Year</Label>
            <Input
              id="u_revenue_year"
              type="number"
              placeholder="e.g. 2024"
              value={form.revenue_year}
              onChange={(e) => set("revenue_year", e.target.value)}
              disabled={isSaving}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="u_ebitda">EBITDA (USD mn)</Label>
            <Input
              id="u_ebitda"
              type="number"
              step="0.01"
              value={form.ebitda}
              onChange={(e) => set("ebitda", e.target.value)}
              disabled={isSaving}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="u_ebitda_year">EBITDA Year</Label>
            <Input
              id="u_ebitda_year"
              type="number"
              placeholder="e.g. 2024"
              value={form.ebitda_year}
              onChange={(e) => set("ebitda_year", e.target.value)}
              disabled={isSaving}
            />
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

          {/* Deal Sponsor (L0–L2) / Deal Captain (L3+) — per-company override
              of the matched Track's PIC; the Track's PIC shows as the default
              placeholder when no override is set. */}
          {(() => {
            const field = dealLeadField(company.pipeline_stage);
            const pics = matchedTrackPics(
              { matched_track_ids: form.matched_track_ids },
              tracks,
            );
            const fallback = pics.length > 0 ? pics.join(", ") : null;
            return (
              <div className="col-span-2 space-y-1.5">
                <Label>{dealLeadLabel(company.pipeline_stage)}</Label>
                <StatusCombobox
                  value={form[field] || null}
                  options={userOptions}
                  placeholder={
                    fallback
                      ? `${fallback} (from track)`
                      : `Set ${dealLeadLabel(company.pipeline_stage)}…`
                  }
                  searchPlaceholder="Search or type a name…"
                  emptyText="No team members found."
                  onChange={(v) => set(field, v)}
                  disabled={isSaving}
                />
              </div>
            );
          })()}

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
