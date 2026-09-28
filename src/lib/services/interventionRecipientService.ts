import type {
  InsightRepository,
  RoutinesRepository,
  UserWorkspaceRepository,
} from '@/lib/repositories';

/** The run fields recipient resolution reads. */
export interface InterventionRun {
  workspace_id: string;
  triggered_by_user_id: string | null;
  origin_routine_id: string | null;
}

/**
 * Who a workforce run's HITL intervention is addressed to (MB-561): the person
 * who gets the waiting-approval email and may decide alongside the task
 * creator.
 *
 *   - Refresh run (a routine refreshing an insight): the insight's owner
 *     (`insights.created_by`); if that is null or no longer a member of the
 *     workspace, the routine's creator; failing that, the run's triggerer (a
 *     manual force-run).
 *   - Any other run: the run's triggering user, or — for a cron run, which has
 *     none — the routine's creator. That is who the approval email already
 *     went to before MB-561.
 *
 * Returns null when nobody can be resolved.
 */
export class InterventionRecipientService {
  constructor(
    private readonly insightRepo: InsightRepository,
    private readonly routinesRepo: RoutinesRepository,
    private readonly userWorkspaceRepo: UserWorkspaceRepository,
  ) {}

  async resolveRecipient(
    run: InterventionRun,
    refreshInsightId: string | null,
  ): Promise<string | null> {
    if (!refreshInsightId) {
      return run.triggered_by_user_id ?? (await this.routineCreator(run, false));
    }

    const insight = await this.insightRepo.findById(refreshInsightId, run.workspace_id);
    const ownerId = insight?.created_by ?? null;
    if (ownerId && (await this.isMember(ownerId, run.workspace_id))) {
      return ownerId;
    }
    return (await this.routineCreator(run, true)) ?? run.triggered_by_user_id;
  }

  private async routineCreator(
    run: InterventionRun,
    requireMembership: boolean,
  ): Promise<string | null> {
    if (!run.origin_routine_id) return null;
    const routine = await this.routinesRepo.findById(run.origin_routine_id);
    const creatorId = routine?.created_by ?? null;
    if (!creatorId) return null;
    if (requireMembership && !(await this.isMember(creatorId, run.workspace_id))) {
      return null;
    }
    return creatorId;
  }

  private async isMember(userId: string, workspaceId: string): Promise<boolean> {
    return Boolean(await this.userWorkspaceRepo.findOne(userId, workspaceId));
  }
}
