import type { DashboardActivityRepository } from '@/lib/repositories/dashboardActivityRepository';
import { companyDisplayName } from '@/lib/companyDisplay';

export type NewL0Company = Awaited<ReturnType<DashboardActivityRepository['getNewL0Companies']>>[number];
export type AiSourcedCompany = Awaited<ReturnType<DashboardActivityRepository['getAiSourcedCompanies']>>[number];
export type DiscoveredCompany = Awaited<ReturnType<DashboardActivityRepository['getDiscoveredCompanies']>>[number];
export type PipelineMove = Awaited<ReturnType<DashboardActivityRepository['getPipelineMoves']>>[number];
export type SlideGenerated = Awaited<ReturnType<DashboardActivityRepository['getSlidesGenerated']>>[number];
export type DroppedDeal = Awaited<ReturnType<DashboardActivityRepository['getDroppedDeals']>>[number];
export type WorkforceJob = Awaited<ReturnType<DashboardActivityRepository['getWorkforceJobs']>>[number];
export type NewContact = Awaited<ReturnType<DashboardActivityRepository['getNewContacts']>>[number];
export type NoteUpdated = Awaited<ReturnType<DashboardActivityRepository['getNotesUpdated']>>[number];

export interface DashboardActivity {
  newL0Companies: NewL0Company[];
  aiSourcedCompanies: AiSourcedCompany[];
  discoveredCompanies: DiscoveredCompany[];
  pipelineMoves: PipelineMove[];
  slidesGenerated: SlideGenerated[];
  droppedDeals: DroppedDeal[];
  workforceJobs: WorkforceJob[];
  newContacts: NewContact[];
  notesUpdated: NoteUpdated[];
}

// ─── Activity feed ────────────────────────────────────────────────────────────

export type FeedEventType = 'new_deal' | 'stage_move' | 'dropped' | 'note_updated' | 'ai_discovered';

/** Filter keys accepted by the feed endpoint. `all` merges every event type. */
export type FeedFilter = 'all' | FeedEventType;

/**
 * A single, normalized item in the dashboard activity feed. Built server-side
 * by merging the new-deal / stage-move / dropped / note-updated sources so the
 * feed can be paginated as one sorted stream.
 */
export interface FeedEvent {
  id: string;
  type: FeedEventType;
  company_id: string;
  company_name: string;
  segment: string | null;
  geography: string | null;
  source: string | null;
  event_at: string;
  from_stage?: string | null;
  to_stage?: string | null;
  dropped_stage?: string | null;
  dropped_reason?: string | null;
  remarks?: string | null;
  thesis_content?: string | null;
  promoted_reasons?: string | null;
  note_content?: string | null;
  note_stage?: string | null;
  revenue_usd_mn?: number | null;
  ebitda_usd_mn?: number | null;
  ev_usd_mn?: number | null;
  financial_year?: number | null;
}

export interface FeedPage {
  events: FeedEvent[];
  /** True when more events exist beyond this page (for infinite scroll). */
  hasMore: boolean;
}

export interface GetFeedParams {
  from: Date;
  to: Date;
  offset: number;
  limit: number;
  filter?: FeedFilter;
}

/** Parse a promotion log `action` into its from/to pipeline stages. */
function parsePipelineMoveAction(action: string | null): {
  from: string | null;
  to: string | null;
} {
  if (!action) return { from: null, to: null };
  const fromTo = action.match(/^PROMOTED_FROM_(\S+)_TO_(\S+)$/);
  if (fromTo) return { from: fromTo[1], to: fromTo[2] };
  const toOnly = action.match(/^PROMOTED_TO_(\S+)$/);
  if (toOnly) return { from: null, to: toOnly[1] };
  return { from: null, to: null };
}

export class DashboardActivityService {
  constructor(private repo: DashboardActivityRepository) {}

  async getActivity(from: Date, to: Date): Promise<DashboardActivity> {
    const [
      newL0Companies,
      aiSourcedCompanies,
      discoveredCompanies,
      pipelineMoves,
      slidesGenerated,
      droppedDeals,
      workforceJobs,
      newContacts,
      notesUpdated,
    ] = await Promise.all([
      this.repo.getNewL0Companies(from, to),
      this.repo.getAiSourcedCompanies(from, to),
      this.repo.getDiscoveredCompanies(from, to),
      this.repo.getPipelineMoves(from, to),
      this.repo.getSlidesGenerated(from, to),
      this.repo.getDroppedDeals(from, to),
      this.repo.getWorkforceJobs(from, to),
      this.repo.getNewContacts(from, to),
      this.repo.getNotesUpdated(from, to),
    ]);

    return {
      newL0Companies,
      aiSourcedCompanies,
      discoveredCompanies,
      pipelineMoves,
      slidesGenerated,
      droppedDeals,
      workforceJobs,
      newContacts,
      notesUpdated,
    };
  }

