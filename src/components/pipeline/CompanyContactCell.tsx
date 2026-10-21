"use client";

import { useState } from "react";
import { AlertCircle, ChevronDown, ChevronUp, Linkedin, Loader2, Mail, Phone, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkspaceLink } from "@/components/WorkspaceLink";
import type { CompanyContact, CompanyContactsState } from "@/lib/api/companyContacts";
import { crmHref } from "./CompanyContactsSection";

function ContactLine({ contact, primary = false }: { contact: CompanyContact; primary?: boolean }) {
  return (
    <div className="min-w-0 space-y-0.5" data-testid={primary ? "contact-cell-primary" : "contact-cell-extra"}>
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className={primary ? "truncate text-sm font-medium" : "truncate text-xs font-medium"}>
          {contact.name}
        </span>
      </div>
      {contact.title && (
        <div className="truncate text-xs text-muted-foreground" title={contact.title}>
          {contact.title}
        </div>
      )}
      <div className="flex items-center gap-2 text-muted-foreground">
        {contact.email && (
          <a
            href={`mailto:${contact.email}`}
            title={contact.email}
            aria-label={`Email ${contact.name}`}
            className="hover:text-accent"
          >
            <Mail className="h-3.5 w-3.5" />
          </a>
        )}
        {contact.phone && (
          <a
            href={`tel:${contact.phone.replace(/\s+/g, "")}`}
            title={contact.phone}
            aria-label={`Call ${contact.name}`}
            className="hover:text-accent"
          >
            <Phone className="h-3.5 w-3.5" />
          </a>
        )}
        {contact.linkedin_url && (
          <a
            href={contact.linkedin_url}
            target="_blank"
            rel="noopener noreferrer"
            title="LinkedIn"
            aria-label={`${contact.name} on LinkedIn`}
            className="hover:text-accent"
          >
            <Linkedin className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * The AI-Discovered table's Contact cell: the company's main partnership
 * contact (CEO / BD lead, ranked by the contact search), with "See more" to
 * expand the rest inline. Without contacts it shows the contact search's
 * state, and a button to start one.
 */
export function CompanyContactCell({
  state,
  starting,
  onFind,
}: {
  /** `undefined` while the page's contacts are loading. */
  state: CompanyContactsState | undefined;
  starting: boolean;
  onFind: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!state) {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
  }

  const { contacts, employer, run, totalContacts } = state;
  const searching = starting || Boolean(run?.active);

  if (contacts.length === 0) {
    if (searching) {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="contact-cell-searching">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Finding contacts…
        </span>
      );
    }
    const failed = run && run.status !== "succeeded";
    return (
      <div className="space-y-1">
        {failed ? (
          <span className="flex items-center gap-1 text-xs text-destructive" title={run.error ?? undefined}>
            <AlertCircle className="h-3.5 w-3.5" />
            Search failed
          </span>
        ) : run ? (
          <span className="block text-xs text-muted-foreground">No contacts found</span>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={onFind}
          data-testid="contact-cell-find"
        >
          <Search className="h-3.5 w-3.5" />
          {run ? "Search again" : "Find contacts"}
        </Button>
      </div>
    );
  }

  const [main, ...rest] = contacts;
  const beyondShown = totalContacts - contacts.length;

  return (
    <div className="max-w-[260px] space-y-1.5" data-testid="contact-cell">
      <ContactLine contact={main} primary />
      {expanded && rest.length > 0 && (
        <div className="space-y-2 border-l pl-2.5">
          {rest.map((c) => (
            <ContactLine key={c.id} contact={c} />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
        {rest.length > 0 && (
          <button
            type="button"
            className="inline-flex items-center gap-0.5 text-accent hover:underline"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            data-testid="contact-cell-see-more"
          >
            {expanded ? (
              <>
                Show less <ChevronUp className="h-3 w-3" />
              </>
            ) : (
              <>
                See more ({rest.length}) <ChevronDown className="h-3 w-3" />
              </>
            )}
          </button>
        )}
        {employer && beyondShown > 0 && (expanded || rest.length === 0) && (
          <WorkspaceLink href={crmHref(employer)} className="text-accent hover:underline">
            +{beyondShown} more in the CRM
          </WorkspaceLink>
        )}
        {searching && (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Searching…
          </span>
        )}
      </div>
    </div>
  );
}
