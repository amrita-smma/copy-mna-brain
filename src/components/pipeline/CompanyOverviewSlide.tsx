"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Building2,
  TrendingUp,
  FileBarChart,
  ClipboardCheck,
  ArrowRight,
  Sparkles,
  Pencil,
  Send,
  Loader2,
  X,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import { getTrackVariables, type TrackVariable } from "@/lib/api/pipeline";
import { companyDisplayTitle } from "@/lib/companyDisplay";
import { isDealLive } from "@/lib/dealStatus";
import {
  effectiveDealLead,
  dealLeadLabel,
  type TrackLike,
} from "@/lib/tracks/matchTracks";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/**
 * Read-only "L0 → L1 Submission" overview slide. The narrative sections are
 * populated from the AI Company Card (`analysis`); the structural fields
 * (meta, financials, deal structure) are derived from the company record.
 * Layout mirrors the FMS L0→L1 submission template.
 */

interface FinancialRow {
  fiscal_year: number;
  revenue_usd_mn: number | null;
  ebitda_usd_mn: number | null;
}

export interface OverviewSlideCompany {
  target: string | null;
  project_name?: string | null;
  segment: string | null;
  geography: string | null;
  pipeline_stage: string | null;
  deal_type?: string | null;
  stake?: string | null;
  deal_size?: string | null;
  ev_2024: number | null;
  ownership: string | null;
  banker?: string | null;
  /** Who entered the company: "AI Email Scanning" or the uploader's name. */
  entered_by_name?: string | null;
  /**
   * Deal Sponsor (L0–L2) / Deal Captain (L3+) per-company overrides —
   * resolved user names (the stored columns are uuid FKs to users.id).
   */
  deal_sponsor_name?: string | null;
  deal_captain_name?: string | null;
  /** Track ids the company is matched to — drives the Track-PIC fallback. */
  matched_track_ids?: string[] | null;
  /** Deal advisor. A non-empty advisor implies the deal is "live" by default. */
  advisor?: string | null;
  /** Explicit "live process" override. Null ⇒ derive from advisor presence. */
  is_live?: boolean | null;
  /** NBO (Non-Binding Offer) due date (YYYY-MM-DD). */
  nbo_date?: string | null;
  source: string | null;
  revenue_2022_usd_mn: number | null;
  revenue_2023_usd_mn: number | null;
  revenue_2024_usd_mn: number | null;
  ebitda_2022_usd_mn: number | null;
  ebitda_2023_usd_mn: number | null;
  ebitda_2024_usd_mn: number | null;
  financials_raw?: FinancialRow[];
  /** Per-track variable values: { [trackId]: { [variableId]: value } }. */
  track_specific_variables?: Record<string, Record<string, string>> | null;
  /** Track variable ids the user opted to surface under Indicative Financials. */
  slide_track_variable_ids?: string[] | null;
}

export interface OverviewSlideAnalysis {
  business_overview: string | null;
  business_model_summary: string | null;
  key_takeaways: string | null;
  investment_highlights: string | null;
  investment_risks: string | null;
  diligence_priorities: string | null;
}

/** The AI-narrative card sections that can be edited in place via the copilot. */
export type AnalysisSectionKey = keyof OverviewSlideAnalysis;

export interface EditSectionRequest {
  sectionKey: AnalysisSectionKey;
  sectionTitle: string;
  currentContent: string;
  instruction: string;
}

const STAGES = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;

