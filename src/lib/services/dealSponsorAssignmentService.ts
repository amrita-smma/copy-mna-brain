import type {
  CompanyLogRepository,
  CompanyRepository,
  CorrespondentRepository,
  DealContactRepository,
  EmployerRepository,
  EmployerTeamRepository,
  InvestmentThesisRepository,
  PipelineStageRepository,
  Tables,
  UserRepository,
} from '@/lib/repositories';
import {
  autoAssignedSponsorAction,
  parseAutoAssignedSponsorAction,
} from '@/lib/repositories/companyLogRepository';
import { CAPTAIN_FROM_STAGE_KEY, FIRST_STAGE_KEY, isInPipelineStage } from '@/lib/pipeline/stages';
import {
  needsActiveDealTieBreak,
  normalizeLabel,
  pickSponsor,
  scoreSponsorCandidates,
  type BankerDeal,
  type MarketDeal,
  type SponsorCandidate,
  type StageTier,
} from '@/lib/pipeline/sponsorScoring';
import { persistedTrackIds, trackDisplayName } from '@/lib/tracks/matchTracks';
import { buildStageRanker, furthestStage, type StageRanker } from './bankerScorecardService';

/** Newest sector/country deals read per run — older ones only add 0.3-weighted noise. */
const MARKET_DEAL_LIMIT = 2000;

export interface SponsorAssignment {
  companyId: string;
  userId: string;
  reason: string;
}

export interface DealSponsorAssignmentDeps {
  companyRepo: CompanyRepository;
  companyLogRepo: CompanyLogRepository;
  dealContactRepo: DealContactRepository;
  correspondentRepo: CorrespondentRepository;
  employerRepo: EmployerRepository;
  employerTeamRepo: EmployerTeamRepository;
  thesisRepo: InvestmentThesisRepository;
  userRepo: UserRepository;
  stageRepo: PipelineStageRepository;
}

/** L0, L1 up to L3, or L3 onward by workspace stage order; `null` before the pipeline. */
export function stageTier(stage: string | null | undefined, ranker: StageRanker): StageTier | null {
  if (!isInPipelineStage(stage)) return null;
  if (stage === FIRST_STAGE_KEY) return 'first';
  const rank = ranker.rankOf(stage);
  const captainRank = ranker.rankOf(CAPTAIN_FROM_STAGE_KEY);
  if (rank !== null && captainRank !== null && rank >= captainRank) return 'captain';
  return 'middle';
}

/**
 * A deal whose sponsor is still an earlier auto-assignment and that never got
 * past L0 is not evidence of anything — auto-scan alone can take a deal to L0.
 * Counting it would let one auto pick snowball into the next.
 */
function isUnconfirmedAutoPick(
  company: Pick<Tables<'companies'>, 'deal_sponsor' | 'deal_captain'>,
  tier: StageTier,
  autoUserId: string | null,
): boolean {
  return tier === 'first' && !company.deal_captain && !!autoUserId && company.deal_sponsor === autoUserId;
}

const ownerOf = (c: Pick<Tables<'companies'>, 'deal_sponsor' | 'deal_captain'>) =>
  c.deal_captain || c.deal_sponsor || null;

/**
 * Deal Sponsor auto-assignment for companies detected in an email (MB-830).
 * Scores workspace members on the sending banker's past deals, coverage of
 * the banker's firm, the matched Track's PIC, past deals in the same sector
 * and country, and who received the email (`src/lib/pipeline/sponsorScoring.ts`
 * holds the weights). Only fills an empty sponsor on a pre-pipeline company,
 * and logs `AUTO_ASSIGNED_SPONSOR:<user id>` with the reason so the card can
 * say the sponsor was picked automatically.
 *
 * Bulk: a fixed number of queries however many companies the file created.
 */
export class DealSponsorAssignmentService {
  constructor(
    private readonly deps: DealSponsorAssignmentDeps,
    private readonly workspaceId: string,
  ) {}

