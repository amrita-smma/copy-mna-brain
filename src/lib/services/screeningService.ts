import type {
  ScreeningGroupInput,
  ScreeningRepository,
  TablesInsert,
} from '@/lib/repositories';
import { captureWorkspaceEvent } from '@/lib/posthog-server';
import { publishLiveEvent } from '@/lib/server/liveEvents';
import { LIVE_TOPICS } from '@/lib/live/topics';

export class ScreeningService {
  constructor(
    private readonly screeningRepo: ScreeningRepository,
    private readonly workspaceId: string,
  ) {}

  findAll(opts: { companyId?: string; inScreening?: boolean }) {
    return this.screeningRepo.findAllWithRelations(opts);
  }

  async create(data: TablesInsert<'screenings'>) {
    const row = await this.screeningRepo.insert(data);
    await publishLiveEvent(this.workspaceId, LIVE_TOPICS.screenings, [row.id]);
    return row;
  }

  async update(id: string, updates: Parameters<ScreeningRepository['update']>[1]) {
    const row = await this.screeningRepo.update(id, updates);
    await publishLiveEvent(this.workspaceId, LIVE_TOPICS.screenings, [id]);
    return row;
  }

  /**
   * Prepare per-track screening groups: one (company, track, criterion) row each.
   *
   * `triggeredByUserId` only exists for telemetry attribution — the
   * `ai_screening_started` capture moved here from `aiScreeningClient` so an ad
   * blocker can't drop it. Captured after the upsert so a failed prepare isn't
   * counted as a started run.
   */
  async prepare(groups: ScreeningGroupInput[], triggeredByUserId?: string | null) {
    const entries = await this.screeningRepo.upsertOrReset(groups);
    await publishLiveEvent(
      this.workspaceId,
      LIVE_TOPICS.screenings,
      entries.map((e) => e.id),
    );

    captureWorkspaceEvent({
      workspaceId: this.workspaceId,
      distinctId: triggeredByUserId ?? 'server',
      event: 'ai_screening_started',
      properties: {
        company_count: new Set(groups.map((g) => g.companyId)).size,
        track_count: groups.length,
        total_screenings: entries.length,
      },
    });

    return entries;
  }
}
