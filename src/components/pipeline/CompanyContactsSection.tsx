"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  ExternalLink,
  Linkedin,
  Loader2,
  Mail,
  Phone,
  Search,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { WorkspaceLink } from "@/components/WorkspaceLink";
import {
  findCompanyContacts,
  getCompanyContacts,
  type CompanyContact,
  type CompanyContactsState,
} from "@/lib/api/companyContacts";
import { useLiveRefetchInterval, useLiveTopic } from "@/components/live/LiveEventsProvider";
import { LIVE_TOPICS } from "@/lib/live/topics";

/**
 * How often to re-read the card while a run is in flight and the live stream
 * is down; while it is up the `workforce` and `contacts` topics drive it.
 */
const POLL_MS = 4_000;
/**
 * Stop polling after this long. The run keeps going on the AI Workforce queue
 * (whose reaper fails a stuck row at 30 minutes); a dialog left open is not
 * worth polling for that long, and the toast points at where to watch it.
 */
const POLL_TIMEOUT_MS = 5 * 60_000;

/**
 * Deep-link into the CRM with this firm opened, as the dashboard's banker card
 * does: `firm` seeds the search so the row is on the page, `employerId` tells
 * `CRM.tsx` which card to expand.
 */
export function crmHref(employer: { id: string; name: string }): string {
  const params = new URLSearchParams({ employerId: employer.id, firm: employer.name });
  return `/crm?${params.toString()}`;
}

