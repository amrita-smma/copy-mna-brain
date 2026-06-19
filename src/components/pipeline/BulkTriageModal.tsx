"use client";

import { useState, useMemo } from "react";
import { CheckCircle, XCircle, AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";

const DROP_REASONS = [
  "Outside thesis",
  "Below size threshold",
  "Duplicate",
  "Geography mismatch",
  "Insufficient information",
  "Valuation too high",
];

const DOC_TYPE_LABELS: Record<string, string> = {
  teaser: "Teaser",
  shopping_list: "Shopping List",
  market_study: "Market Study",
};

const DOC_TYPE_COLORS: Record<string, string> = {
  teaser: "bg-blue-50 text-blue-700 border-blue-200",
  shopping_list: "bg-purple-50 text-purple-700 border-purple-200",
  market_study: "bg-green-50 text-green-700 border-green-200",
};

interface TriageCompany {
  id: string;
  target: string | null;
  project_name: string | null;
  segment: string | null;
  geography: string | null;
  doc_type: string | null;
  banker_source: string | null;
  possible_duplicate_company_id: string | null;
  revenue_2024_usd_mn: number | null;
  ebitda_2024_usd_mn: number | null;
}

type Decision = "keep" | "drop" | "pending";

interface BulkTriageModalProps {
  open: boolean;
  companies: TriageCompany[];
  onClose: () => void;
  onConfirm: (decisions: Array<{ id: string; action: "keep" | "drop"; reason?: string }>) => Promise<void>;
}

export function BulkTriageModal({ open, companies, onClose, onConfirm }: BulkTriageModalProps) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [dropReasons, setDropReasons] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const counts = useMemo(() => {
    const kept = Object.values(decisions).filter((d) => d === "keep").length;
    const dropped = Object.values(decisions).filter((d) => d === "drop").length;
    const pending = companies.length - kept - dropped;
    return { kept, dropped, pending };
  }, [decisions, companies.length]);

  function setDecision(id: string, decision: Decision) {
    setDecisions((prev) => ({ ...prev, [id]: decision }));
  }

  function setDropReason(id: string, reason: string) {
    setDropReasons((prev) => ({ ...prev, [id]: reason }));
  }

  async function handleConfirm() {
    setSaving(true);
    try {
      const result = companies
        .filter((c) => decisions[c.id] && decisions[c.id] !== "pending")
        .map((c) => ({
          id: c.id,
          action: decisions[c.id] as "keep" | "drop",
          reason: decisions[c.id] === "drop" ? dropReasons[c.id] : undefined,
        }));
      await onConfirm(result);
      setDecisions({});
      setDropReasons({});
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const hasDecisions = Object.keys(decisions).length > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Triage Unreviewed Companies</DialogTitle>
        </DialogHeader>

        {/* Live counter */}
        <div className="flex gap-4 text-sm text-muted-foreground border-b pb-3">
          <span className="flex items-center gap-1.5 text-green-700">
            <CheckCircle className="h-4 w-4" />
            {counts.kept} kept
          </span>
          <span className="flex items-center gap-1.5 text-red-600">
            <XCircle className="h-4 w-4" />
            {counts.dropped} dropped
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-4 w-4 rounded-full border-2 border-muted-foreground/40" />
            {counts.pending} pending
          </span>
        </div>

        <ScrollArea className="max-h-[420px] pr-3">
          <div className="space-y-2">
            {companies.map((company) => {
              const decision = decisions[company.id] ?? "pending";
              return (
                <div
                  key={company.id}
                  className={`rounded-lg border p-3 transition-colors ${
                    decision === "keep"
                      ? "border-green-200 bg-green-50"
                      : decision === "drop"
                      ? "border-red-200 bg-red-50"
                      : "border-border bg-card"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium truncate">
                          {company.target ?? company.project_name ?? "Unknown"}
                        </span>
                        {company.doc_type && (
                          <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${DOC_TYPE_COLORS[company.doc_type] ?? "bg-muted text-muted-foreground border-border"}`}>
                            {DOC_TYPE_LABELS[company.doc_type] ?? company.doc_type}
                          </span>
                        )}
                        {company.possible_duplicate_company_id && (
                          <span className="flex items-center gap-1 text-xs text-amber-600">
                            <AlertTriangle className="h-3 w-3" />
                            Possible dup
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        {company.segment && <span>{company.segment}</span>}
                        {company.geography && <span>· {company.geography}</span>}
                        {company.banker_source && <span>· {company.banker_source}</span>}
                        {company.revenue_2024_usd_mn != null && (
                          <span>· Rev ${company.revenue_2024_usd_mn.toFixed(0)}M</span>
                        )}
                        {company.ebitda_2024_usd_mn != null && (
                          <span>· EBITDA ${company.ebitda_2024_usd_mn.toFixed(0)}M</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant={decision === "keep" ? "default" : "outline"}
                        className={`h-7 px-2.5 text-xs ${decision === "keep" ? "bg-green-600 hover:bg-green-700" : ""}`}
                        onClick={() => setDecision(company.id, "keep")}
                      >
                        <CheckCircle className="h-3.5 w-3.5 mr-1" />
                        Keep
                      </Button>
                      <Button
                        size="sm"
                        variant={decision === "drop" ? "destructive" : "outline"}
                        className="h-7 px-2.5 text-xs"
                        onClick={() => setDecision(company.id, "drop")}
                      >
                        <XCircle className="h-3.5 w-3.5 mr-1" />
                        Drop
                      </Button>
                    </div>
                  </div>
                  {decision === "drop" && (
                    <div className="mt-2">
                      <Select
                        value={dropReasons[company.id] ?? ""}
                        onValueChange={(v) => setDropReason(company.id, v)}
                      >
                        <SelectTrigger className="h-7 text-xs">
                          <SelectValue placeholder="Select reason…" />
                        </SelectTrigger>
                        <SelectContent>
                          {DROP_REASONS.map((r) => (
                            <SelectItem key={r} value={r} className="text-xs">
                              {r}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!hasDecisions || saving}
          >
            {saving ? "Applying…" : `Apply ${Object.keys(decisions).length} decision${Object.keys(decisions).length !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
