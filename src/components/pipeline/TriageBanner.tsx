"use client";

import { FileText, ShoppingCart, BarChart2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface TriageBannerProps {
  companies: Array<{ doc_type: string | null; pipeline_stage: string }>;
  onTriageClick: () => void;
}

const DOC_TYPE_LABELS: Record<string, string> = {
  teaser: "teaser",
  shopping_list: "shopping list",
  market_study: "market study",
};

const DOC_TYPE_ICONS: Record<string, React.ReactNode> = {
  teaser: <FileText className="h-3.5 w-3.5" />,
  shopping_list: <ShoppingCart className="h-3.5 w-3.5" />,
  market_study: <BarChart2 className="h-3.5 w-3.5" />,
};

export function TriageBanner({ companies, onTriageClick }: TriageBannerProps) {
  const unreviewed = companies.filter((c) => c.pipeline_stage === "unreviewed");
  if (unreviewed.length === 0) return null;

  const counts: Record<string, number> = {};
  for (const c of unreviewed) {
    const type = c.doc_type ?? "other";
    counts[type] = (counts[type] ?? 0) + 1;
  }

  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([type, n]) => `${n} ${n === 1 ? DOC_TYPE_LABELS[type] ?? type : (DOC_TYPE_LABELS[type] ?? type) + "s"}`);

  return (
    <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-4 dark:border-amber-900 dark:bg-amber-950 py-2.5 text-sm">
      <div className="flex items-center gap-3 text-amber-800 dark:text-amber-200">
        <div className="flex items-center gap-1.5 font-medium">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-400 text-[11px] font-bold text-white">
            {unreviewed.length}
          </span>
          new {unreviewed.length === 1 ? "company" : "companies"} from email attachments
        </div>
        <span className="text-amber-600 dark:text-amber-500">—</span>
        <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
          {Object.entries(counts).map(([type, n]) => (
            <span key={type} className="flex items-center gap-1">
              {DOC_TYPE_ICONS[type]}
              {n} {DOC_TYPE_LABELS[type] ?? type}
            </span>
          ))}
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="border-amber-300 bg-white text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-card dark:text-amber-200 dark:hover:bg-amber-900"
        onClick={onTriageClick}
      >
        Triage Unreviewed
      </Button>
    </div>
  );
}
