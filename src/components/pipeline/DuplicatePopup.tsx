"use client";

import { useState, useEffect } from "react";
import { AlertTriangle, X, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkspaceLink } from "@/components/WorkspaceLink";
import { companyDisplayName } from "@/lib/companyDisplay";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface DuplicatePopupProps {
  possibleDuplicateId: string;
}

interface DuplicateCompany {
  id: string;
  target: string | null;
  project_name: string | null;
  segment: string | null;
  geography: string | null;
  pipeline_stage: string;
  source: string | null;
}

export function DuplicatePopup({ possibleDuplicateId }: DuplicatePopupProps) {
  const [company, setCompany] = useState<DuplicateCompany | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || !possibleDuplicateId) return;
    fetch(`/api/companies?id=${possibleDuplicateId}&lite=true`)
      .then((r) => r.json())
      .then((data) => setCompany(data.data ?? null))
      .catch(() => setCompany(null));
  }, [open, possibleDuplicateId]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-50"
          title="Possible duplicate — click to view"
        >
          <AlertTriangle className="h-3 w-3" />
          Possible dup
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium text-amber-700">Possible duplicate</span>
          <button onClick={() => setOpen(false)}>
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
        <div className="px-3 py-3 text-sm">
          {!company ? (
            <p className="text-muted-foreground text-xs">Loading…</p>
          ) : (
            <>
              <p className="font-medium">{companyDisplayName(company)}</p>
              <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
                {company.segment && <span>{company.segment}</span>}
                {company.geography && <span>· {company.geography}</span>}
                <span>· {company.pipeline_stage}</span>
                {company.source && (
                  <span className="capitalize">· {company.source}</span>
                )}
              </div>
              <div className="mt-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 text-xs"
                  asChild
                >
                  <WorkspaceLink href="/pipeline?stage=L0" target="_blank" rel="noreferrer">
                    <ExternalLink className="h-3 w-3" />
                    View in pipeline
                  </WorkspaceLink>
                </Button>
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