const fmtMoney = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "—";
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(2)}B`;
  return `$${value.toFixed(1)}M`;
};

/** Format a date-only value ("YYYY-MM-DD") as "MMM d, yyyy" without TZ shifts. */
const fmtDate = (value: string | null | undefined): string => {
  if (!value) return "—";
  const [y, m, d] = value.split("T")[0].split("-").map(Number);
  if (!y || !m || !d) return value;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

/** EBITDA margin = EBITDA / Revenue, shown as a percentage. */
const fmtMargin = (
  ebitda: number | null | undefined,
  revenue: number | null | undefined,
): string => {
  if (
    ebitda === null ||
    ebitda === undefined ||
    revenue === null ||
    revenue === undefined ||
    revenue === 0
  ) {
    return "—";
  }
  return `${((ebitda / revenue) * 100).toFixed(1)}%`;
};

function buildFinancials(company: OverviewSlideCompany): {
  year: number;
  revenue: number | null;
  ebitda: number | null;
}[] {
  if (company.financials_raw && company.financials_raw.length > 0) {
    return [...company.financials_raw]
      .sort((a, b) => a.fiscal_year - b.fiscal_year)
      .slice(-3)
      .map((r) => ({
        year: r.fiscal_year,
        revenue: r.revenue_usd_mn,
        ebitda: r.ebitda_usd_mn,
      }));
  }
  return [2022, 2023, 2024]
    .map((y) => ({
      year: y,
      revenue: company[`revenue_${y}_usd_mn` as keyof OverviewSlideCompany] as
        | number
        | null,
      ebitda: company[`ebitda_${y}_usd_mn` as keyof OverviewSlideCompany] as
        | number
        | null,
    }))
    .filter((r) => r.revenue != null || r.ebitda != null);
}

function SectionHeading({
  icon: Icon,
  index,
  title,
}: {
  icon: React.ComponentType<{ className?: string }>;
  index: number;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2 border-b-2 border-blue-300 pb-1.5 mb-2.5">
      <span className="flex h-5 w-5 items-center justify-center rounded bg-blue-800 text-[11px] font-bold text-white">
        {index}
      </span>
      <Icon className="h-4 w-4 text-blue-800" />
      <h3 className="text-[13px] font-bold text-blue-900 dark:text-blue-200">
        {title}
      </h3>
    </div>
  );
}

/** AI narrative block: render markdown when present, else a muted placeholder. */
function AIText({ content, placeholder }: { content: string | null; placeholder: string }) {
  if (content && content.trim()) {
    return <MarkdownRenderer content={content} variant="card" />;
  }
  return <p className="text-[12px] italic text-muted-foreground">{placeholder}</p>;
}

/**
 * Wraps an AI-narrative block so it can be refined in place. Right-clicking (or
 * hovering and clicking the floating "Edit" pill) opens an inline prompt; on
 * submit it bubbles a targeted edit request up to the parent, which forwards it
 * to the AI CoPilot. When `isEditing` is set, the block shows a busy overlay
 * while the copilot rewrites the section.
 */
function EditableSection({
  sectionKey,
  sectionTitle,
  currentContent,
  isEditing,
  onEditSection,
  children,
}: {
  sectionKey: AnalysisSectionKey;
  sectionTitle: string;
  currentContent: string | null;
  isEditing: boolean;
  onEditSection?: (req: EditSectionRequest) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");

  // No handler wired (e.g. read-only contexts) → render the content untouched.
  if (!onEditSection) return <>{children}</>;

  const close = () => {
    setOpen(false);
    setInstruction("");
  };

  const submit = () => {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    onEditSection({
      sectionKey,
      sectionTitle,
      currentContent: currentContent ?? "",
      instruction: trimmed,
    });
    close();
  };

  return (
    <div className="relative">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "group/edit relative rounded-md -mx-1.5 px-1.5 py-1 transition-colors",
              "hover:bg-blue-50/60 dark:hover:bg-blue-950/20",
              open &&
                "bg-blue-50/60 ring-1 ring-blue-200 dark:bg-blue-950/20 dark:ring-blue-800",
            )}
          >
            {children}
            {!open && !isEditing && (
              <button
                type="button"
                onClick={() => setOpen(true)}
                title={`Edit "${sectionTitle}" with AI`}
                aria-label={`Edit "${sectionTitle}" with AI`}
                className="absolute right-1 top-1 hidden items-center gap-1 rounded border border-blue-300 bg-white/90 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 shadow-sm group-hover/edit:inline-flex dark:border-blue-700 dark:bg-card dark:text-blue-300"
              >
                <Pencil className="h-3 w-3" />
                Edit
              </button>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setOpen(true)}>
            <Sparkles className="mr-2 h-3.5 w-3.5 text-purple-500" />
            Edit with AI
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {open && (
        <div className="mt-1.5 rounded-md border border-blue-200 bg-blue-50/50 p-2 dark:border-blue-800 dark:bg-blue-950/20">
          <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-blue-800 dark:text-blue-300">
            <Sparkles className="h-3 w-3" />
            Edit &ldquo;{sectionTitle}&rdquo; with AI CoPilot
          </div>
          <Textarea
            autoFocus
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
            rows={2}
            placeholder={`Describe the change — e.g. "Make this more concise" or "Add detail on customer concentration"`}
            className="min-h-0 text-[12px]"
          />
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={close}
            >
              <X className="mr-1 h-3 w-3" />
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-6 gap-1 bg-purple-600 px-2 text-[11px] text-white hover:bg-purple-700"
              onClick={submit}
              disabled={!instruction.trim()}
            >
              <Send className="h-3 w-3" />
              Send to CoPilot
            </Button>
          </div>
        </div>
      )}

      {isEditing && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-white/70 backdrop-blur-[1px] dark:bg-card/70">
          <div className="flex items-center gap-2 rounded-full border border-blue-200 bg-white px-3 py-1 text-[11px] font-medium text-blue-700 shadow-sm dark:border-blue-800 dark:bg-card dark:text-blue-300">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Updating with AI…
          </div>
        </div>
      )}
    </div>
  );
}

export default function CompanyOverviewSlide({
  company,
  analysis,
  tracks = [],
  onEditSection,
  editingSectionKey,
}: {
  company: OverviewSlideCompany;
  analysis: OverviewSlideAnalysis | null;
  /** Tracks used to resolve the Deal Sponsor/Captain fallback (Track PIC). */
  tracks?: TrackLike[];
  /**
   * Called when the user submits an inline AI edit for a card section. The
   * parent forwards a targeted prompt to the AI CoPilot. When omitted, sections
   * render read-only (no context menu / edit affordance).
   */
  onEditSection?: (req: EditSectionRequest) => void;
  /** The section currently being rewritten by the copilot (shows a busy overlay). */
  editingSectionKey?: AnalysisSectionKey | null;
}) {
  const title = companyDisplayTitle(company, "Company");
  const sector = company.segment || "—";
  const currentStage = (company.pipeline_stage || "L0").toUpperCase();
  const financials = buildFinancials(company);

  // Track variables the user flagged (via the eye toggle) to surface here. We
  // load the variable definitions to resolve names/units, then pair them with
  // the company's stored values.
  const slideVariableIds = useMemo(
    () => company.slide_track_variable_ids ?? [],
    [company.slide_track_variable_ids],
  );
  const [variableDefs, setVariableDefs] = useState<TrackVariable[]>([]);

  useEffect(() => {
    if (slideVariableIds.length === 0) {
      setVariableDefs([]);
      return;
    }
    let cancelled = false;
    getTrackVariables()
      .then((rows) => {
        if (!cancelled) setVariableDefs(rows);
      })
      .catch((err) => {
        console.error("Failed to load track variables for slide:", err);
        if (!cancelled) setVariableDefs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slideVariableIds]);

  const slideVariables = useMemo(() => {
    if (slideVariableIds.length === 0) return [];
    const selected = new Set(slideVariableIds);
    const valuesByTrack = company.track_specific_variables ?? {};
    return variableDefs
      .filter((v) => selected.has(v.id))
      .map((v) => ({
        id: v.id,
        name: v.name,
        unit: v.unit,
        value: valuesByTrack[v.track_id]?.[v.id] ?? "",
      }));
  }, [variableDefs, slideVariableIds, company.track_specific_variables]);

  // Live-process status: an explicit is_live override wins, otherwise it is
  // derived from the presence of an advisor.
  const isLive = isDealLive(company);
  const advisor = company.advisor?.trim() || null;

  // Source with attribution: inbound deals credit the introducing banker,
  // outbound deals credit whoever entered the company.
  const sourceBy =
    company.source === "inbound"
      ? company.banker?.trim() || null
      : company.source === "outbound"
        ? company.entered_by_name?.trim() || null
        : null;
  const sourceValue = company.source
    ? `${company.source[0].toUpperCase()}${company.source.slice(1)}${sourceBy ? ` (${sourceBy})` : ""}`
    : "—";

  // Deal Sponsor (L0–L2) / Deal Captain (L3+): per-company override, falling
  // back to the matched Track's PIC.
  const dealLead = effectiveDealLead(company, currentStage, tracks);

  const dealStructure: string[] = [
    `Deal type: ${company.deal_type ? company.deal_type[0].toUpperCase() + company.deal_type.slice(1) : "—"}`,
    `Target stake: ${company.stake && company.stake !== "—" ? company.stake : "TBC at L1"}`,
    `Indicative cheque size: ${company.deal_size && company.deal_size !== "—" ? company.deal_size : "TBC at L1"}`,
    `Indicative valuation (EV): ${fmtMoney(company.ev_2024)}`,
    `Sourcing: ${company.banker || (company.source === "outbound" ? "Outbound origination" : "—")}`,
  ];

  return (
    <div className="rounded-lg border bg-white dark:bg-card p-6 text-[12px] leading-relaxed text-foreground shadow-sm">
      {/* Header — title on the left, stage track pushed all the way right */}
      <div className="mb-4 flex flex-col gap-3 border-b-2 border-blue-800 pb-3 lg:flex-row lg:items-start lg:justify-between lg:gap-4">
        <div className="min-w-0">
          <div className="text-[20px] font-bold leading-tight text-blue-900 dark:text-blue-200">
            L0 to L1 Submission: {title}
          </div>
          <div className="mt-1 text-[12px] italic text-muted-foreground">
            {company.deal_type ? `${company.deal_type[0].toUpperCase()}${company.deal_type.slice(1)} ` : ""}
            investment in {sector}
            {company.geography ? ` · ${company.geography}` : ""}
          </div>
        </div>

        {/* Stage track */}
        <div className="flex flex-wrap items-center gap-px text-[10px] font-semibold text-muted-foreground lg:shrink-0 lg:justify-end">
          {STAGES.map((s) => (
            <span
              key={s}
              className={
                "border border-border px-2.5 py-1 " +
                (s === currentStage
                  ? "bg-blue-800 text-white border-blue-800"
                  : "bg-muted/40")
              }
            >
              {s}
            </span>
          ))}
          <span className="ml-2 inline-flex items-center gap-1 text-blue-800">
            <ArrowRight className="h-3.5 w-3.5" />
            Seeking approval
          </span>
        </div>
      </div>

      {/* Meta boxes */}
      <div className="mb-1.5 grid grid-cols-2 gap-1.5 md:grid-cols-4">
        {[
          ["Project Type", company.deal_type || "M&A"],
          ["Geography", company.geography || "—"],
          ["Business Line", sector],
          ["End Sector", sector.split("—")[0].split("-")[0].trim()],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded border border-border bg-muted/40 px-2.5 py-1.5 text-[11px]"
          >
            <span className="font-semibold text-blue-900 dark:text-blue-300">
              {label}:
            </span>{" "}
            {value}
          </div>
        ))}
      </div>

      {/* Deal status boxes — source (below Project Type), deal sponsor/captain,
          deal status + advisor, NBO due date. A non-empty advisor means the
          deal is assumed to be "live". */}
      <div className="mb-4 grid grid-cols-2 gap-1.5 md:grid-cols-4">
        <div className="rounded border border-border bg-muted/40 px-2.5 py-1.5 text-[11px]">
          <span className="font-semibold text-blue-900 dark:text-blue-300">
            Source:
          </span>{" "}
          {sourceValue}
        </div>
        <div className="rounded border border-border bg-muted/40 px-2.5 py-1.5 text-[11px]">
          <span className="font-semibold text-blue-900 dark:text-blue-300">
            {dealLeadLabel(currentStage)}:
          </span>{" "}
          {dealLead || "—"}
        </div>
        <div
          className={cn(
            "rounded border px-2.5 py-1.5 text-[11px]",
            isLive
              ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40"
              : "border-border bg-muted/40",
          )}
        >
          <span
            className={cn(
              "font-semibold",
              isLive
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-blue-900 dark:text-blue-300",
            )}
          >
            Deal Status:
          </span>{" "}
          {isLive ? `Live${advisor ? ` (${advisor})` : ""}` : "Not live"}
        </div>
        <div className="rounded border border-border bg-muted/40 px-2.5 py-1.5 text-[11px]">
          <span className="font-semibold text-blue-900 dark:text-blue-300">
            NBO Due:
          </span>{" "}
          {fmtDate(company.nbo_date)}
        </div>
      </div>

      {/* Body — narrative + structural sections flow across columns:
          three columns on large screens, two on smaller laptops, one on mobile. */}
      <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        <section>
          <SectionHeading icon={Building2} index={1} title="Target Overview" />
          <EditableSection
            sectionKey="business_overview"
            sectionTitle="Target Overview"
            currentContent={analysis?.business_overview ?? null}
            isEditing={editingSectionKey === "business_overview"}
            onEditSection={onEditSection}
          >
            <AIText
              content={analysis?.business_overview ?? null}
              placeholder="Target overview will appear here once the AI Company Card is generated."
            />
          </EditableSection>
          {company.ownership && (
            <p className="mt-2 text-[11.5px] text-muted-foreground">
              <span className="font-semibold">Shareholding:</span>{" "}
              {company.ownership}
            </p>
          )}
        </section>

        <section>
          <SectionHeading icon={TrendingUp} index={2} title="Investment Thesis" />
          <EditableSection
            sectionKey="investment_highlights"
            sectionTitle="Investment Thesis"
            currentContent={analysis?.investment_highlights ?? null}
            isEditing={editingSectionKey === "investment_highlights"}
            onEditSection={onEditSection}
          >
            <AIText
              content={analysis?.investment_highlights ?? null}
              placeholder="Investment highlights will appear here once the AI Company Card is generated."
            />
          </EditableSection>
          {analysis?.business_model_summary && (
            <div className="mt-2">
              <div className="text-[11px] font-bold text-blue-900 dark:text-blue-300">
                Business model &amp; value chain
              </div>
              <EditableSection
                sectionKey="business_model_summary"
                sectionTitle="Business Model & Value Chain"
                currentContent={analysis.business_model_summary}
                isEditing={editingSectionKey === "business_model_summary"}
                onEditSection={onEditSection}
              >
                <AIText content={analysis.business_model_summary} placeholder="" />
              </EditableSection>
            </div>
          )}
        </section>

        <section>
          <SectionHeading icon={FileBarChart} index={3} title="Proposed Deal Structure" />
          <ul className="list-disc space-y-1 pl-4 text-[11.5px]">
            {dealStructure.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <section>
          <SectionHeading icon={FileBarChart} index={4} title="Indicative Financials (USD m)" />
          {financials.length > 0 ? (
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <tr>
                    <th className="border border-border bg-blue-50 px-2 py-1 text-left font-semibold text-blue-900">
                      USD m
                    </th>
                    {financials.map((f) => (
                      <th
                        key={f.year}
                        className="border border-border bg-blue-50 px-2 py-1 text-right font-semibold text-blue-900"
                      >
                        {f.year}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="border border-border px-2 py-1 font-semibold">Revenue</td>
                    {financials.map((f) => (
                      <td key={f.year} className="border border-border px-2 py-1 text-right">
                        {fmtMoney(f.revenue)}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="border border-border px-2 py-1 font-semibold">EBITDA</td>
                    {financials.map((f) => (
                      <td key={f.year} className="border border-border px-2 py-1 text-right">
                        {fmtMoney(f.ebitda)}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="border border-border px-2 py-1 pl-4 italic text-muted-foreground">
                      EBITDA margin
                    </td>
                    {financials.map((f) => (
                      <td
                        key={f.year}
                        className="border border-border px-2 py-1 text-right italic text-muted-foreground"
                      >
                        {fmtMargin(f.ebitda, f.revenue)}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            ) : (
              <p className="text-[12px] italic text-muted-foreground">
                No financial data available.
              </p>
            )}
            {slideVariables.length > 0 && (
              <dl className="mt-2.5 space-y-1 border-t border-border pt-2">
                {slideVariables.map((v) => (
                  <div
                    key={v.id}
                    className="flex items-baseline justify-between gap-3 text-[11px]"
                  >
                    <dt className="font-semibold text-blue-900 dark:text-blue-300">
                      {v.name}
                      {v.unit ? (
                        <span className="font-normal text-muted-foreground/70">
                          {" "}
                          ({v.unit})
                        </span>
                      ) : null}
                    </dt>
                    <dd className="text-right tabular-nums">{v.value || "—"}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>

        <section>
          <SectionHeading
            icon={ClipboardCheck}
            index={5}
            title="L1 scope of work / diligence priorities"
          />
          <EditableSection
            sectionKey="diligence_priorities"
            sectionTitle="L1 Scope of Work / Diligence Priorities"
            currentContent={analysis?.diligence_priorities ?? null}
            isEditing={editingSectionKey === "diligence_priorities"}
            onEditSection={onEditSection}
          >
            <AIText
              content={analysis?.diligence_priorities ?? null}
              placeholder="Diligence priorities will appear here once the AI Company Card is generated."
            />
          </EditableSection>
          <div className="mt-2 text-[11px] font-bold text-red-600">Kill criteria</div>
          <EditableSection
            sectionKey="investment_risks"
            sectionTitle="Kill Criteria / Investment Risks"
            currentContent={analysis?.investment_risks ?? null}
            isEditing={editingSectionKey === "investment_risks"}
            onEditSection={onEditSection}
          >
            <AIText
              content={analysis?.investment_risks ?? null}
              placeholder="Investment risks will appear here once the AI Company Card is generated."
            />
          </EditableSection>
        </section>
      </div>

      <div className="mt-5 border-t border-border pt-2 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
        Strictly Private and Confidential
      </div>
    </div>
  );
}
