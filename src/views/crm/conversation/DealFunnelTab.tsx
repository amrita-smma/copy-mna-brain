"use client";

import type { BankerScorecard } from "@/lib/api/contactInsights";
import { INSIGHTS_PERIODS, type InsightsPeriod } from "@/lib/crm/insightsPeriod";
import { CornerDownRight, Loader2 } from "lucide-react";
import { computeFunnelStages, parseStageLabel, summariseFunnel } from "./funnel";
import { NoData, SectionLabel } from "./SectionLabel";

const PERIOD_LABELS: Record<InsightsPeriod, string> = {
  all: "All period",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  ytd: "Year to date",
  "12m": "Last 12 months",
};

/** Opaque tints of the primary colour, so the boxes read the same on both themes. */
const SUMMARY_BG = "bg-[color-mix(in_oklab,hsl(var(--primary))_8%,hsl(var(--card)))]";
const STEP_PILL =
  "bg-[color-mix(in_oklab,hsl(var(--primary))_14%,hsl(var(--card)))] text-primary";

/** Bars darken stage by stage; the last stage is solid primary. */
function barStyle(idx: number, count: number): React.CSSProperties {
  const isLast = idx === count - 1;
  const mix = Math.min(28 + idx * 14, 100);
  return {
    background: isLast
      ? "hsl(var(--primary))"
      : `color-mix(in oklab, hsl(var(--primary)) ${mix}%, hsl(var(--card)))`,
    color: isLast || idx >= 3 ? "hsl(var(--primary-foreground))" : "hsl(var(--foreground))",
  };
}

const GRID = "grid grid-cols-[minmax(0,190px)_minmax(0,1fr)_120px] items-center gap-3";

export function DealFunnelTab({
  scorecard,
  period,
  onPeriodChange,
  loading = false,
  contactFirstName,
}: {
  scorecard: BankerScorecard | null;
  period: InsightsPeriod;
  onPeriodChange: (period: InsightsPeriod) => void;
  loading?: boolean;
  contactFirstName: string;
}) {
  const hasLinks = Boolean(scorecard?.hasDealLinks);
  const stages = scorecard?.stageBreakdown
    ? computeFunnelStages(scorecard.stageBreakdown)
    : [];
  const summary = scorecard ? summariseFunnel(stages, contactFirstName) : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <SectionLabel ai={false}>Deal funnel</SectionLabel>
          <div className="flex items-center gap-2">
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            <select
              value={period}
              onChange={(e) => onPeriodChange(e.target.value as InsightsPeriod)}
              className="h-7 cursor-pointer rounded-md border border-input bg-card px-2 text-xs text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              data-testid="contact-conversation-funnel-period"
              aria-label="Funnel period"
            >
              {INSIGHTS_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {PERIOD_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Furthest stage reached by the deals {contactFirstName} brought in this period
        </p>
      </div>

      {!hasLinks || stages.length === 0 ? (
        <NoData text="No linked deals in this period" />
      ) : (
        <>
          {summary.length > 0 && (
            <div
              className={`flex flex-col gap-2 rounded-lg px-3.5 py-3 ${SUMMARY_BG}`}
              data-testid="contact-conversation-funnel-summary"
            >
              <div className="flex items-center justify-between gap-2">
                <SectionLabel ai={false}>Summary</SectionLabel>
                <span className="text-xs text-muted-foreground">From linked deals</span>
              </div>
              <ul className="flex list-disc flex-col gap-1 pl-[18px]">
                {summary.map((pt) => (
                  <li key={pt} className="text-[13px] leading-relaxed text-foreground">
                    {pt}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-col rounded-lg border bg-card p-3">
            <div
              className={`${GRID} mb-1.5 border-b pb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground`}
            >
              <span>Stage</span>
              <span>Companies</span>
              <span className="whitespace-nowrap text-right leading-tight tracking-normal">
                Conversion
                <br />
                from prev. stage
              </span>
            </div>
            {stages.map((stage, idx) => {
              const { level, name } = parseStageLabel(stage.label);
              // "—": first stage, or nothing reached the stage before.
              const hasStep = stage.conversionFromPrev !== "—";
              return (
                <div
                  key={stage.stageKey}
                  className={`${GRID} min-h-[38px]`}
                  data-testid="contact-conversation-funnel-stage"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {level && (
                      <span className="flex-none rounded bg-muted px-1.5 text-xs font-bold leading-[18px] text-muted-foreground">
                        {level}
                      </span>
                    )}
                    <span className="truncate text-[13px] font-semibold" title={name}>
                      {name}
                    </span>
                  </div>
                  <div className="flex">
                    <div
                      className="flex h-[26px] min-w-[36px] items-center justify-center rounded text-[13px] font-bold"
                      style={{ width: `${stage.percentageOfTotal}%`, ...barStyle(idx, stages.length) }}
                    >
                      {stage.funnelCount}
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-1.5">
                    {hasStep && (
                      <CornerDownRight className="h-3 w-3 text-muted-foreground" aria-hidden />
                    )}
                    <span
                      className={
                        hasStep
                          ? `min-w-[44px] rounded-full px-1.5 text-center text-xs font-semibold leading-5 ${STEP_PILL}`
                          : "min-w-[44px] text-center text-xs text-muted-foreground"
                      }
                    >
                      {stage.conversionFromPrev}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