  /**
   * Return one page of the merged activity feed, newest first.
   *
   * Pagination is offset-based over the merged stream. Because the feed is a
   * union of up to four independently-sorted sources, we fetch the top
   * `offset + limit + 1` rows from each contributing source, merge + sort them,
   * then slice the requested window. Fetching `offset + limit + 1` per source is
   * the smallest cap that still guarantees the true top `(offset + limit + 1)`
   * of the merged stream is present (a single source could supply the entire
   * window), and the extra `+1` row tells us whether more pages remain. When a
   * single `filter` is set we only query that one source.
   */
  async getFeed({ from, to, offset, limit, filter = 'all' }: GetFeedParams): Promise<FeedPage> {
    const cap = offset + limit + 1;
    const want = (type: FeedEventType) => filter === 'all' || filter === type;

    const [newL0Companies, pipelineMoves, droppedDeals, notesUpdated, discoveredCompanies] =
      await Promise.all([
        want('new_deal') ? this.repo.getNewL0Companies(from, to, cap) : Promise.resolve([]),
        want('stage_move') ? this.repo.getPipelineMoves(from, to, cap) : Promise.resolve([]),
        want('dropped') ? this.repo.getDroppedDeals(from, to, cap) : Promise.resolve([]),
        want('note_updated') ? this.repo.getNotesUpdated(from, to, cap) : Promise.resolve([]),
        want('ai_discovered') ? this.repo.getDiscoveredCompanies(from, to, cap) : Promise.resolve([]),
      ]);

    const all = buildFeedEvents({
      newL0Companies,
      pipelineMoves,
      droppedDeals,
      notesUpdated,
      discoveredCompanies,
    });
    const hasMore = all.length > offset + limit;
    const events = all.slice(offset, offset + limit);

    return { events, hasMore };
  }
}

/**
 * Merge the feed-contributing activity sources into a single list of
 * `FeedEvent`s sorted newest-first. Accepts a partial slice of
 * `DashboardActivity` so the paginated `getFeed` path can pass only the sources
 * it queried.
 */
export function buildFeedEvents(activity: {
  newL0Companies: NewL0Company[];
  pipelineMoves: PipelineMove[];
  droppedDeals: DroppedDeal[];
  notesUpdated: NoteUpdated[];
  discoveredCompanies: DiscoveredCompany[];
}): FeedEvent[] {
  const events: FeedEvent[] = [];

  for (const c of activity.discoveredCompanies) {
    if (!c.event_at) continue;
    events.push({
      id: `discovered-${c.id}-${c.event_at}`,
      type: 'ai_discovered',
      company_id: c.id,
      company_name: companyDisplayName(c, '—'),
      segment: c.segment ?? null,
      geography: c.geography ?? null,
      source: c.source ?? null,
      event_at: c.event_at,
      remarks: c.remarks ?? null,
      thesis_content: c.thesis_content ?? null,
      revenue_usd_mn: c.revenue_usd_mn ?? null,
      ebitda_usd_mn: c.ebitda_usd_mn ?? null,
      ev_usd_mn: c.ev_usd_mn ?? null,
      financial_year: c.financial_year ?? null,
    });
  }

  for (const c of activity.newL0Companies) {
    events.push({
      id: `new-${c.id}-${c.event_at}`,
      type: 'new_deal',
      company_id: c.id,
      company_name: companyDisplayName(c, '—'),
      segment: c.segment ?? null,
      geography: c.geography ?? null,
      source: c.source ?? null,
      event_at: c.event_at,
      remarks: c.remarks ?? null,
      thesis_content: c.thesis_content ?? null,
      revenue_usd_mn: c.revenue_usd_mn ?? null,
      ebitda_usd_mn: c.ebitda_usd_mn ?? null,
      ev_usd_mn: c.ev_usd_mn ?? null,
      financial_year: c.financial_year ?? null,
    });
  }

  for (const m of activity.pipelineMoves) {
    if (!m.created_at) continue;
    const { from: fromStage, to: toStage } = parsePipelineMoveAction(m.action);
    events.push({
      id: `move-${m.id}`,
      type: 'stage_move',
      company_id: m.company_id ?? '',
      company_name: companyDisplayName(m, '—'),
      segment: m.segment ?? null,
      geography: m.geography ?? null,
      source: m.source ?? null,
      event_at: m.created_at,
      from_stage: fromStage,
      to_stage: toStage,
      remarks: m.remarks ?? null,
      thesis_content: m.thesis_content ?? null,
      promoted_reasons: m.promoted_reasons ?? null,
      revenue_usd_mn: m.revenue_usd_mn ?? null,
      ebitda_usd_mn: m.ebitda_usd_mn ?? null,
      ev_usd_mn: m.ev_usd_mn ?? null,
      financial_year: m.financial_year ?? null,
    });
  }

  for (const d of activity.droppedDeals) {
    if (!d.dropped_at) continue;
    events.push({
      id: `dropped-${d.id}`,
      type: 'dropped',
      company_id: d.id,
      company_name: companyDisplayName(d, '—'),
      segment: d.segment ?? null,
      geography: d.geography ?? null,
      source: d.source ?? null,
      event_at: d.dropped_at,
      dropped_stage: d.pipeline_stage ?? null,
      dropped_reason: d.dropped_reason ?? null,
      thesis_content: d.thesis_content ?? null,
      revenue_usd_mn: d.revenue_usd_mn ?? null,
      ebitda_usd_mn: d.ebitda_usd_mn ?? null,
      ev_usd_mn: d.ev_usd_mn ?? null,
      financial_year: d.financial_year ?? null,
    });
  }

  for (const n of activity.notesUpdated) {
    if (!n.created_at) continue;
    events.push({
      id: `note-${n.id}`,
      type: 'note_updated',
      company_id: n.company_id,
      company_name: companyDisplayName(n, '—'),
      segment: n.segment ?? null,
      geography: n.geography ?? null,
      source: n.source ?? null,
      event_at: n.created_at,
      note_content: n.content ?? null,
      note_stage: n.stage ?? null,
      remarks: n.remarks ?? null,
      thesis_content: n.thesis_content ?? null,
      revenue_usd_mn: n.revenue_usd_mn ?? null,
      ebitda_usd_mn: n.ebitda_usd_mn ?? null,
      ev_usd_mn: n.ev_usd_mn ?? null,
      financial_year: n.financial_year ?? null,
    });
  }

  return events.sort((a, b) => b.event_at.localeCompare(a.event_at));
}
