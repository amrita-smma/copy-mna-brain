import type {
  ContactInteractionRepository,
  CrmSuggestedQuestionRepository,
  DealContactRepository,
  DealContactRow,
  UpsertCrmSuggestedQuestionInput,
  UserContactActivityRow,
  UserWorkspaceRepository,
} from '@/lib/repositories';
import { decodeHtmlEntities } from '@/lib/crm/displayText';
import type { DealContactService } from './dealContactService';

/** The calendar the "Ask Brain" day is keyed on (the cron fires 05:00 WIB). */
const ASK_BRAIN_TIMEZONE = 'Asia/Jakarta';
/** "What's the latest with …" looks at this many days. */
const RECENT_WINDOW_DAYS = 14;
/** "Should I follow up with …" needs the last contact to be older than this. */
const FOLLOW_UP_AFTER_DAYS = 30;
/** Most personalized questions kept per day. */
const MAX_PERSONALIZED = 4;
/** Target question length; names are clipped to fit. */
export const QUESTION_MAX_CHARS = 70;

const DAY_MS = 24 * 60 * 60 * 1000;

const SUGGESTED_QUESTION_KINDS = [
  'latest_with',
  'follow_up',
  'deal_progress',
  'l1_leads',
  'sync_summary',
  'follow_up_week',
  'most_active',
  'firm_coverage',
  'top_firms_month',
] as const;

export type SuggestedQuestionKind = (typeof SUGGESTED_QUESTION_KINDS)[number];

export interface SuggestedQuestion {
  kind: SuggestedQuestionKind;
  text: string;
}

/** One user's questions for one day, as stored in `crm_suggested_questions.questions`. */
export interface SuggestedQuestionSet {
  /** Filled from the user's own interactions, best first; empty without data or sync. */
  personalized: SuggestedQuestion[];
  /** Always the same three ({@link genericQuestions}); only the first follows sync. */
  generic: SuggestedQuestion[];
  /** The user's own mailbox sync (`user_workspaces.is_email_synced`). */
  hasSync: boolean;
}

export interface SuggestedQuestionsResult extends SuggestedQuestionSet {
  /** True when today's generation failed and an earlier day's row is shown. */
  stale: boolean;
}

export interface WorkspaceGenerationResult {
  forDate: string;
  members: number;
  /** Members with personalized questions, i.e. rows written. */
  generated: number;
}

export interface DailyRunResult extends WorkspaceGenerationResult {
  /** Smart Files deal links the reconcile wrote. */
  reconciled: number;
  /** Deal links from email mentions written. */
  emailLinked: number;
  /**
   * The Smart Files reconcile or the email-mention linking failed (logged);
   * the questions were still generated.
   */
  reconcileFailed: boolean;
}

/** `YYYY-MM-DD` of `now` in {@link ASK_BRAIN_TIMEZONE}. */
export function askBrainDate(now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ASK_BRAIN_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Shorten `value` to at most `max` characters, at a word boundary when one is
 * close enough, with a trailing ellipsis.
 */
export function clipWords(value: string, max: number): string {
  const v = value.trim();
  if (v.length <= max) return v;
  if (max <= 1) return '…';
  const cut = v.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const base = space >= Math.floor(max / 3) ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s,.;:&(–-]+$/, '')}…`;
}

type Field = readonly [key: string, value: string, min: number];

/**
 * Render a template, clipping its fields in the given order (each down to its
 * `min`) until the text fits {@link QUESTION_MAX_CHARS}. Stays over the limit
 * only when every field is already at its minimum.
 */
function fit(render: (v: Record<string, string>) => string, fields: Field[]): string {
  const vals: Record<string, string> = {};
  for (const [key, value] of fields) vals[key] = value.trim();
  let text = render(vals);
  for (const [key, , min] of fields) {
    if (text.length <= QUESTION_MAX_CHARS) break;
    const over = text.length - QUESTION_MAX_CHARS;
    vals[key] = clipWords(vals[key]!, Math.max(min, vals[key]!.length - over));
    text = render(vals);
  }
  return text;
}

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function lastContactMs(r: UserContactActivityRow): number | null {
  return ms(r.lastEmailAt);
}

function allTime(r: UserContactActivityRow): number {
  return r.emailsFromUs + r.emailsFromThem;
}

function recent(r: UserContactActivityRow): number {
  return r.recentEmails;
}

/** Deterministic tie-break: later last contact first, then name, then id. */
function byRecencyThenName(a: UserContactActivityRow, b: UserContactActivityRow): number {
  return (
    (lastContactMs(b) ?? 0) - (lastContactMs(a) ?? 0) ||
    a.contactName.localeCompare(b.contactName) ||
    a.correspondentId.localeCompare(b.correspondentId)
  );
}

function latestWith(r: UserContactActivityRow): string {
  const name = r.contactName;
  const firm = r.firmName?.trim();
  if (firm) {
    // The firm is kept whole or dropped: a clipped firm name reads as noise.
    const withFirm = fit((v) => `What's the latest with ${v.name} (${firm})?`, [
      ['name', name, 14],
    ]);
    if (withFirm.length <= QUESTION_MAX_CHARS) return withFirm;
  }
  return fit((v) => `What's the latest with ${v.name}?`, [['name', name, 14]]);
}

