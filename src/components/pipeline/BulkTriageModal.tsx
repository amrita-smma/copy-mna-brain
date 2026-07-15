"use client";

import { useState, useMemo, useEffect } from "react";
import { CheckCircle, XCircle, AlertTriangle, AlertCircle, Pencil } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { companyDisplayName } from "@/lib/companyDisplay";

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
  shopping_list: "bg-blue-50 text-blue-700 border-blue-200",
  market_study: "bg-green-50 text-green-700 border-green-200",
};

interface KeepError {
  id: string;
  missingFields: string[];
}

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
  onConfirm: (decisions: Array<{ id: string; action: "keep" | "drop"; reason?: string }>) => Promise<{ keepErrors?: KeepError[] }>;
  onEdit: (id: string) => void;
}

export function BulkTriageModal({ open, companies, onClose, onConfirm, onEdit }: BulkTriageModalProps) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [dropReasons, setDropReasons] = useState<Record<string, string>>({});
  const [keepErrors, setKeepErrors] = useState<Record<string, string[]>>({});
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDecisions({});
      setDropReasons({});
      setKeepErrors({});
      setCompletedIds(new Set());
    }
  }, [open]);

  const counts = useMemo(() => {
    const active = companies.filter((c) => !completedIds.has(c.id));
    const kept = active.filter((c) => decisions[c.id] === "keep").length;
    const dropped = active.filter((c) => decisions[c.id] === "drop").length;
    const pending = active.length - kept - dropped;
    return { kept: kept + completedIds.size, dropped, pending };
  }, [decisions, companies, completedIds]);

  function decide(id: string, next: "keep" | "drop") {
    setDecisions((prev) => ({ ...prev, [id]: prev[id] === next ? "pending" : next }));
    if (keepErrors[id]) {
      setKeepErrors((prev) => { const n = { ...prev }; delete n[id]; return n; });
    }
  }

  function setDropReason(id: string, reason: string) {
    setDropReasons((prev) => ({ ...prev, [id]: reason }));
  }

  async function handleConfirm() {
    const toSubmit = companies
      .filter((c) => {
        const d = decisions[c.id];
        return d && d !== "pending" && !completedIds.has(c.id);
      })
      .map((c) => ({
        id: c.id,
        action: decisions[c.id] as "keep" | "drop",
        reason: decisions[c.id] === "drop" ? dropReasons[c.id] : undefined,
      }));

    if (toSubmit.length === 0) return;

    setSaving(true);
    try {
      const result = await onConfirm(toSubmit);

      if (result.keepErrors?.length) {
        const failedIds = new Set(result.keepErrors.map((e) => e.id));
        const errorMap: Record<string, string[]> = {};
        for (const e of result.keepErrors) errorMap[e.id] = e.missingFields;

        setKeepErrors(errorMap);
        setDecisions((prev) => {
          const next = { ...prev };
          for (const id of failedIds) next[id] = "pending";
          return next;
        });
        setCompletedIds((prev) => {
          const next = new Set(prev);
          for (const d of toSubmit) {
            if (!failedIds.has(d.id)) next.add(d.id);
          }
          return next;
        });
      } else {
        onClose();
      }
    } finally {
      setSaving(false);
    }
  }

  const pendingDecisionCount = companies.filter(
    (c) => decisions[c.id] && decisions[c.id] !== "pending" && !completedIds.has(c.id),
  ).length;

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
          {Object.keys(keepErrors).length > 0 && (
            <span className="flex items-center gap-1.5 text-amber-600 ml-auto">
              <AlertCircle className="h-4 w-4" />
              {Object.keys(keepErrors).length} need attention
            </span>
          )}
        </div>

        <ScrollArea className="max-h-[420px] pr-3">
          <div className="space-y-2">
            {companies.map((company) => {
              const decision = decisions[company.id] ?? "pending";
              const error = keepErrors[company.id];
              const done = completedIds.has(company.id);
              const displayName = companyDisplayName(company);

              return (
                <div
                  key={company.id}
                  className={`rounded-lg border p-3 transition-colors ${
                    done
                      ? "border-border bg-muted/20 opacity-50"
                      : error
                      ? "border-amber-300 bg-amber-50/60"
                      : decision === "keep"
                      ? "border-green-200 bg-green-50"
                      : decision === "drop"
                      ? "border-red-200 bg-red-50"
                      : "border-border bg-card"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium truncate">{displayName}</span>
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
                      {error && (
                        <div className="mt-1 flex items-center gap-1 text-xs text-amber-700">
                          <AlertCircle className="h-3 w-3 shrink-0" />
                          Missing: {error.join(" · ")}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        className={`h-7 w-7 p-0 ${error ? "text-amber-600 hover:text-amber-700 hover:bg-amber-100" : "text-muted-foreground hover:text-foreground"}`}
                        onClick={() => onEdit(company.id)}
                        disabled={done || saving}
                        title="Edit company"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant={decision === "keep" ? "default" : "outline"}
                        className={`h-7 px-2.5 text-xs ${decision === "keep" ? "bg-green-600 hover:bg-green-700" : ""}`}
                        onClick={() => decide(company.id, "keep")}
                        disabled={done || saving}
                      >
                        <CheckCircle className="h-3.5 w-3.5 mr-1" />
                        Keep
                      </Button>
                      <Button
                        size="sm"
                        variant={decision === "drop" ? "destructive" : "outline"}
                        className="h-7 px-2.5 text-xs"
                        onClick={() => decide(company.id, "drop")}
                        disabled={done || saving}
                      >
                        <XCircle className="h-3.5 w-3.5 mr-1" />
                        Drop
                      </Button>
                    </div>
                  </div>
                  {decision === "drop" && !done && (
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
          <Button onClick={handleConfirm} disabled={pendingDecisionCount === 0 || saving}>
            {saving ? "Applying…" : `Apply ${pendingDecisionCount} decision${pendingDecisionCount !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
