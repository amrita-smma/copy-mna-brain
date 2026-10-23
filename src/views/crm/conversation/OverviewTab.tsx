"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  ContactConversation,
  ConversationNote,
  RoleLabel,
} from "@/lib/api/contactConversation";
import type {
  ContactInsights,
  ContactTeamInteraction,
} from "@/lib/api/contactInsights";
import { cn } from "@/lib/utils";
import { format, formatDistanceToNow } from "date-fns";
import { useState } from "react";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  Briefcase,
  Building2,
  Calculator,
  Coins,
  FileText,
  Loader2,
  Scale,
  SearchCheck,
  Tag,
  UserRound,
} from "lucide-react";
import { isStaleContact, plural, SYNC_NOTICE } from "../utils";
import { NoData, SectionLabel } from "./SectionLabel";

const ROLE_ICONS: Record<RoleLabel, typeof Coins> = {
  funding: Coins,
  lending: Building2,
  finance: Calculator,
  tax: FileText,
  advisory: Briefcase,
  legal: Scale,
  due_diligence: SearchCheck,
  principal: UserRound,
  other: Tag,
};

const ROLE_TEXT: Record<RoleLabel, string> = {
  funding: "Funding",
  lending: "Lending",
  finance: "Finance",
  tax: "Tax",
  advisory: "Advisory",
  legal: "Legal",
  due_diligence: "Due diligence",
  principal: "Principal",
  other: "Other",
};

const TILE = "rounded-lg border bg-muted px-2.5 py-2 text-left";

function StatTile({
  label,
  testId,
  children,
}: {
  label: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={TILE} data-testid={testId}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold text-foreground">{children}</div>
    </div>
  );
}

/** One teammate's email traffic with this contact (MB-829 "who on our team emails them"). */
function TeamRow({ member }: { member: ContactTeamInteraction }) {
  const emails = member.emailsFromUs + member.emailsFromThem;
  const last = member.lastEmailAt;
  const parts = [
    `${plural(emails, "email")} (${member.emailsFromUs} from us / ${member.emailsFromThem} from them)`,
  ];
  if (last) parts.push(`last ${format(new Date(last), "d MMM")}`);
  return (
    <li className="py-1.5 text-sm" data-testid="contact-insights-team-row">
      <span className="font-semibold">
        {member.name ?? member.email ?? "Unknown"}
      </span>
      <span className="text-muted-foreground"> · {parts.join(" · ")}</span>
    </li>
  );
}