/** Input for {@link buildSuggestedQuestions}: ONE user's own data. */
export interface SuggestedQuestionInput {
  /** The user's own (user, contact) activity rows. */
  activity: UserContactActivityRow[];
  /** Deal links of (at least) the contacts in `activity`; others are ignored. */
  links: DealContactRow[];
  hasSync: boolean;
  workspaceHasDealLinks: boolean;
  now: Date;
}

/**
 * Fill the question templates from one user's own interactions. Pure and
 * deterministic: same input, same questions in the same order.
 */
export function buildSuggestedQuestions(input: SuggestedQuestionInput): SuggestedQuestionSet {
  const { hasSync, workspaceHasDealLinks, now } = input;
  const nowMs = now.getTime();
  // Stored CRM text can carry ingest's HTML entities (`&amp;`); decode before
  // grouping and clipping, which both depend on the real characters.
  const activity = input.activity.map((r) => ({
    ...r,
    contactName: decodeHtmlEntities(r.contactName),
    firmName: decodeHtmlEntities(r.firmName),
  }));
  const personalized: SuggestedQuestion[] = [];

  // 1. The banker I interacted with most in the last two weeks.
  const recentTop = activity
    .filter((r) => recent(r) > 0)
    .sort((a, b) => recent(b) - recent(a) || byRecencyThenName(a, b))[0];
  if (recentTop) personalized.push({ kind: 'latest_with', text: latestWith(recentTop) });

  // 2. My top banker by all-time interactions whom I haven't contacted in a month.
  const overdue = activity
    .filter((r) => {
      const last = lastContactMs(r);
      return last !== null && nowMs - last > FOLLOW_UP_AFTER_DAYS * DAY_MS;
    })
    .sort((a, b) => allTime(b) - allTime(a) || byRecencyThenName(a, b))[0];
  if (overdue) {
    const days = Math.floor((nowMs - (lastContactMs(overdue) ?? nowMs)) / DAY_MS);
    personalized.push({
      kind: 'follow_up',
      text: fit((v) => `Should I follow up with ${v.name}? Last contact ${days} days ago.`, [
        ['name', overdue.contactName, 12],
      ]),
    });
  }

  // 3. The most recent live deal brought by a banker I interact with.
  const mine = new Map(activity.map((r) => [r.correspondentId, r]));
  const deal = input.links
    .filter(
      (l) =>
        l.status === 'active' &&
        l.role === 'source' &&
        l.companyStatus === 'active' &&
        mine.has(l.correspondentId),
    )
    .sort(
      (a, b) =>
        (ms(b.companyCreatedAt) ?? 0) - (ms(a.companyCreatedAt) ?? 0) ||
        (ms(b.createdAt) ?? 0) - (ms(a.createdAt) ?? 0) ||
        a.companyId.localeCompare(b.companyId) ||
        a.correspondentId.localeCompare(b.correspondentId),
    )[0];
  const dealName = deal ? decodeHtmlEntities(deal.companyName).trim() : '';
  if (deal && dealName) {
    personalized.push({
      kind: 'deal_progress',
      text: fit((v) => `How is ${v.deal} from ${v.name} progressing?`, [
        ['deal', dealName, 12],
        ['name', mine.get(deal.correspondentId)!.contactName, 12],
      ]),
    });
  }

  // 4. Only meaningful once the workspace links bankers to deals, and only
  // personal for someone who works with bankers at all.
  if (workspaceHasDealLinks && activity.length > 0) {
    personalized.push({ kind: 'l1_leads', text: 'Which bankers give leads that reach L1?' });
  }

  // 5. The firm I interact with most: after the L1 question, so it only fills a free slot.
  const byFirm = new Map<string, number>();
  for (const r of activity) {
    const firm = r.firmName?.trim();
    if (firm) byFirm.set(firm, (byFirm.get(firm) ?? 0) + allTime(r));
  }
  const topFirm = [...byFirm.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  if (topFirm) {
    personalized.push({
      kind: 'firm_coverage',
      text: fit((v) => `Who on our team covers ${v.firm}?`, [['firm', topFirm, 12]]),
    });
  }

  // Personalized questions are for users whose own mailbox is synced; without
  // sync the row offers generic questions plus the "connect email" prompt.
  return {
    personalized: hasSync ? personalized.slice(0, MAX_PERSONALIZED) : [],
    generic: genericQuestions(hasSync),
    hasSync,
  };
}

/**
 * The three generic questions. Fixed text, never filled from data; only the
 * first follows the user's own sync.
 */
export function genericQuestions(hasSync: boolean): SuggestedQuestion[] {
  return [
    hasSync
      ? { kind: 'sync_summary', text: "Summarize this week's contact sync" }
      : { kind: 'follow_up_week', text: 'Who should I follow up with this week?' },
    { kind: 'most_active', text: 'Which bankers are most active with us?' },
    { kind: 'top_firms_month', text: 'Which firms did we email most this month?' },
  ];
}

const KINDS: ReadonlySet<string> = new Set(SUGGESTED_QUESTION_KINDS);

function parseQuestions(value: unknown): SuggestedQuestion[] | null {
  if (!Array.isArray(value)) return null;
  const out: SuggestedQuestion[] = [];
  for (const q of value) {
    const kind = (q as { kind?: unknown } | null)?.kind;
    const text = (q as { text?: unknown } | null)?.text;
    if (typeof kind === 'string' && KINDS.has(kind) && typeof text === 'string' && text) {
      out.push({ kind: kind as SuggestedQuestionKind, text });
    }
  }
  return out;
}

/**
 * A stored `questions` value, or null when it has no personalized list. The
 * generic three are rebuilt from the stored sync flag, never read.
 */
export function parseStoredQuestionSet(value: unknown): SuggestedQuestionSet | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const personalized = parseQuestions(v.personalized);
  if (!personalized) return null;
  const hasSync = v.hasSync === true;
  return { personalized, generic: genericQuestions(hasSync), hasSync };
}

