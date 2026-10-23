import type { BankerStageCount } from "@/lib/api/contactInsights";
import { plural } from "../utils";

export interface FunnelStage {
  stageKey: string;
  label: string;
  /** Deals brought sitting in this stage now, not dropped. */
  currentCount: number;
  funnelCount: number;
  conversionFromPrev: string;
  percentageOfTotal: number;
}

/**
 * Computes suffix sums across pipeline stages in pipeline order:
 * The bar for stage k = number of deals whose furthest stage is k or later.
 * Step conversion is vs the previous stage ("—" when previous is 0 or for the first stage).
 */
export function computeFunnelStages(
  stageBreakdown: BankerStageCount[],
): FunnelStage[] {
  const n = stageBreakdown.length;
  const funnelCounts = new Array<number>(n).fill(0);

  // Compute suffix sums from right to left
  let running = 0;
  for (let i = n - 1; i >= 0; i--) {
    running += stageBreakdown[i].count;
    funnelCounts[i] = running;
  }

  const total = funnelCounts[0];

  return stageBreakdown.map((s, idx) => {
    const funnelCount = funnelCounts[idx];
    let conversionFromPrev = "—";

    if (idx > 0) {
      const prevFunnelCount = funnelCounts[idx - 1];
      if (prevFunnelCount > 0) {
        conversionFromPrev = `${Math.round((funnelCount / prevFunnelCount) * 100)}%`;
      }
    }

    const percentageOfTotal =
      total > 0 ? Math.round((funnelCount / total) * 100) : 0;

    return {
      stageKey: s.stageKey,
      label: s.label,
      currentCount: s.currentCount,
      funnelCount,
      conversionFromPrev,
      percentageOfTotal,
    };
  });
}

/** "L3 · Due Diligence" → { level: "L3", name: "Due Diligence" }; pre-pipeline labels have no level. */
export function parseStageLabel(label: string): { level: string | null; name: string } {
  const m = /^(L\d+)\s*·\s*(.+)$/.exec(label.trim());
  return m ? { level: m[1], name: m[2] } : { level: null, name: label.trim() };
}

/**
 * Plain-arithmetic bullets for the funnel's summary box: deals brought and how
 * many reached the last stage, the biggest drop-off, and how many live deals
 * sit in the two stages before the last. Stages are referred to by position
 * and label, never by a hardcoded name, because stage names vary by
 * workspace. Returns [] when nothing was brought.
 */
export function summariseFunnel(stages: FunnelStage[], firstName: string): string[] {
  const total = stages[0]?.funnelCount ?? 0;
  if (total === 0) return [];

  const brought = `${firstName} brought ${plural(total, "deal")}`;
  const last = stages[stages.length - 1];
  const bullets = [
    stages.length > 1
      ? `${brought}; ${last.funnelCount} reached ${parseStageLabel(last.label).name} (${last.percentageOfTotal}% end-to-end).`
      : `${brought}.`,
  ];

  let worst: { idx: number; ratio: number } | null = null;
  for (let i = 1; i < stages.length; i++) {
    const prev = stages[i - 1].funnelCount;
    if (prev === 0) continue;
    const ratio = stages[i].funnelCount / prev;
    if (ratio < 1 && (!worst || ratio < worst.ratio)) worst = { idx: i, ratio };
  }
  if (worst) {
    const from = parseStageLabel(stages[worst.idx - 1].label);
    const to = parseStageLabel(stages[worst.idx].label);
    const step =
      from.level && to.level
        ? `${from.level} → ${to.level} (${to.name})`
        : `${from.name} → ${to.name}`;
    bullets.push(
      worst.ratio === 0
        ? `Biggest drop-off is ${step}: none got that far.`
        : `Biggest drop-off is ${step}, converting only ${Math.round(worst.ratio * 100)}%.`,
    );
  }

  // The two pipeline stages before the last one: where a live deal is closest
  // to closing, so where a follow-up pays most.
  const pipeline = stages.filter((s) => parseStageLabel(s.label).level !== null);
  if (pipeline.length >= 4) {
    const late = pipeline.slice(-3, -1);
    const live = late.reduce((n, s) => n + s.currentCount, 0);
    if (live > 0) {
      const names = late.map((s) => parseStageLabel(s.label).name).join(" or ");
      bullets.push(
        `${plural(live, "deal")} ${live === 1 ? "is" : "are"} in ${names} — prioritise follow-ups there.`,
      );
    }
  }

  return bullets;
}