function ContactRow({ contact }: { contact: CompanyContact }) {
  return (
    <li className="flex gap-3 py-3 border-b last:border-0" data-testid="company-contact-row">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-semibold">{contact.name}</span>
          {contact.title && (
            <span className="text-sm text-muted-foreground">{contact.title}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {contact.email && (
            <a href={`mailto:${contact.email}`} className="inline-flex items-center gap-1 text-accent hover:underline">
              <Mail className="h-3 w-3" />
              {contact.email}
            </a>
          )}
          {contact.phone && (
            <a href={`tel:${contact.phone.replace(/\s+/g, "")}`} className="inline-flex items-center gap-1 text-accent hover:underline">
              <Phone className="h-3 w-3" />
              {contact.phone}
            </a>
          )}
          {contact.linkedin_url && (
            <a
              href={contact.linkedin_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-accent hover:underline"
            >
              <Linkedin className="h-3 w-3" />
              LinkedIn
            </a>
          )}
          {!contact.email && !contact.phone && !contact.linkedin_url && (
            <span className="text-muted-foreground">No contact details on file</span>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * "Contact Details" on the company dialog's Details tab: the company's
 * partnership contacts (CEO, head of BD, BD manager) as the CRM holds them —
 * whoever the mailbox ingest, an import or a colleague filed under the
 * company's CRM firm, plus the people an @crm_contact run finds on demand.
 *
 * The run lives on the AI Workforce queue, so nothing here owns it: the card
 * polls its own GET while the run is active, and a run started before the
 * dialog was reopened is picked up from that same GET.
 */
export function CompanyContactsSection({
  companyId,
  companyName,
}: {
  companyId: string;
  companyName: string;
}) {
  const [state, setState] = useState<CompanyContactsState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [starting, setStarting] = useState(false);
  const [pollExpired, setPollExpired] = useState(false);
  const mountedRef = useRef(true);
  /** Was the last-seen run active? Its fall to inactive is what fires the toast. */
  const wasActiveRef = useRef(false);
  const pollStartedAtRef = useRef<number | null>(null);
  /**
   * The run this user started from this card, and how many CRM contacts the
   * firm had when they did. Only that run toasts — a colleague's run that
   * finishes while the card is open updates the list silently.
   */
  const startedRef = useRef<{ runId: string; totalBefore: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getCompanyContacts(companyId);
      if (!mountedRef.current) return;
      setLoadError(false);
      setState(next);
    } catch {
      if (mountedRef.current) setLoadError(true);
    }
  }, [companyId]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const run = state?.run ?? null;
  const running = Boolean(run?.active) && !pollExpired;
  const pollMs = useLiveRefetchInterval(POLL_MS);
  const runActiveRef = useRef(false);
  runActiveRef.current = Boolean(run?.active) && !pollExpired;
  const onLiveEvent = (ids: string[] | undefined) => {
    if (!runActiveRef.current) return;
    if (ids && !ids.includes(companyId) && !(run?.runId && ids.includes(run.runId))) return;
    void load();
  };
  useLiveTopic(LIVE_TOPICS.workforce, onLiveEvent);
  useLiveTopic(LIVE_TOPICS.contacts, onLiveEvent);
  /** Still running server-side, but this card stopped watching it. */
  const unwatched = Boolean(run?.active) && pollExpired;

  // Poll while the run is active; toast once when it settles.
  useEffect(() => {
    if (!run) return;
    if (run.active) {
      if (!wasActiveRef.current) pollStartedAtRef.current = Date.now();
      wasActiveRef.current = true;
      if (pollExpired) return;
      if (Date.now() - (pollStartedAtRef.current ?? Date.now()) > POLL_TIMEOUT_MS) {
        setPollExpired(true);
        toast.info(`Still looking for ${companyName}'s contacts — follow it on the AI Workforce page`);
        return;
      }
      const timer = setTimeout(() => void load(), pollMs);
      return () => clearTimeout(timer);
    }
    if (wasActiveRef.current) {
      wasActiveRef.current = false;
      const started = startedRef.current;
      if (started?.runId !== run.runId) return;
      startedRef.current = null;
      const added = (state?.totalContacts ?? 0) - started.totalBefore;
      if (run.status !== "succeeded") {
        toast.error(run.error || `Could not find contacts for ${companyName} — see the AI Workforce page`);
      } else if (added > 0) {
        toast.success(`Added ${added} contact${added === 1 ? "" : "s"} to the CRM for ${companyName}`);
      } else {
        // Nobody new: either nothing evidenced, or everyone was already in
        // the CRM (and at most had empty fields filled).
        toast.info(`Contact search finished for ${companyName} — no new contacts added`);
      }
    }
  }, [run, state, companyName, load, pollExpired, pollMs]);

  const start = async () => {
    setStarting(true);
    try {
      const started = await findCompanyContacts(companyId);
      if (!mountedRef.current) return;
      toast.info(
        started.created
          ? `Looking for ${companyName}'s partnership contacts…`
          : `Already looking for ${companyName}'s contacts…`,
      );
      const { created: _created, ...startedRun } = started;
      startedRef.current = { runId: startedRun.runId, totalBefore: state?.totalContacts ?? 0 };
      setPollExpired(false);
      setLoadError(false);
      setState((prev) => ({
        employer: prev?.employer ?? null,
        contacts: prev?.contacts ?? [],
        totalContacts: prev?.totalContacts ?? 0,
        run: startedRun,
      }));
    } catch (err) {
      toast.error((err as Error).message || "Could not start the lookup");
    } finally {
      if (mountedRef.current) setStarting(false);
    }
  };

  const contacts = state?.contacts ?? [];
  const employer = state?.employer ?? null;
  const more = (state?.totalContacts ?? 0) - contacts.length;
  const busy = starting || running;

  return (
    <div className="rounded-lg border bg-card px-4 py-3" data-testid="company-contacts-section">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="space-y-0.5 min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" />
            Contact Details
          </p>
          <p className="text-xs text-muted-foreground">
            {employer
              ? `Partnership contacts from the CRM firm ${employer.name} — CEO and business development leads first.`
              : "Partnership contacts — CEO and business development leads. Found contacts are saved to the CRM."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {employer && (
            <Button variant="ghost" size="sm" className="h-7 gap-1.5" asChild>
              <WorkspaceLink href={crmHref(employer)} data-testid="company-contacts-open-crm">
                <ExternalLink className="h-3.5 w-3.5" />
                Open in CRM
              </WorkspaceLink>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5"
            onClick={() => void start()}
            disabled={busy || unwatched || (!state && !loadError)}
            data-testid="company-contacts-find"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            {busy || unwatched ? "Searching…" : contacts.length > 0 ? "Find more" : "Find contacts"}
          </Button>
        </div>
      </div>

      {!state && !loadError ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading contacts…
        </div>
      ) : loadError && !state ? (
        <p className="py-3 text-sm text-destructive">
          Could not load contacts.{" "}
          <button type="button" className="underline" onClick={() => void load()}>
            Retry
          </button>
        </p>
      ) : contacts.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">
          {running
            ? "Researching the company's leadership and business development team. This usually takes a few minutes."
            : unwatched
              ? "Still searching — follow the run on the AI Workforce page."
              : employer
                ? "The CRM has no contacts for this firm yet. Use Find contacts to look up the CEO and business development leads."
                : "This company is not in the CRM yet. Find contacts looks up the CEO and business development leads and adds them to the CRM."}
        </p>
      ) : (
        <ul>
          {contacts.map((c) => (
            <ContactRow key={c.id} contact={c} />
          ))}
        </ul>
      )}

      {employer && more > 0 && (
        <WorkspaceLink
          href={crmHref(employer)}
          className="mt-1 inline-block text-xs text-accent hover:underline"
        >
          +{more} more in the CRM
        </WorkspaceLink>
      )}
      {run && !run.active && run.status !== "succeeded" && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5" />
          Last search failed{run.error ? `: ${run.error}` : ""}
        </p>
      )}
      {run && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {run.active ? "Search started" : "Last searched"}{" "}
          {formatDistanceToNow(new Date(run.startedAt), { addSuffix: true })}
        </p>
      )}
    </div>
  );
}
