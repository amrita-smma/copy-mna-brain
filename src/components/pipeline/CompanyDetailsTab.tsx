"use client";

import { useState, type ReactNode } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  AlertTriangle,
  Briefcase,
  Building2,
  Check,
  Clock,
  ExternalLink,
  FileText,
  Globe,
  Lightbulb,
  Loader2,
  Pencil,
  Search,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import { useWorkspaceCurrency } from "@/components/layout/WorkspaceCurrencyContext";
import { AICompanyCardLoading } from "@/components/pipeline/AICompanyCardLoading";
import { CompanyAnalysisSection } from "@/components/pipeline/CompanyAnalysisSection";
import { CompanyContactsSection } from "@/components/pipeline/CompanyContactsSection";
import CompanyRelationshipGraph from "@/components/pipeline/CompanyRelationshipGraph";
import { FinancialCharts } from "@/components/pipeline/FinancialCharts";
import StatusCombobox, {
  DEFAULT_INBOUND_STATUS_OPTIONS,
  DEFAULT_OUTBOUND_STATUS_OPTIONS,
} from "@/components/pipeline/StatusCombobox";
import TrackMultiSelect from "@/components/pipeline/TrackMultiSelect";
import TrackVariablesSection from "@/components/pipeline/TrackVariablesSection";
import UserSelectCombobox from "@/components/pipeline/UserSelectCombobox";
import type { CompanyInformationEditor } from "@/components/pipeline/useCompanyInformationEditor";
import { usePipelineRequiredFields } from "@/hooks/usePipelineRequiredFields";
import { usePipelineStages } from "@/hooks/usePipelineStages";
import type { Track } from "@/lib/api/pipeline";
import type { CompanyInfoForm, CompanyInfoSource } from "@/lib/companies/companyInfoForm";
import { DEAL_TYPE_OPTIONS, formatDealType } from "@/lib/companies/dealTypes";
import { companyDisplayName } from "@/lib/companyDisplay";
import { OWNERSHIP_OPTIONS } from "@/lib/constants";
import { formatMoneyMn } from "@/lib/currency";
import { isDealLive } from "@/lib/dealStatus";
import type { TrackSpecificVariables } from "@/lib/db/schema";
import { FIRST_STAGE_KEY, stageSelectOptions } from "@/lib/pipeline/stages";
import type { Tables } from "@/lib/repositories";
import {
  dealLeadField,
  dealLeadLabel,
  effectiveDealLead,
  matchedTrackPics,
  persistedTrackIds,
  trackDisplayName,
} from "@/lib/tracks/matchTracks";

/** The company fields the Details tab reads. Both views' DTOs satisfy it. */
export interface DetailsTabCompany extends CompanyInfoSource {
  id: string;
  target: string | null;
  entered_by_name?: string | null;
  deal_sponsor_name?: string | null;
  deal_captain_name?: string | null;
  status?: string | null;
  dropped_reason?: string | null;
  track_specific_variables?: TrackSpecificVariables | null;
  slide_track_variable_ids?: string[] | null;
  financials_raw?: Tables<"company_financials">[];
}

export interface StageHistoryEntry {
  id: string;
  stage: string;
  entered_at: string;
  exited_at: string | null;
  duration_seconds: number | null;
}

interface AnalysisSourceView {
  type: string;
  url?: string;
  title?: string;
}

/** The AI Company Card fields the Details tab renders. */
export interface DetailsTabAnalysis {
  status: string;
  business_overview: string | null;
  business_model_summary: string | null;
  key_takeaways: string | null;
  investment_highlights: string | null;
  investment_risks: string | null;
  diligence_priorities: string | null;
  sources: AnalysisSourceView[] | null;
  error_message: string | null;
  created_at: string | null;
}