  async assignForNewCompanies(companyIds: string[]): Promise<SponsorAssignment[]> {
    const ids = [...new Set(companyIds)];
    if (ids.length === 0) return [];
    const d = this.deps;

    const targets = (await d.companyRepo.findByIds(ids)).filter(
      (c) =>
        !c.deal_sponsor &&
        c.status === 'active' &&
        !isInPipelineStage(c.pipeline_stage) &&
        !!c.created_at,
    );
    if (targets.length === 0) return [];
    const targetIds = new Set(targets.map((t) => t.id));

    const [links, members, tracks, stageRows] = await Promise.all([
      d.dealContactRepo.listActiveForCompanies(this.workspaceId, [...targetIds]),
      d.userRepo.findAllInWorkspace(this.workspaceId),
      d.thesisRepo.findAll(),
      d.stageRepo.list(),
    ]);
    const ranker = buildStageRanker(stageRows);
    const eligible = new Set(members.map((m) => m.id));
    const correspondentIds = [...new Set(links.map((l) => l.correspondentId))];
    const segments = [...new Set(targets.map((t) => normalizeLabel(t.segment)).filter((s): s is string => !!s))];
    const geographies = [
      ...new Set(targets.map((t) => normalizeLabel(t.geography)).filter((g): g is string => !!g)),
    ];
    const latestArrival = new Date(Math.max(...targets.map((t) => Date.parse(t.created_at!)))).toISOString();

    const [history, correspondents, marketRows] = await Promise.all([
      d.dealContactRepo.listForContacts(this.workspaceId, correspondentIds),
      d.correspondentRepo.findByIds(correspondentIds),
      d.companyRepo.findOwnedDealsForSponsorMatch({
        segments,
        geographies,
        before: latestArrival,
        limit: MARKET_DEAL_LIMIT,
      }),
    ]);
    const activeHistory = history.filter((h) => h.status === 'active' && !targetIds.has(h.companyId));
    const historyCompanyIds = [...new Set(activeHistory.map((h) => h.companyId))];
    const employerIds = [...new Set(correspondents.map((c) => c.employer_id))];
    const marketL0Ids = marketRows.filter((r) => r.pipeline_stage === FIRST_STAGE_KEY).map((r) => r.id);

    const [historyCompanies, historyLogs, marketAutoLogs, coverageRows, employers] = await Promise.all([
      d.companyRepo.findByIds(historyCompanyIds),
      d.companyLogRepo.findByCompanyIds(historyCompanyIds),
      d.companyLogRepo.findLatestAutoSponsorLogs(marketL0Ids),
      d.employerTeamRepo.listForEmployers(this.workspaceId, employerIds),
      d.employerRepo.findByIds(employerIds, this.workspaceId),
    ]);

    // Banker-history deals, keyed by company: owner, furthest stage, and
    // whether the owner is still an unconfirmed auto pick.
    const actionsByCompany = new Map<string, Array<string | null>>();
    for (const log of historyLogs) {
      if (!log.company_id) continue;
      const list = actionsByCompany.get(log.company_id) ?? [];
      list.push(log.action);
      actionsByCompany.set(log.company_id, list);
    }
    const historyDeal = new Map<string, Omit<BankerDeal, 'role' | 'bankerName'>>();
    for (const c of historyCompanies) {
      const owner = ownerOf(c);
      if (!owner || !c.created_at) continue;
      const actions = actionsByCompany.get(c.id) ?? [];
      const tier = stageTier(furthestStage(c.pipeline_stage, actions, ranker), ranker);
      if (!tier) continue;
      const autoUserId = actions.map(parseAutoAssignedSponsorAction).filter(Boolean).at(-1) ?? null;
      if (isUnconfirmedAutoPick(c, tier, autoUserId)) continue;
      historyDeal.set(c.id, {
        companyId: c.id,
        ownerId: owner,
        tier,
        dropped: c.status === 'dropped',
        createdAt: c.created_at,
      });
    }

    const marketDeals: MarketDeal[] = [];
    for (const r of marketRows) {
      const owner = ownerOf(r);
      const tier = stageTier(r.pipeline_stage, ranker);
      if (!owner || !tier || !r.created_at) continue;
      if (isUnconfirmedAutoPick(r, tier, marketAutoLogs.get(r.id)?.user_id ?? null)) continue;
      marketDeals.push({
        companyId: r.id,
        ownerId: owner,
        tier,
        dropped: r.status === 'dropped',
        createdAt: r.created_at,
        segment: r.segment || null,
        geography: r.geography || null,
      });
    }

    const correspondentById = new Map(correspondents.map((c) => [c.id, c]));
    const employerNameById = new Map(employers.map((e) => [e.id, e.name]));
    const coverageByEmployer = new Map<string, string[]>();
    for (const row of coverageRows) {
      const list = coverageByEmployer.get(row.employer_id) ?? [];
      list.push(row.id);
      coverageByEmployer.set(row.employer_id, list);
    }
    const historyByCorrespondent = new Map<string, typeof activeHistory>();
    for (const h of activeHistory) {
      const list = historyByCorrespondent.get(h.correspondentId) ?? [];
      list.push(h);
      historyByCorrespondent.set(h.correspondentId, list);
    }
    // Track PIC is free text: it counts only when it names exactly one member.
    const membersByName = new Map<string, string[]>();
    for (const m of members) {
      const key = m.name?.trim().toLowerCase();
      if (!key) continue;
      membersByName.set(key, [...(membersByName.get(key) ?? []), m.id]);
    }
    const linksByCompany = new Map<string, typeof links>();
    for (const l of links) {
      linksByCompany.set(l.companyId, [...(linksByCompany.get(l.companyId) ?? []), l]);
    }

    const scored: Array<{ companyId: string; candidates: SponsorCandidate[] }> = [];
    for (const target of targets) {
      const bankerDeals: BankerDeal[] = [];
      const coverage: Array<{ userId: string; firmName: string }> = [];
      for (const link of linksByCompany.get(target.id) ?? []) {
        const correspondent = correspondentById.get(link.correspondentId);
        if (!correspondent) continue;
        for (const h of historyByCorrespondent.get(link.correspondentId) ?? []) {
          const deal = historyDeal.get(h.companyId);
          if (deal) bankerDeals.push({ ...deal, role: h.role, bankerName: correspondent.name });
        }
        const firmName = employerNameById.get(correspondent.employer_id);
        for (const userId of coverageByEmployer.get(correspondent.employer_id) ?? []) {
          if (firmName) coverage.push({ userId, firmName });
        }
      }
      // Saved Tracks only: the keyword guess `resolveTrackIds` falls back to is
      // fine for display but must not become a stored sponsor.
      const trackPics: Array<{ userId: string; trackName: string }> = [];
      for (const trackId of persistedTrackIds(target, tracks)) {
        const track = tracks.find((t) => t.id === trackId);
        const matches = track?.pic ? membersByName.get(track.pic.trim().toLowerCase()) : undefined;
        if (track && matches?.length === 1) {
          trackPics.push({ userId: matches[0], trackName: trackDisplayName(track) });
        }
      }
      scored.push({
        companyId: target.id,
        candidates: scoreSponsorCandidates({
          arrivalAt: target.created_at!,
          segment: target.segment,
          geography: target.geography,
          bankerDeals,
          coverage,
          trackPics,
          marketDeals,
          mailboxOwnerId: target.entered_by,
          eligibleUserIds: eligible,
        }),
      });
    }

    // Fewer active deals only breaks a tie still standing after every other rule.
    const tiedUserIds = [
      ...new Set(
        scored
          .filter((s) => needsActiveDealTieBreak(s.candidates))
          .flatMap((s) => s.candidates.filter((c) => c.score === s.candidates[0].score).map((c) => c.userId)),
      ),
    ];
    const activeDeals =
      tiedUserIds.length > 0 ? await d.companyRepo.countActiveDealsByOwners(tiedUserIds) : undefined;

    const picks = new Map<string, SponsorAssignment>();
    for (const { companyId, candidates } of scored) {
      const pick = pickSponsor(candidates, activeDeals);
      if (pick) picks.set(companyId, { companyId, userId: pick.userId, reason: pick.reason });
    }
    if (picks.size === 0) return [];

    const changed = await d.companyRepo.assignDealSponsorsIfEmpty(
      [...picks.values()].map(({ companyId, userId }) => ({ companyId, userId })),
    );
    const assigned = changed.map((row) => picks.get(row.id)).filter((p): p is SponsorAssignment => !!p);
    await d.companyLogRepo.insertMany(
      assigned.map((a) => ({
        company_id: a.companyId,
        action: autoAssignedSponsorAction(a.userId),
        comments: a.reason,
      })),
    );
    return assigned;
  }
}