function NoteCard({ note }: { note: ConversationNote }) {
  const isInbound = note.direction === "inbound";
  const memberNames = note.teamMembers.map((m) => m.name).filter(Boolean).join(", ");

  return (
    <li
      className="flex flex-col gap-2 rounded-lg border bg-card p-3.5 text-sm"
      data-testid="contact-conversation-note-item"
    >
      {/* Header: Date, Members, Direction, Sentiment */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span title={note.direction === "inbound" ? "Inbound" : "Outbound"}>
            {isInbound ? (
              <ArrowDownLeft className="h-3.5 w-3.5 text-primary" />
            ) : (
              <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </span>
          <span className="font-medium text-foreground">
            {format(new Date(note.sentAt), "d MMM yyyy")}
          </span>
          {memberNames && <span>· with {memberNames}</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <Badge
            variant={
              note.sentiment === "positive"
                ? "default"
                : note.sentiment === "negative"
                  ? "destructive"
                  : "secondary"
            }
            className="text-xs font-normal capitalize"
            data-testid="contact-conversation-note-sentiment"
          >
            {note.sentiment}
          </Badge>
        </div>
      </div>

      {/* Summary */}
      <p className="text-sm leading-relaxed text-foreground">{note.summary}</p>

      {/* Key points */}
      {note.keyPoints.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
          {note.keyPoints.map((pt, i) => (
            <li key={i}>{pt}</li>
          ))}
        </ul>
      )}

      {/* Next step */}
      {note.nextStep && (
        <div
          className="mt-1 flex items-center gap-1.5 text-xs"
          data-testid="contact-conversation-note-next-step"
        >
          <span className="text-muted-foreground">Next:</span>
          <Badge
            variant={
              note.nextStepStatus === "action"
                ? "default"
                : note.nextStepStatus === "done"
                  ? "secondary"
                  : "outline"
            }
            className="text-xs font-normal"
          >
            {note.nextStep}
          </Badge>
        </div>
      )}
    </li>
  );
}


export function OverviewTab({
  conversation,
  insights,
  summarising,
  notes,
  notesOpen,
  onToggleNotes,
  loadingNotes,
  hasMoreNotes,
  onLoadMoreNotes,
}: {
  conversation: ContactConversation | null;
  insights: ContactInsights | null;
  summarising: boolean;
  /** Notes paged in after "Show conversation notes"; null until first opened. */
  notes: ConversationNote[] | null;
  notesOpen: boolean;
  onToggleNotes: () => void;
  loadingNotes: boolean;
  hasMoreNotes: boolean;
  onLoadMoreNotes: () => void;
}) {
  const [teamOpen, setTeamOpen] = useState(false);
  const ix = insights?.interactions ?? null;
  const synced = Boolean(ix?.hasSyncedData || conversation?.hasSyncedData);
  const lastContactAt = ix?.lastContactAt ?? null;
  const stale = isStaleContact(lastContactAt);
  const totalEmails = ix ? ix.totalEmailsFromUs + ix.totalEmailsFromThem : null;
  const teamCount = ix?.team.length ?? 0;

  const roles = conversation?.roles;
  const overview = conversation?.overview;
  // The shared summary across every email; until it is generated, the newest
  // evidence sentence from an email this viewer was on.
  const roleLine = overview?.roleSummary ?? roles?.evidence ?? null;
  // The panel probes one note: enough to know whether there is a list to open.
  const hasNotes = (conversation?.notes.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-4">
      <section
        className="flex flex-col gap-2 border-b pb-4"
        data-testid="contact-conversation-roles"
      >
        <div className="flex items-center justify-between gap-2">
          <SectionLabel>Role in investment</SectionLabel>
          <span className="text-xs text-muted-foreground">AI-inferred from email</span>
        </div>

        {roles && roles.roles.length > 0 ? (
          <>
            <div className="flex flex-wrap gap-2">
              {roles.roles.map((r) => {
                const Icon = ROLE_ICONS[r.label];
                return (
                  <span
                    key={r.label}
                    title={`${r.confidence} confidence`}
                    className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-card px-2.5 text-xs font-semibold text-foreground"
                    data-testid="contact-conversation-role-chip"
                  >
                    {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
                    {ROLE_TEXT[r.label] ?? r.label}
                  </span>
                );
              })}
            </div>
            {roleLine && (
              <p
                className="text-xs leading-relaxed text-muted-foreground"
                data-testid="contact-conversation-role-summary"
              >
                Inferred from {plural(roles.emailCount, "email")} — {roleLine}
              </p>
            )}
          </>
        ) : (
          <NoData text={synced ? "No role signals yet" : SYNC_NOTICE} />
        )}
      </section>

      <section className="flex flex-col gap-2" data-testid="contact-conversation-overview">
        <div className="flex items-center justify-between gap-2">
          <SectionLabel>Relationship overview</SectionLabel>
          {summarising && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Summarising…
            </span>
          )}
        </div>

        {overview?.text ? (
          <p className="text-[13px] leading-relaxed text-foreground">{overview.text}</p>
        ) : summarising ? null : (
          <NoData text={synced ? "No summary yet" : SYNC_NOTICE} />
        )}

        <div
          className="mt-1 grid grid-cols-3 gap-2"
          data-testid="contact-conversation-overview-stats"
        >
          <StatTile label="Interactions">
            {totalEmails !== null && totalEmails > 0 ? totalEmails : "—"}
          </StatTile>
          <StatTile label="Last touch" testId="contact-insights-last-contact">
            {lastContactAt ? (
              <span className={cn("flex items-center gap-1", stale && "text-destructive")}>
                {stale && <AlertTriangle className="h-3.5 w-3.5" />}
                {formatDistanceToNow(new Date(lastContactAt), { addSuffix: true })}
              </span>
            ) : (
              "—"
            )}
          </StatTile>
          {teamCount > 0 && ix ? (
            <button
              type="button"
              onClick={() => setTeamOpen((v) => !v)}
              aria-expanded={teamOpen}
              className={cn(TILE, "transition-colors hover:border-primary/40")}
              data-testid="contact-insights-team-toggle"
              title="Who on our team emails them, and how often"
            >
              <div className="flex items-center justify-between gap-1 text-xs text-muted-foreground">
                Team members
                <ChevronDown
                  className={cn("h-3.5 w-3.5 transition-transform", teamOpen && "rotate-180")}
                />
              </div>
              <div className="text-sm font-semibold text-foreground">{teamCount}</div>
            </button>
          ) : (
            <StatTile label="Team members">—</StatTile>
          )}
        </div>

        {teamOpen && ix && ix.team.length > 0 && (
          <ul
            className="divide-y rounded-lg border bg-card px-3"
            data-testid="contact-insights-team"
          >
            {ix.team.map((m) => (
              <TeamRow key={m.userId} member={m} />
            ))}
          </ul>
        )}
      </section>

      {hasNotes && (
        <section className="flex flex-col gap-3" data-testid="contact-conversation-notes">
          <button
            type="button"
            onClick={onToggleNotes}
            aria-expanded={notesOpen}
            className="flex items-center gap-1 self-start text-xs font-semibold text-primary hover:underline"
            data-testid="contact-conversation-notes-toggle"
          >
            {notesOpen ? "Hide conversation notes" : "Show conversation notes"}
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform", notesOpen && "rotate-180")}
            />
          </button>

          {notesOpen &&
            (notes === null ? (
              <div className="flex justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                <ul className="flex flex-col gap-2">
                  {notes.map((n) => (
                    <NoteCard key={n.emailId} note={n} />
                  ))}
                </ul>
                {hasMoreNotes && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onLoadMoreNotes}
                    disabled={loadingNotes}
                    className="w-full text-xs font-medium"
                    data-testid="contact-conversation-load-more"
                  >
                    {loadingNotes ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Load more"}
                  </Button>
                )}
              </>
            ))}
        </section>
      )}
    </div>
  );
}
