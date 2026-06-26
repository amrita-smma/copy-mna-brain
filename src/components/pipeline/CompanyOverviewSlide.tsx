"use client";

import { Building2, TrendingUp, FileBarChart, ClipboardCheck, ArrowRight } from "lucide-react";
import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import { companyDisplayTitle } from "@/lib/companyDisplay";

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
  source: string | null;
  revenue_2022_usd_mn: number | null;
  revenue_2023_usd_mn: number | null;
  revenue_2024_usd_mn: number | null;
  ebitda_2022_usd_mn: number | null;
  ebitda_2023_usd_mn: number | null;
  ebitda_2024_usd_mn: number | null;
  financials_raw?: FinancialRow[];
}

export interface OverviewSlideAnalysis {
  business_overview: string | null;
  business_model_summary: string | null;
  key_takeaways: string | null;
  investment_highlights: string | null;
  investment_risks: string | null;
  diligence_priorities: string | null;
}

const STAGES = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;

const fmtMoney = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "—";
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(2)}B`;
  return `$${value.toFixed(1)}M`;
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

export default function CompanyOverviewSlide({
  company,
  analysis,
}: {
  company: OverviewSlideCompany;
  analysis: OverviewSlideAnalysis | null;
}) {
  const title = companyDisplayTitle(company, "Company");
  const sector = company.segment || "—";
  const currentStage = (company.pipeline_stage || "L0").toUpperCase();
  const financials = buildFinancials(company);

  const dealStructure: string[] = [
    `Deal type: ${company.deal_type ? company.deal_type[0].toUpperCase() + company.deal_type.slice(1) : "—"}`,
    `Target stake: ${company.stake && company.stake !== "—" ? company.stake : "TBC at L1"}`,
    `Indicative cheque size: ${company.deal_size && company.deal_size !== "—" ? company.deal_size : "TBC at L1"}`,
    `Indicative valuation (EV): ${fmtMoney(company.ev_2024)}`,
    `Sourcing: ${company.banker || (company.source === "outbound" ? "Outbound origination" : "—")}`,
  ];

  return (
    <div className="rounded-lg border bg-white dark:bg-card p-6 text-[12px] leading-relaxed text-foreground shadow-sm">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-4 border-b-2 border-blue-800 pb-3">
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
      </div>

      {/* Meta boxes */}
      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
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

      {/* Stage track */}
      <div className="mb-5 flex flex-wrap items-center gap-px text-[10px] font-semibold text-muted-foreground">
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

      {/* Body */}
      <div className="grid gap-5 md:grid-cols-2">
        {/* Left column */}
        <div className="space-y-5">
          <section>
            <SectionHeading icon={Building2} index={1} title="Target Overview" />
            <AIText
              content={analysis?.business_overview ?? null}
              placeholder="Target overview will appear here once the AI Company Card is generated."
            />
            {company.ownership && (
              <p className="mt-2 text-[11.5px] text-muted-foreground">
                <span className="font-semibold">Shareholding:</span>{" "}
                {company.ownership}
              </p>
            )}
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
                </tbody>
              </table>
            ) : (
              <p className="text-[12px] italic text-muted-foreground">
                No financial data available.
              </p>
            )}
          </section>
        </div>

        {/* Right column */}
        <div className="space-y-5">
          <section>
            <SectionHeading icon={TrendingUp} index={2} title="Investment Thesis" />
            <AIText
              content={analysis?.investment_highlights ?? null}
              placeholder="Investment highlights will appear here once the AI Company Card is generated."
            />
            {analysis?.business_model_summary && (
              <div className="mt-2">
                <div className="text-[11px] font-bold text-blue-900 dark:text-blue-300">
                  Business model &amp; value chain
                </div>
                <AIText content={analysis.business_model_summary} placeholder="" />
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Bottom row */}
      <div className="mt-5 grid gap-5 border-t border-border pt-4 md:grid-cols-2">
        <section>
          <SectionHeading icon={FileBarChart} index={3} title="Proposed Deal Structure" />
          <ul className="list-disc space-y-1 pl-4 text-[11.5px]">
            {dealStructure.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <section>
          <SectionHeading icon={ClipboardCheck} index={5} title="L1 Approval Request" />
          <div className="text-[11px] font-bold text-blue-900 dark:text-blue-300">
            L1 scope of work / diligence priorities
          </div>
          <AIText
            content={analysis?.diligence_priorities ?? null}
            placeholder="Diligence priorities will appear here once the AI Company Card is generated."
          />
          <div className="mt-2 text-[11px] font-bold text-red-600">Kill criteria</div>
          <AIText
            content={analysis?.investment_risks ?? null}
            placeholder="Investment risks will appear here once the AI Company Card is generated."
          />
        </section>
      </div>

      <div className="mt-5 border-t border-border pt-2 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
        Strictly Private and Confidential
      </div>
    </div>
  );
}