/**
 * "Ask Brain" suggested questions (MB-862). Deterministic templates filled
 * with the asking user's OWN data — their interactions in this workspace,
 * the deal links of bankers they interact with, their own sync status — and
 * never another user's. No LLM. A day's questions are generated by the daily
 * cron for every member with personalized questions, or on demand when a user
 * opens the CRM before the cron ran.
 *
 * A set with no personalized questions (sync off, or no data) is never saved:
 * saving it would hide the user's last personalized questions behind a
 * generic-only day. The read path regenerates it instead, which is cheap.
 */
export class CrmSuggestedQuestionService {
  constructor(
    private readonly questionRepo: CrmSuggestedQuestionRepository,
    private readonly interactionRepo: ContactInteractionRepository,
    private readonly dealContactRepo: DealContactRepository,
    private readonly userWorkspaceRepo: UserWorkspaceRepository,
    private readonly dealContactService: Pick<
      DealContactService,
      'reconcileSmartFileLinks' | 'linkEmailMentions'
    >,
    private readonly workspaceId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * The daily cron's run for this workspace. First it writes the workspace's
   * missing automatic deal links, each one set-based statement capped per
   * call: late Smart Files links (`reconcileSmartFileLinks()`, files
   * processed before their sender became a CRM contact) and email-mention
   * links (`linkEmailMentions()`, which catches pairs the post-ingest and
   * contact-read passes missed — a company leaving `discovered`, a related
   * company resolved later). These are the only workspace-wide passes with
   * no `since` — the banker list never writes, and one-contact reads (the
   * contact panel, the chat tool's contact mode) only link that contact. Each
   * is best-effort and independent: a failure is logged and the day's
   * questions are still generated, after them so they see the new links.
   */
  async runDaily(): Promise<DailyRunResult> {
    let reconciled = 0;
    let emailLinked = 0;
    let reconcileFailed = false;
    try {
      reconciled = (await this.dealContactService.reconcileSmartFileLinks()).length;
    } catch (err) {
      reconcileFailed = true;
      console.error(
        `[crmSuggestedQuestionService] workspace ${this.workspaceId} link reconcile failed:`,
        err,
      );
    }
    try {
      emailLinked = (await this.dealContactService.linkEmailMentions()).length;
    } catch (err) {
      reconcileFailed = true;
      console.error(
        `[crmSuggestedQuestionService] workspace ${this.workspaceId} email-mention linking failed:`,
        err,
      );
    }
    const result = await this.generateForWorkspace();
    return { ...result, reconciled, emailLinked, reconcileFailed };
  }

  /**
   * Generate and save the day's questions for every member with personalized
   * questions, in a fixed number of queries however many members there are:
   * one member read, one activity read for all of them, one workspace
   * deal-link check, one link read for every contact involved, one bulk
   * upsert. A member with none (sync off, no data) gets no row, so their
   * latest saved personalized questions stay readable.
   */
  async generateForWorkspace(forDate?: string): Promise<WorkspaceGenerationResult> {
    const now = this.now();
    const date = forDate ?? askBrainDate(now);
    const members = await this.userWorkspaceRepo.findByWorkspaceId(this.workspaceId);
    const memberIds = [...new Set(members.map((m) => m.user_id))];
    if (memberIds.length === 0) return { forDate: date, members: 0, generated: 0 };

    const [activity, workspaceHasDealLinks] = await Promise.all([
      this.interactionRepo.listUserContactActivity(
        this.workspaceId,
        memberIds,
        now,
        recentSince(now),
      ),
      this.dealContactRepo.hasActiveLinks(this.workspaceId),
    ]);
    const byUser = new Map<string, UserContactActivityRow[]>();
    for (const r of activity) {
      const bucket = byUser.get(r.userId);
      if (bucket) bucket.push(r);
      else byUser.set(r.userId, [r]);
    }
    const links = await this.dealContactRepo.listForContacts(this.workspaceId, [
      ...new Set(activity.map((r) => r.correspondentId)),
    ]);
    const synced = new Map(members.map((m) => [m.user_id, m.is_email_synced]));

    const rows: UpsertCrmSuggestedQuestionInput[] = [];
    for (const userId of memberIds) {
      const own = byUser.get(userId);
      if (!own || own.length === 0) continue;
      const questions = buildSuggestedQuestions({
        activity: own,
        links,
        hasSync: synced.get(userId) === true,
        workspaceHasDealLinks,
        now,
      });
      if (questions.personalized.length === 0) continue;
      rows.push({ workspaceId: this.workspaceId, userId, forDate: date, questions });
    }
    await this.questionRepo.upsertMany(rows);
    return { forDate: date, members: memberIds.length, generated: rows.length };
  }

  /**
   * Today's questions for the user. Generated (and saved) on demand when the
   * cron has not written today's row. The most recent saved day is returned
   * with `stale: true` when generation fails, or when it yields no
   * personalized questions (sync turned off, data gone) but a saved day has
   * them; the generic three and `hasSync` then follow the fresh read. Generic
   * only when nothing personalized was ever saved.
   */
  async getForUser(userId: string): Promise<SuggestedQuestionsResult> {
    const now = this.now();
    const today = askBrainDate(now);

    let latest: SuggestedQuestionSet | null = null;
    try {
      const row = await this.questionRepo.findLatestForUser(this.workspaceId, userId, today);
      latest = row ? parseStoredQuestionSet(row.questions) : null;
      if (row && latest && row.forDate === today) return { ...latest, stale: false };
    } catch (err) {
      console.error('[crmSuggestedQuestionService] reading saved questions failed:', err);
    }

    let fresh: SuggestedQuestionSet;
    try {
      fresh = await this.buildForUser(userId, now);
    } catch (err) {
      console.error('[crmSuggestedQuestionService] generating questions failed:', err);
      if (latest) return { ...latest, stale: true };
      // Nothing generated or saved: the generic three, as for a user without sync.
      return { personalized: [], generic: genericQuestions(false), hasSync: false, stale: false };
    }
    if (fresh.personalized.length === 0) {
      // Nothing personal to save: keep the last personalized day visible.
      if (latest && latest.personalized.length > 0) {
        return { ...fresh, personalized: latest.personalized, stale: true };
      }
      return { ...fresh, stale: false };
    }
    try {
      await this.questionRepo.upsertMany([
        { workspaceId: this.workspaceId, userId, forDate: today, questions: fresh },
      ]);
    } catch (err) {
      // The questions are still right; tomorrow's cron or the next load saves them.
      console.error('[crmSuggestedQuestionService] saving questions failed:', err);
    }
    return { ...fresh, stale: false };
  }

  /** One user's set from their own rows only (four queries, nothing written). */
  private async buildForUser(userId: string, now: Date): Promise<SuggestedQuestionSet> {
    const [membership, activity, workspaceHasDealLinks] = await Promise.all([
      this.userWorkspaceRepo.findOne(userId, this.workspaceId),
      this.interactionRepo.listUserContactActivity(
        this.workspaceId,
        [userId],
        now,
        recentSince(now),
      ),
      this.dealContactRepo.hasActiveLinks(this.workspaceId),
    ]);
    // The read is already restricted to this user; the filter keeps it so.
    const own = activity.filter((r) => r.userId === userId);
    const links = await this.dealContactRepo.listForContacts(this.workspaceId, [
      ...new Set(own.map((r) => r.correspondentId)),
    ]);
    return buildSuggestedQuestions({
      activity: own,
      links,
      hasSync: membership?.is_email_synced === true,
      workspaceHasDealLinks,
      now,
    });
  }
}

function recentSince(now: Date): Date {
  return new Date(now.getTime() - RECENT_WINDOW_DAYS * DAY_MS);
}
