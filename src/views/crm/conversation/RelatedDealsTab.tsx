"use client";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ContactDealLink, DealContactRole } from "@/lib/api/contactDeals";
import type { ContactRelatedCompany } from "@/lib/api/contactInsights";
import type { OverviewDealNote } from "@/lib/api/contactConversation";
import { getCompaniesLite } from "@/lib/api/pipeline";
import { companyDisplayName } from "@/lib/companyDisplay";
import { cn } from "@/lib/utils";
import { initialsOf, plural, SYNC_NOTICE } from "../utils";
import { NoData, SectionLabel } from "./SectionLabel";
import { format } from "date-fns";
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

function StageBadge({ label }: { label: string }) {
  return (
    <span className="shrink-0 whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
      {label}
    </span>
  );
}

/** "Indonesia · Fintech · Opened Sep 2026"; parts the deal has no value for are left out. */
function dealMeta(deal: ContactDealLink): string {
  const opened = deal.openedAt ? new Date(deal.openedAt) : null;
  return [
    deal.geography,
    deal.segment,
    opened && !Number.isNaN(opened.getTime()) ? `Opened ${format(opened, "MMM yyyy")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function DealRow({
  deal,
  firstName,
  note,
  busy,
  onRemove,
}: {
  deal: ContactDealLink;
  firstName: string;
  /** The overview's line on the contact's part in this deal, when it has one. */
  note: string | null;
  busy: boolean;
  onRemove: () => void;
}) {
  const role = deal.role === "source" ? `Brought by ${firstName}` : `${firstName} involved`;
  const meta = dealMeta(deal);
  return (
    <li
      className="group grid grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-x-3 gap-y-1 px-3 py-2.5"
      data-testid="contact-insights-deal-row"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span
          className={cn(
            "truncate text-[13px] font-semibold text-foreground",
            deal.isDropped && "text-muted-foreground",
          )}
          title={deal.companyName}
        >
          {deal.companyName || "Unnamed"}
        </span>
        <span className="text-xs text-muted-foreground">
          {meta || `Linked ${format(new Date(deal.linkedAt), "MMM yyyy")}`}
        </span>
      </div>
      <StageBadge label={deal.isDropped ? `Passed at ${deal.stageLabel}` : deal.stageLabel} />
      <Button
        variant="ghost"
        size="sm"
        className="-my-1 h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground"
        disabled={busy}
        onClick={onRemove}
        aria-label={`Remove ${deal.companyName}`}
        title="Remove link"
        data-testid="contact-insights-deal-remove"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
      <p
        className={cn(
          "col-span-3 text-xs leading-relaxed",
          note ? "text-foreground/80" : "text-muted-foreground",
        )}
        data-testid="contact-insights-deal-note"
      >
        {note ?? role}
      </p>
    </li>
  );
}

function DealPicker({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (companyId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<
    Array<{ id: string; target: string | null; project_name: string | null }>
  >([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    getCompaniesLite({ q: debounced || undefined, limit: 30 })
      .then((rows) => {
        if (!cancelled) setResults(rows);
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, debounced]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1"
          disabled={disabled}
          data-testid="contact-insights-link-deal"
        >
          <Plus className="h-3.5 w-3.5" />
          Link deal
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-0"
        align="end"
        onWheel={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search deals…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>{loading ? "Loading…" : "No deals found."}</CommandEmpty>
            <CommandGroup>
              {results.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.id}
                  onSelect={() => {
                    setOpen(false);
                    onPick(c.id);
                  }}
                >
                  <span className="truncate">
                    {companyDisplayName(c, "Unnamed")}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function RelatedDealsTab({
  deals,
  dealNotes,
  relatedCompanies,
  firstName,
  synced,
  busy,
  linkRole,
  onLinkRoleChange,
  onLinkDeal,
  onRemoveDeal,
}: {
  deals: ContactDealLink[];
  /** Per-deal lines from the relationship overview. */
  dealNotes: OverviewDealNote[];
  relatedCompanies: ContactRelatedCompany[];
  firstName: string;
  synced: boolean;
  busy: boolean;
  linkRole: DealContactRole;
  onLinkRoleChange: (role: DealContactRole) => void;
  onLinkDeal: (companyId: string) => void;
  onRemoveDeal: (companyId: string) => void;
}) {
  const noteByCompany = new Map(dealNotes.map((d) => [d.companyId, d.note]));
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2" data-testid="contact-insights-deals">
        <div className="flex items-center justify-between gap-2">
          <SectionLabel>Related deals</SectionLabel>
          <span className="text-xs text-muted-foreground">Matched from pipeline &amp; emails</span>
        </div>

        {deals.length === 0 ? (
          <NoData text="No linked deals yet" />
        ) : (
          <ul className="divide-y overflow-hidden rounded-lg border bg-card">
            {deals.map((d) => (
              <DealRow
                key={d.companyId}
                deal={d}
                firstName={firstName}
                note={noteByCompany.get(d.companyId) ?? null}
                busy={busy}
                onRemove={() => onRemoveDeal(d.companyId)}
              />
            ))}
          </ul>
        )}

        {/* Manual link: overrides an automatic or removed one; feeds the Deal funnel tab. */}
        <div className="flex items-center justify-end gap-1.5">
            <Select
              value={linkRole}
              onValueChange={(v) => onLinkRoleChange(v as DealContactRole)}
            >
              <SelectTrigger
                className="h-8 w-[110px] text-xs"
                aria-label="Link role"
                data-testid="contact-insights-link-role"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="source">Brought</SelectItem>
                <SelectItem value="involved">Involved</SelectItem>
              </SelectContent>
            </Select>
            <DealPicker disabled={busy} onPick={onLinkDeal} />
        </div>

      </section>

      <section className="flex flex-col gap-2" data-testid="contact-insights-related">
        <div className="flex items-center justify-between gap-2">
          <SectionLabel>Related companies</SectionLabel>
          <span className="text-xs text-muted-foreground">Mentioned in emails</span>
        </div>
        {relatedCompanies.length === 0 ? (
          <NoData text={synced ? "None found in this person's emails" : SYNC_NOTICE} />
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {relatedCompanies.map((c) => (
              <li
                key={c.companyId}
                className="flex min-w-0 items-start gap-2.5 rounded-lg border bg-card px-3 py-2.5"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
                  {initialsOf(c.companyName) || "—"}
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span
                    className="truncate text-[13px] font-semibold text-foreground"
                    title={c.companyName}
                  >
                    {c.companyName}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {plural(c.evidenceCount, "email")}
                    {c.lastSeenAt && ` · last ${format(new Date(c.lastSeenAt), "d MMM yyyy")}`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