export interface CompanyDetailsTabProps {
  company: DetailsTabCompany;
  tracks: Track[];
  editor: CompanyInformationEditor;
  /** Deal Status (Active / Dropped). Dropping opens the parent's drop dialog. */
  onDealStatusChange: (next: "active" | "dropped") => void;
  dealStatusBusy?: boolean;
  /** Save the outbound deal's AI Market Scanning Remarks (`null` clears them). */
  onSaveRemarks: (remarks: string | null) => Promise<void>;
  onFinancialsUpdate?: () => void;
  onTrackVariablesSaved: (next: TrackSpecificVariables) => void;
  onSlideVariablesSaved: (next: string[]) => void;
  stageHistory: StageHistoryEntry[];
  analysis: DetailsTabAnalysis | null;
  analysisGenerating: boolean;
  analysisCancelling: boolean;
  onCancelAnalysis: () => void;
  onRetryAnalysis: () => void;
  /**
   * False while the host is closed but still mounted (Company Graph keeps a
   * closed dialog mounted), so the contacts card does not keep polling.
   */
  active?: boolean;
}

const websiteHref = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

const formatDuration = (seconds: number | null) => {
  if (seconds === null) return "Ongoing";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h`;
};

/**
 * The Details tab, shared by the full company page (`CompanyDetail.tsx`) and
 * the pipeline dialog (`CompanyDetailDialog.tsx`) so the two cannot drift
 * apart: Market Scanning Remarks (outbound), financials, Company Information,
 * contacts, relationship graph, track variables, stage history and the AI
 * Company Card, in that order.
 */
export default function CompanyDetailsTab({
  company,
  tracks,
  editor,
  onDealStatusChange,
  dealStatusBusy = false,
  onSaveRemarks,
  onFinancialsUpdate,
  onTrackVariablesSaved,
  onSlideVariablesSaved,
  stageHistory,
  analysis,
  analysisGenerating,
  analysisCancelling,
  onCancelAnalysis,
  onRetryAnalysis,
  active = true,
}: CompanyDetailsTabProps) {
  const pipelineStages = usePipelineStages();
  const stageLabel = (stage: string | null | undefined) =>
    pipelineStages.displayLabel(stage || FIRST_STAGE_KEY);
  const name = companyDisplayName(company, "This company");

  return (
    <div className="space-y-4">
      {company.source?.toLowerCase() === "outbound" && (
        <MarketScanningRemarksCard
          remarks={company.remarks ?? null}
          segment={company.segment ?? null}
          onSave={onSaveRemarks}
        />
      )}

      <FinancialCharts
        financials={company.financials_raw ?? []}
        rawFinancials={company.financials_raw ?? []}
        companyId={company.id}
        onUpdate={onFinancialsUpdate}
      />

      <CompanyInformationCard
        company={company}
        tracks={tracks}
        editor={editor}
        stageLabel={stageLabel}
        onDealStatusChange={onDealStatusChange}
        dealStatusBusy={dealStatusBusy}
      />

      {/* Partnership contacts at this company, kept in the CRM and found on
          demand by @crm_contact on the AI Workforce. */}
      {active && <CompanyContactsSection key={company.id} companyId={company.id} companyName={name} />}

      {/* Relationship graph snippet — this company and the companies directly
          connected to it. Filtering lives on the graph page. */}
      <CompanyRelationshipGraph companyId={company.id} companyName={name} />

      <TrackVariablesSection
        companyId={company.id}
        matchedTrackIds={persistedTrackIds(company, tracks)}
        tracks={tracks}
        values={company.track_specific_variables}
        onSaved={onTrackVariablesSaved}
        slideVariableIds={company.slide_track_variable_ids}
        onSlideVariablesSaved={onSlideVariablesSaved}
      />

      <StageHistoryCard stageHistory={stageHistory} stageLabel={stageLabel} />

      <AICompanyCard
        analysis={analysis}
        generating={analysisGenerating}
        cancelling={analysisCancelling}
        onCancel={onCancelAnalysis}
        onRetry={onRetryAnalysis}
      />
    </div>
  );
}

function MarketScanningRemarksCard({
  remarks,
  segment,
  onSave,
}: {
  remarks: string | null;
  segment: string | null;
  onSave: (remarks: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState("");

  const cancel = () => {
    setEditing(false);
    setDraft("");
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft.trim() || null);
      cancel();
    } catch {
      // The parent toasts the failure; keep the editor open on the draft.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="border-blue-200 bg-card dark:border-blue-800/50">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2 text-blue-700 dark:text-blue-400">
            <Sparkles className="h-5 w-5 text-blue-500" />
            AI Market Scanning Remarks
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge
              variant="secondary"
              className="bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-700"
            >
              <Sparkles className="h-3 w-3 mr-1" />
              AI Discovered
            </Badge>
            {!editing && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraft(remarks ?? "");
                  setEditing(true);
                }}
                aria-label="Edit remarks"
                className="h-6 w-6 p-0 text-blue-700 dark:text-blue-300"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
        {segment && <p className="text-sm text-muted-foreground">Matched against: {segment}</p>}
      </CardHeader>
      <CardContent>
        <div className="p-4 rounded-lg border border-blue-200 bg-muted dark:border-blue-800/50">
          <p className="text-sm font-medium text-blue-700 dark:text-blue-300 flex items-center gap-2 mb-2">
            <Sparkles className="h-4 w-4" />
            Why This Company Matches Your Investment Thesis
          </p>
          {editing ? (
            <div className="space-y-3">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={saving}
                rows={6}
                placeholder="Describe how this company aligns with the investment thesis…"
                className="text-sm"
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={cancel} disabled={saving}>
                  Cancel
                </Button>
                <Button size="sm" onClick={save} disabled={saving} className="gap-1">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Save
                </Button>
              </div>
            </div>
          ) : remarks ? (
            <MarkdownRenderer content={remarks} variant="card" />
          ) : (
            <p className="text-sm text-muted-foreground italic">
              No remarks yet. Click the edit icon to add some.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** A labelled field: the read-only value, or its editor while editing. */
function Field({
  label,
  editing,
  editor,
  children,
  className,
}: {
  label: ReactNode;
  editing: boolean;
  editor: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-xs text-muted-foreground">{label}</p>
      {editing ? editor : children}
    </div>
  );
}

const Value = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <p className={`text-sm font-medium break-words ${className}`}>{children}</p>
);

function CompanyInformationCard({
  company,
  tracks,
  editor,
  stageLabel,
  onDealStatusChange,
  dealStatusBusy,
}: {
  company: DetailsTabCompany;
  tracks: Track[];
  editor: CompanyInformationEditor;
  stageLabel: (stage: string | null | undefined) => string;
  onDealStatusChange: (next: "active" | "dropped") => void;
  dealStatusBusy: boolean;
}) {
  const pipelineStages = usePipelineStages();
  const pipelineRequired = usePipelineRequiredFields();
  const currency = useWorkspaceCurrency();
  const { isEditing, isSaving, users, bankerOptions } = editor;
  const form = isEditing ? editor.editForm : null;
  const editing = !!form;
  const set = (patch: Partial<CompanyInfoForm>) => {
    if (form) editor.setEditForm({ ...form, ...patch });
  };
  const inbound = company.source !== "outbound";
  const statusOptions = inbound ? DEFAULT_INBOUND_STATUS_OPTIONS : DEFAULT_OUTBOUND_STATUS_OPTIONS;
  const stage = form ? form.pipeline_stage : company.pipeline_stage;
  const leadField = dealLeadField(stage, pipelineStages.captainKeys);
  const leadLabel = dealLeadLabel(stage, pipelineStages.captainKeys);
  const trackPics = matchedTrackPics(company, tracks);
  const formatDate = (value: string | null | undefined) =>
    value ? format(new Date(value), "MMM d, yyyy") : "—";

  const textInput = (key: keyof CompanyInfoForm, placeholder?: string, type?: string) =>
    form && (
      <Input
        type={type}
        value={form[key] as string}
        onChange={(e) => set({ [key]: e.target.value } as Partial<CompanyInfoForm>)}
        placeholder={placeholder}
        disabled={isSaving}
        className="mt-1 h-7 text-sm"
      />
    );
  const textArea = (key: keyof CompanyInfoForm, placeholder?: string) =>
    form && (
      <Textarea
        value={form[key] as string}
        onChange={(e) => set({ [key]: e.target.value } as Partial<CompanyInfoForm>)}
        rows={3}
        placeholder={placeholder}
        disabled={isSaving}
        className="mt-1 text-sm resize-y"
      />
    );
  const select = (
    key: keyof CompanyInfoForm,
    options: { value: string; label: string }[],
    { allowNone = true }: { allowNone?: boolean } = {},
  ) =>
    form && (
      <Select
        value={(form[key] as string) || "__none__"}
        onValueChange={(v) => set({ [key]: v === "__none__" ? "" : v } as Partial<CompanyInfoForm>)}
        disabled={isSaving}
      >
        <SelectTrigger className="mt-1 h-7 text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allowNone && <SelectItem value="__none__">-</SelectItem>}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  const bankerPicker = (key: "banker" | "advisor", placeholder: string) =>
    form && (
      <StatusCombobox
        value={form[key] || null}
        options={bankerOptions}
        placeholder={placeholder}
        searchPlaceholder="Search or add a banker…"
        emptyText="No bankers yet."
        onChange={(v) => set({ [key]: v } as Partial<CompanyInfoForm>)}
        disabled={isSaving}
        className="mt-1"
      />
    );

  const matchedTracks = persistedTrackIds(company, tracks)
    .map((id) => tracks.find((t) => t.id === id))
    .filter((t): t is Track => !!t);

  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Company Information
        </p>
        {!isEditing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={editor.startEditing}
            aria-label="Edit Company Information"
            className="h-6 w-6 p-0"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="space-y-3">
        {/* Fields the workspace requires before a company can enter the pipeline */}
        <div className="rounded-md border border-amber-400/70 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-950">
          <div className="mb-2 flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
            <p className="text-xs font-medium text-amber-700 dark:text-amber-500">
              Required to enter the pipeline:{" "}
              {pipelineRequired.fields.map((f) => f.label).join(" · ")}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3">
            <Field label="Company Name" editing={editing} editor={textInput("target")}>
              <Value>{company.target || "—"}</Value>
            </Field>
            <Field
              label="Project Name"
              editing={editing}
              editor={textInput("project_name", "e.g. Project Phoenix")}
            >
              <Value>{company.project_name || "—"}</Value>
            </Field>
            <Field
              label="Source"
              editing={editing}
              editor={select("source", [
                { value: "inbound", label: "Inbound" },
                { value: "outbound", label: "Outbound" },
              ])}
            >
              <Value className="capitalize">{company.source || "—"}</Value>
            </Field>
            <Field
              label="Deal Type"
              editing={editing}
              editor={select("deal_type", DEAL_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label })))}
            >
              <Value>{formatDealType(company.deal_type) || "—"}</Value>
            </Field>
            <Field label="Sector" editing={editing} editor={textInput("segment")}>
              <Value>{company.segment || "—"}</Value>
            </Field>
            <Field label="Headquarter" editing={editing} editor={textInput("geography")}>
              <Value>{company.geography || "—"}</Value>
            </Field>
            <Field
              label="Entered by"
              editing={editing}
              editor={
                form && (
                  <div className="mt-1">
                    <UserSelectCombobox
                      value={form.entered_by || null}
                      onChange={(v) => set({ entered_by: v })}
                      users={users}
                      disabled={isSaving}
                    />
                  </div>
                )
              }
            >
              <Value>{company.entered_by_name || "—"}</Value>
            </Field>
            {inbound && (
              <Field
                label="Banker / Source"
                editing={editing}
                editor={bankerPicker("banker", "Set banker…")}
              >
                <Value>{company.banker || "—"}</Value>
              </Field>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-8 gap-y-3">
          <Field label="Website" editing={editing} editor={textInput("website", "https://...")}>
            {company.website ? (
              <a
                href={websiteHref(company.website)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline text-xs inline-flex items-start gap-1 break-all"
              >
                <span className="break-all">{company.website}</span>
                <ExternalLink className="h-3 w-3 shrink-0 mt-0.5" />
              </a>
            ) : (
              <span className="text-sm text-muted-foreground">—</span>
            )}
          </Field>
          <Field
            label="Ownership"
            editing={editing}
            editor={select("ownership", OWNERSHIP_OPTIONS.map((o) => ({ value: o, label: o })))}
          >
            <Value>{company.ownership || "—"}</Value>
          </Field>
          <Field
            label="Current Stage"
            editing={editing}
            editor={
              form &&
              select(
                "pipeline_stage",
                stageSelectOptions(pipelineStages.liveKeys, form.pipeline_stage).map((s) => ({
                  value: s,
                  label: stageLabel(s),
                })),
                { allowNone: false },
              )
            }
          >
            <Badge variant="outline" className="text-xs px-2 py-0.5 mt-0.5">
              {stageLabel(company.pipeline_stage)}
            </Badge>
          </Field>
          <Field
            label="Valuation"
            editing={editing}
            editor={
              form && (
                <Input
                  type="number"
                  step="0.01"
                  value={form.ev_2024}
                  onChange={(e) => set({ ev_2024: e.target.value })}
                  placeholder="USD millions"
                  disabled={isSaving}
                  className="mt-1 h-7 text-sm"
                />
              )
            }
          >
            <Value>{formatMoneyMn(company.ev_2024, currency)}</Value>
          </Field>
          <Field
            label={leadLabel}
            editing={editing}
            editor={
              form && (
                <div className="mt-1">
                  <UserSelectCombobox
                    value={form[leadField] || null}
                    users={users}
                    placeholder={
                      trackPics.length > 0 ? `${trackPics.join(", ")} (from track)` : `Set ${leadLabel}…`
                    }
                    searchPlaceholder="Search a team member…"
                    emptyText="No team members found."
                    onChange={(v) => set({ [leadField]: v } as Partial<CompanyInfoForm>)}
                    disabled={isSaving}
                  />
                </div>
              )
            }
          >
            <Value>{effectiveDealLead(company, stage, tracks, pipelineStages.captainKeys) ?? "—"}</Value>
          </Field>
          <Field
            label="Status"
            editing={editing}
            editor={
              form && (
                <div className="mt-1">
                  <StatusCombobox
                    value={form.workflow_status || null}
                    options={statusOptions}
                    placeholder={inbound ? "Unreviewed" : "Set status…"}
                    onChange={(v) => set({ workflow_status: v })}
                    disabled={isSaving}
                  />
                </div>
              )
            }
          >
            <Value>{company.workflow_status || "—"}</Value>
          </Field>
          <Field
            label="Deal Status"
            editing={editing}
            editor={
              <div className="mt-1">
                <Select
                  value={company.status === "dropped" ? "dropped" : "active"}
                  onValueChange={(v) => onDealStatusChange(v as "active" | "dropped")}
                  disabled={isSaving || dealStatusBusy}
                >
                  <SelectTrigger data-testid="deal-status-select" className="h-7 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="dropped">Dropped</SelectItem>
                  </SelectContent>
                </Select>
                {company.status === "dropped" && company.dropped_reason && (
                  <p className="mt-1 text-xs text-muted-foreground">Reason: {company.dropped_reason}</p>
                )}
              </div>
            }
          >
            <Value>{company.status === "dropped" ? "Dropped" : "Active"}</Value>
          </Field>
          <Field
            label="Live Process"
            editing={editing}
            editor={select(
              "is_live",
              [
                { value: "__auto__", label: "Auto (from advisor)" },
                { value: "true", label: "Live process" },
                { value: "false", label: "Not live" },
              ],
              { allowNone: false },
            )}
          >
            <Value>
              {isDealLive(company) ? "Live process" : "Not live"}
              {company.is_live == null && (
                <span className="text-muted-foreground font-normal"> (auto)</span>
              )}
            </Value>
          </Field>
          <Field label="Last Activity" editing={editing} editor={textInput("last_activity_at", undefined, "date")}>
            <Value>{formatDate(company.last_activity_at)}</Value>
          </Field>
          <Field label="NBO Due Date" editing={editing} editor={textInput("nbo_date", undefined, "date")}>
            <Value>{company.nbo_date ? formatDate(`${company.nbo_date}T00:00:00`) : "—"}</Value>
          </Field>

          {inbound && (
            <>
              <Field label="Advisor" editing={editing} editor={bankerPicker("advisor", "Set advisor…")}>
                <Value>{company.advisor || "—"}</Value>
              </Field>
              <Field
                label="Doc Type"
                editing={editing}
                editor={select("doc_type", [
                  { value: "teaser", label: "Teaser" },
                  { value: "shopping_list", label: "Shopping List" },
                  { value: "market_study", label: "Market Study" },
                ])}
              >
                <Value className="capitalize">
                  {company.doc_type ? company.doc_type.replace(/_/g, " ") : "—"}
                </Value>
              </Field>
              <Field
                label="% Stake"
                editing={editing}
                editor={
                  form && (
                    <Input
                      value={form.stake}
                      onChange={(e) => set({ stake: e.target.value })}
                      placeholder="e.g. 51%"
                      title="Target ownership percentage being pursued"
                      disabled={isSaving}
                      className="mt-1 h-7 text-sm"
                    />
                  )
                }
              >
                <Value>{company.stake || "—"}</Value>
              </Field>
              <Field label="Deal Size" editing={editing} editor={textInput("deal_size")}>
                <Value>{company.deal_size || "—"}</Value>
              </Field>
              <Field
                label="Additional Remarks"
                editing={editing}
                editor={textArea("remarks")}
                className="col-span-2"
              >
                <Value className="whitespace-pre-wrap">{company.remarks || "—"}</Value>
              </Field>
            </>
          )}

          {!inbound && (
            <Field
              label="Key Rationale"
              editing={editing}
              editor={textArea("key_rationale")}
              className="col-span-2"
            >
              <Value className="whitespace-pre-wrap">{company.key_rationale || "—"}</Value>
            </Field>
          )}

          <Field
            label="Matched Tracks"
            editing={editing}
            className="col-span-2"
            editor={
              form && (
                <div className="mt-1">
                  <TrackMultiSelect
                    tracks={tracks}
                    value={form.matched_track_ids}
                    onChange={(next) => set({ matched_track_ids: next })}
                    disabled={isSaving}
                    placeholder="Select tracks…"
                    className="w-full"
                  />
                </div>
              )
            }
          >
            {matchedTracks.length === 0 ? (
              <Value>—</Value>
            ) : (
              <div className="flex flex-wrap gap-1 mt-1">
                {matchedTracks.map((track) => (
                  <Badge
                    key={track.id}
                    variant="secondary"
                    className="font-normal"
                    title={track.title ?? undefined}
                  >
                    {trackDisplayName(track)}
                  </Badge>
                ))}
              </div>
            )}
          </Field>
        </div>

        {/* Company Focus / Comments are free text, so they sit below the grid.
            While editing both always render (even when empty) — that's the only
            way to fill in a blank one. */}
        {(editing || company.company_focus) && (
          <Field
            label="Company Focus"
            editing={editing}
            editor={textArea("company_focus", "What the company focuses on…")}
            className="pt-3 border-t"
          >
            <p className="text-sm break-words whitespace-pre-wrap">{company.company_focus}</p>
          </Field>
        )}
        {(editing || company.comments) && (
          <Field
            label="Comments"
            editing={editing}
            editor={textArea("comments", "Internal comments on this deal…")}
            className="pt-3 border-t"
          >
            <p className="text-sm break-words whitespace-pre-wrap">{company.comments}</p>
          </Field>
        )}
      </div>

      {editing && (
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={editor.cancelEditing} disabled={isSaving} size="sm">
            Cancel
          </Button>
          <Button onClick={() => void editor.saveEditing()} disabled={isSaving} size="sm" className="gap-1">
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

function StageHistoryCard({
  stageHistory,
  stageLabel,
}: {
  stageHistory: StageHistoryEntry[];
  stageLabel: (stage: string) => string;
}) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
        <Clock className="h-3.5 w-3.5" />
        Stage History
      </p>
      {stageHistory.length === 0 ? (
        <p className="text-muted-foreground text-sm">No history yet</p>
      ) : (
        <div className="space-y-1">
          {stageHistory.map((history) => (
            <div key={history.id} className="flex items-center justify-between py-1.5 border-b last:border-0">
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="text-xs px-2 py-0.5">
                  {stageLabel(history.stage)}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {format(new Date(history.entered_at), "MMM d, yyyy HH:mm")}
                </span>
              </div>
              <span className="text-xs font-medium">
                {history.exited_at ? formatDuration(history.duration_seconds) : "Current"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AICompanyCard({
  analysis,
  generating,
  cancelling,
  onCancel,
  onRetry,
}: {
  analysis: DetailsTabAnalysis | null;
  generating: boolean;
  cancelling: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  if (generating && !analysis?.business_overview) {
    return <AICompanyCardLoading onCancel={onCancel} cancelling={cancelling} />;
  }
  if (analysis?.status === "failed") {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 flex flex-col items-center justify-center gap-3">
        <AlertCircle className="h-6 w-6 text-destructive" />
        <div className="text-center">
          <h3 className="text-base font-semibold text-destructive">Analysis Failed</h3>
          <p className="text-sm text-muted-foreground mt-1">
            {analysis.error_message ?? "An error occurred while generating the analysis."}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry} disabled={generating}>
          <Sparkles className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }
  if (analysis?.status !== "completed") return null;

  return (
    <div className="space-y-4">
      {analysis.created_at && (
        <p className="text-xs text-muted-foreground">
          Generated {formatDistanceToNow(new Date(analysis.created_at), { addSuffix: true })} · a
          stage move or Regenerate refreshes it against newer documents
        </p>
      )}
      {Array.isArray(analysis.sources) && analysis.sources.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">Sources:</span>
          {analysis.sources.map((source, idx) =>
            source.url ? (
              <a
                key={idx}
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-accent/10 text-accent text-xs hover:bg-accent/20 transition-colors"
              >
                <Globe className="h-3 w-3" />
                {source.title || new URL(source.url).hostname}
                <ExternalLink className="h-2.5 w-2.5" />
              </a>
            ) : (
              <span
                key={idx}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-accent/10 text-accent text-xs"
              >
                {source.type === "database" || source.type === "files" ? (
                  <FileText className="h-3 w-3" />
                ) : (
                  <Globe className="h-3 w-3" />
                )}
                {source.title || source.type}
              </span>
            ),
          )}
        </div>
      )}
      <CompanyAnalysisSection title="Business Overview" description="Products, end markets, customer types, and geographic footprint." icon={Building2} content={analysis.business_overview || ""} colorVariant="default" />
      <CompanyAnalysisSection title="Business Model & Value Chain Summary" description="How the company operates economically and its position in the value chain." icon={Briefcase} content={analysis.business_model_summary || ""} colorVariant="teal" />
      <CompanyAnalysisSection title="Key Takeaways" description="The most important implications from the analysis (3-5 synthesized insights)." icon={Lightbulb} content={analysis.key_takeaways || ""} colorVariant="blue" />
      <CompanyAnalysisSection title="Investment Highlights" description="Upside drivers linked to the company's business model and positioning." icon={TrendingUp} content={analysis.investment_highlights || ""} colorVariant="green" />
      <CompanyAnalysisSection title="Investment Risks" description="Risks inherent to the company's business model and value chain." icon={AlertTriangle} content={analysis.investment_risks || ""} colorVariant="amber" />
      <CompanyAnalysisSection title="Diligence Priorities" description="Critical unknowns to resolve before advancing investment (3-7 items)." icon={Search} content={analysis.diligence_priorities || ""} colorVariant="rose" />
    </div>
  );
}
