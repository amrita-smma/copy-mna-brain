import type {
  CompanyRepository,
  CompanyLogRepository,
  DealNoteRepository,
  UserRepository,
  InvestmentThesisRepository,
  Tables,
} from '@/lib/repositories';
import { enqueueSendEmail } from '@/lib/queue';
import type { SendEmailPayload } from '@/lib/jobs/handlers/sendEmail';

type EnqueueFn = (payload: SendEmailPayload) => Promise<{ messageId: string | null }>;

export interface DealResurfaceResult {
  /** Deals reactivated this sweep. */
  resurfaced: number;
  /** Emails enqueued across all resurfaced deals. */
  notified: number;
  /** Company ids that failed to process (logged, not thrown). */
  failed: string[];
}

function resolveAppUrl(): string {
  return (
    process.env.APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXTAUTH_URL ??
    'http://localhost:3000'
  ).replace(/\/+$/, '');
}

function fmtDate(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

/**
 * Scheduled resurfacing of dropped deals (the "resurface at" option in the
 * drop dialog). Swept by the `/api/cron/resurface-deals` cron: every dropped
 * deal whose `resurface_at` has passed is
 *
 *   1. put back to `active` (drop fields + schedule cleared),
 *   2. annotated with a deal note explaining the automatic resurface and the
 *      original drop reason, and
 *   3. announced by email to the deal's PIC and the user who dropped it
 *      (via the `send-email` queue — delivery stays async and best-effort).
 *
 * Each deal is processed independently: one failure never blocks the rest of
 * the sweep, and email resolution failures never roll back the reactivation.
 */
export class DealResurfaceService {
  constructor(
    private readonly companyRepo: CompanyRepository,
    private readonly companyLogRepo: CompanyLogRepository,
    private readonly dealNoteRepo: DealNoteRepository,
    private readonly userRepo: UserRepository,
    private readonly thesisRepo: InvestmentThesisRepository,
    private readonly enqueue: EnqueueFn = enqueueSendEmail,
    private readonly appUrl: string = resolveAppUrl(),
  ) {}

  async processDue(now: Date = new Date()): Promise<DealResurfaceResult> {
    const due = await this.companyRepo.findDueForResurface(now.toISOString());
    const result: DealResurfaceResult = { resurfaced: 0, notified: 0, failed: [] };

    for (const company of due) {
      try {
        result.notified += await this.resurfaceOne(company);
        result.resurfaced += 1;
      } catch (err) {
        console.error(
          `[DealResurfaceService] failed to resurface company ${company.id}:`,
          err,
        );
        result.failed.push(company.id);
      }
    }
    return result;
  }

  /** Reactivate one deal, append the note, and enqueue notification emails. */
  private async resurfaceOne(company: Tables<'companies'>): Promise<number> {
    const stage = company.pipeline_stage;
    const droppedAtLabel = fmtDate(company.dropped_at);
    const dropReason = company.dropped_reason?.trim() || null;

    await this.companyRepo.update(company.id, {
      status: 'active',
      dropped_reason: null,
      dropped_at: null,
      resurface_at: null,
      dropped_by: null,
    });
    await this.companyLogRepo.insert({
      company_id: company.id,
      action: stage ? `RESURFACED_TO_${stage}` : 'RESURFACED',
    });

    const noteLines = [
      `Deal automatically added back to the active pipeline: it was dropped${
        droppedAtLabel ? ` on ${droppedAtLabel}` : ''
      } with a scheduled resurface date, which has now been reached.`,
      dropReason ? `Original drop reason: ${dropReason}` : null,
    ].filter(Boolean);
    await this.dealNoteRepo.insert({
      deal_id: company.id,
      content: noteLines.join('\n'),
      stage: stage || 'L0',
    });

    // Notifications are best-effort — the resurface above must stand even if
    // recipient resolution or the queue transport fails.
    try {
      return await this.notifyRecipients(company, {
        stage,
        droppedAtLabel,
        dropReason,
      });
    } catch (err) {
      console.error(
        `[DealResurfaceService] resurfaced company ${company.id} but failed to enqueue emails:`,
        err,
      );
      return 0;
    }
  }

  private async notifyRecipients(
    company: Tables<'companies'>,
    ctx: {
      stage: string | null;
      droppedAtLabel: string | undefined;
      dropReason: string | null;
    },
  ): Promise<number> {
    const recipients = new Map<string, string>(); // lowercased email → email

    // The user who dropped the deal and the per-deal PIC override (captain,
    // then sponsor) are user ids — resolve them in one batch lookup.
    const picUserId = company.deal_captain || company.deal_sponsor;
    const userIds = [
      ...new Set([company.dropped_by, picUserId].filter((id): id is string => !!id)),
    ];
    if (userIds.length > 0) {
      const users = await this.userRepo.findByIds(userIds);
      for (const user of users) {
        if (user.email) recipients.set(user.email.toLowerCase(), user.email);
      }
    }

    // No per-deal PIC → fall back to the matched Track's PIC, a free-text
    // name resolved to a platform user by name. Unresolvable names are skipped.
    if (!picUserId) {
      const picName = await this.trackPicName(company.matched_track_ids ?? []);
      if (picName) {
        const picUsers = await this.userRepo.findByNames([picName]);
        for (const user of picUsers) {
          if (user.email) recipients.set(user.email.toLowerCase(), user.email);
        }
      }
    }

    const companyName =
      company.target?.trim() || company.project_name?.trim() || 'Unnamed company';
    let notified = 0;
    for (const email of recipients.values()) {
      await this.enqueue({
        kind: 'deal_resurfaced',
        to: email,
        companyName,
        stage: ctx.stage ?? undefined,
        droppedAtLabel: ctx.droppedAtLabel,
        dropReason: ctx.dropReason ?? undefined,
        companyUrl: `${this.appUrl}/pipeline`,
      });
      notified += 1;
    }
    return notified;
  }

  private async trackPicName(trackIds: string[]): Promise<string | null> {
    if (trackIds.length === 0) return null;
    const tracks = await this.thesisRepo.findByIds(trackIds);
    // Preserve the company's matched-track order — the first match is the
    // primary Track.
    for (const id of trackIds) {
      const pic = tracks.find((t) => t.id === id)?.pic?.trim();
      if (pic) return pic;
    }
    return null;
  }
}
