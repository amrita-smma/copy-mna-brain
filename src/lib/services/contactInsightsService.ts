import type {
  ContactEmailInteractionRow,
  ContactInteractionRepository,
  CorrespondentRepository,
} from '@/lib/repositories';
import { decodeHtmlEntities } from '@/lib/crm/displayText';
import { ContactNotFoundError } from './crmContactEnrichmentService';
import type { BankerScorecard, BankerScorecardService } from './bankerScorecardService';
import type { ContactDealLink, DealContactService } from './dealContactService';

/** One team member's interactions with one contact. */
export interface ContactTeamInteraction {
  userId: string;
  name: string | null;
  email: string | null;
  emailsFromUs: number;
  emailsFromThem: number;
  lastEmailAt: string | null;
}

/**
 * A contact's (one person's, never a firm's) interaction scorecard. `null`
 * means "no such interaction" and must render as "—", never as 0.
 */
export interface ContactInteractionSummary {
  correspondentId: string;
  lastContactAt: string | null;
  /** Distinct emails our team sent this person. */
  totalEmailsFromUs: number;
  /**
   * Distinct emails this person sent us: one email to two colleagues is one
   * email here, though it appears in both colleagues' `team` rows.
   */
  totalEmailsFromThem: number;
  teamMemberCount: number;
  team: ContactTeamInteraction[];
  /** False when the workspace has no synced email at all. */
  hasSyncedData: boolean;
}

/** A company this contact's own emails were evidence for. */
export interface ContactRelatedCompany {
  companyId: string;
  companyName: string;
  evidenceCount: number;
  lastSeenAt: string | null;
}

/** The contact as stored, with display text decoded. */
export interface ContactInsightsContact {
  id: string;
  name: string;
  email: string | null;
  title: string | null;
}

export interface ContactInsights {
  contact: ContactInsightsContact;
  interactions: ContactInteractionSummary;
  relatedCompanies: ContactRelatedCompany[];
  /** Brain deals this person brought (`source`) or was involved in (active links). */
  deals: ContactDealLink[];
  /** Deals brought / involved, furthest stage reached, conversion (all time). */
  scorecard: BankerScorecard;
}

function totalOf(t: ContactTeamInteraction): number {
  return t.emailsFromUs + t.emailsFromThem;
}

/**
 * Each contact's team (member names decoded), most emails both ways first,
 * then the latest email, then name. The mart has one row per (contact,
 * member), so each row is one team member.
 */
export function teamsByContact(
  rows: readonly ContactEmailInteractionRow[],
): Map<string, ContactTeamInteraction[]> {
  const teams = new Map<string, ContactTeamInteraction[]>();
  for (const r of rows) {
    const member: ContactTeamInteraction = {
      userId: r.userId,
      name: decodeHtmlEntities(r.userName),
      email: r.userEmail,
      emailsFromUs: r.emailsFromUs,
      emailsFromThem: r.emailsFromThem,
      lastEmailAt: r.lastEmailAt,
    };
    const team = teams.get(r.correspondentId);
    if (team) team.push(member);
    else teams.set(r.correspondentId, [member]);
  }
  for (const team of teams.values()) {
    team.sort(
      (a, b) =>
        totalOf(b) - totalOf(a) ||
        (Date.parse(b.lastEmailAt ?? '') || 0) - (Date.parse(a.lastEmailAt ?? '') || 0) ||
        (a.name ?? a.email ?? a.userId).localeCompare(b.name ?? b.email ?? b.userId),
    );
  }
  return teams;
}

/**
 * Per-person CRM insights (MB-854): who on our team emails this contact, how
 * often, and when; and the companies the person's own emails were about. Names leave here decoded
 * (`decodeHtmlEntities`): stored CRM text can carry ingest's `&amp;`. Reads are bulk — one query per kind for the
 * whole id list — so a table of contacts never fans out.
 */
export class ContactInsightsService {
  constructor(
    private readonly interactionRepo: ContactInteractionRepository,
    private readonly correspondentRepo: CorrespondentRepository,
    private readonly dealContactService: DealContactService,
    private readonly bankerScorecardService: BankerScorecardService,
    private readonly workspaceId: string,
  ) {}

  /**
   * One summary per requested contact (also for contacts with no
   * interactions: zero totals, null dates, empty team).
   */
  async getInteractionSummaries(
    correspondentIds: string[],
  ): Promise<Map<string, ContactInteractionSummary>> {
    const ids = [...new Set(correspondentIds)];
    const summaries = new Map<string, ContactInteractionSummary>();
    if (ids.length === 0) return summaries;

    const [emailRows, emailTotalRows, hasSyncedData] = await Promise.all([
      this.interactionRepo.listEmailInteractions(this.workspaceId, ids),
      this.interactionRepo.listEmailTotals(this.workspaceId, ids),
      this.interactionRepo.workspaceHasSyncedData(this.workspaceId),
    ]);

    const teams = teamsByContact(emailRows);
    const emailTotalsByContact = new Map(emailTotalRows.map((r) => [r.correspondentId, r]));

    for (const correspondentId of ids) {
      const team = teams.get(correspondentId) ?? [];
      const emailTotals = emailTotalsByContact.get(correspondentId);
      summaries.set(correspondentId, {
        correspondentId,
        lastContactAt: emailTotals?.lastEmailAt ?? null,
        // Per-contact distinct counts, never the sum of the team rows.
        totalEmailsFromUs: emailTotals?.emailsFromUs ?? 0,
        totalEmailsFromThem: emailTotals?.emailsFromThem ?? 0,
        teamMemberCount: team.length,
        team,
        hasSyncedData,
      });
    }
    return summaries;
  }

  /**
   * Interactions, person-level related companies, deal links and the deal
   * scorecard for one contact. Throws
   * {@link ContactNotFoundError} when the contact is not visible in this
   * workspace.
   */
  async getContactInsights(
    correspondentId: string,
    opts: { since?: string } = {},
  ): Promise<ContactInsights> {
    const contact = await this.correspondentRepo.findById(correspondentId, this.workspaceId);
    if (!contact) throw new ContactNotFoundError(correspondentId);

    const dealsPromise = this.dealContactService.listDealsOfVisibleContact(correspondentId);
    // After the deal read, which has just reconciled this contact's Smart Files links.
    const scorecardPromise = dealsPromise.then(async () => {
      const cards = await this.bankerScorecardService.getScorecards([correspondentId], opts);
      return cards.get(correspondentId)!;
    });
    const [summaries, relatedRows, contactDeals, scorecard] = await Promise.all([
      this.getInteractionSummaries([correspondentId]),
      this.interactionRepo.listRelatedCompaniesForContacts(this.workspaceId, [correspondentId]),
      dealsPromise,
      scorecardPromise,
    ]);
    return {
      contact: {
        id: contact.id,
        name: decodeHtmlEntities(contact.name),
        email: contact.email,
        title: decodeHtmlEntities(contact.title),
      },
      interactions: summaries.get(correspondentId)!,
      relatedCompanies: relatedRows.map((r) => ({
        companyId: r.companyId,
        companyName: decodeHtmlEntities(r.companyName),
        evidenceCount: r.evidenceCount,
        lastSeenAt: r.lastSeenAt,
      })),
      deals: contactDeals.deals,
      scorecard,
    };
  }
}
