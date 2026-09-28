import { getSectorAgent, type SectorRegistry } from '@/lib/agents/sector/registry';
import type {
  InsightRepository,
  RoutineRow,
  RoutineUpdate,
  RoutinesRepository,
} from '@/lib/repositories';
import { computeNextFireAt, normalizeSchedule } from '@/lib/routines/schedule';
import type { NormalizedSchedule, ScheduleKind } from '@/lib/routines/schedule';
import {
  describeRoutinePause,
  isRoutinePausedReason,
  type RoutinePausedReason,
} from '@/lib/routines/pauseReason';
import { resolveRefreshAgentKey, type RefreshAgentKey } from '@/lib/routines/refreshAgent';
import {
  buildOneOffRefreshRunPayload,
  buildRoutineRunPayload,
} from '@/lib/routines/runPayload';
import type {
  EnqueueAgentRunInput,
  EnqueueAgentRunResult,
} from '@/lib/workforce/enqueue';

/** The agent label a routine run is queued under when the routine names none. */
export const DEFAULT_ROUTINE_AGENT = 'analysis';

/**
 * Puts a run on the AI Workforce queue — `enqueueAgentRun` bound to the
 * request's db in the container. Injected so the run-now path is testable
 * without the queue, the dispatcher or `after()`.
 */
export type RefreshRunEnqueuer = (input: EnqueueAgentRunInput) => Promise<EnqueueAgentRunResult>;

/** What "Refresh this insight now" did (MB-552). */
export interface InsightRefreshNowResult {
  runId: string;
  /** false when a refresh of the insight was already live and no run was added. */
  created: boolean;
  /** The refresh routine the run belongs to; null for a one-off run. */
  routineId: string | null;
}

export class RoutineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class RoutineNotFoundError extends RoutineError {
  constructor(message = 'Routine not found') {
    super(message);
  }
}

export class SystemRoutineError extends RoutineError {
  constructor(message = 'System routines cannot be modified') {
    super(message);
  }
}

export class RoutineInsightNotFoundError extends RoutineError {
  constructor(message = 'Insight not found in this workspace') {
    super(message);
  }
}

export class DuplicateInsightRoutineError extends RoutineError {
  readonly insightId: string;

  constructor(insightId: string, message?: string) {
    super(message ?? `Active routine already exists for insight ${insightId}`);
    this.name = 'DuplicateInsightRoutineError';
    this.insightId = insightId;
  }
}

export class RoutineValidationError extends RoutineError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * The routine is paused because its insight's agent binding is broken (MB-560)
 * — deprecated, or (later) incompatible. Running it by hand or switching it
 * back on would run the broken binding, so both are refused until the insight
 * is rebound, which resumes it.
 */
export class RoutineAgentPausedError extends RoutineError {
  readonly reason: RoutinePausedReason;

  constructor(reason: RoutinePausedReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** What the force-run route needs to enqueue a run exactly as the fire tick does. */
export interface ManualRunPlan {
  routine: RoutineRow;
  insightName: string | null;
  /** The resolved agent for a refresh routine; null for a routine with no insight. */
  agentKey: RefreshAgentKey | null;
}

export interface CreateRoutineInput {
  title: string;
  prompt: string; // may be '' ONLY when insight_id is set
  schedule_kind: ScheduleKind; // 'daily' | 'weekly' | 'monthly' | 'cron'
  schedule_spec: Record<string, unknown>;
  timezone: string;
  agent_name?: string | null;
  priority?: number;
  enabled?: boolean;
  insight_id?: string | null;
}

export type UpdateRoutineInput = Partial<CreateRoutineInput>;

function isPgUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  if (e.code === '23505' || e.cause?.code === '23505') return true;
  if (
    typeof e.message === 'string' &&
    (e.message.includes('unique constraint') ||
      e.message.includes('duplicate key') ||
      e.message.includes('23505') ||
      e.message.includes('uq_routines_active_insight'))
  ) {
    return true;
  }
  return false;
}

export class RoutineService {
  constructor(
    private readonly routinesRepo: RoutinesRepository,
    private readonly insightRepo: InsightRepository,
    private readonly workspaceId: string,
    // Injectable so the deprecated-agent refusal can be tested against a
    // fixture; the shipped registry has no deprecated agent.
    private readonly sectorRegistry: Pick<SectorRegistry, 'getSectorAgent'> = {
      getSectorAgent,
    },
    // Only runInsightRefreshNow enqueues; the container binds it to the db.
    private readonly enqueueRun: RefreshRunEnqueuer | null = null,
  ) {}

  /**
   * Refresh an insight now — the CoPilot "Refresh this insight now" card
   * (MB-552 AC3). One path whether or not the insight has a refresh routine:
   *   - with an active routine: exactly what force-run does — the routine's
   *     prompt and agent via prepareManualRun (so a routine the system paused
   *     for a deprecated or incompatible agent, or one bound to a deprecated
   *     agent the sweep hasn't reached, is refused with 409), queued with the
   *     routine as its origin;
   *   - without one: a one-off refresh run carrying `input.insight_id`, the
   *     resolved `input.agent_key` and the `insight_refresh` flag, so runAgent
   *     runs it as a refresh and publishes it through MB-558. A deprecated
   *     binding is refused the same way.
   * Active-run guard: when a refresh of this insight is already queued or
   * running (routine or one-off), no second run is added — the live run's id
   * comes back with `created: false`.
   */
  async runInsightRefreshNow(
    insightId: string,
    userId: string,
  ): Promise<InsightRefreshNowResult> {
    if (!this.enqueueRun) {
      throw new Error('RoutineService was built without an enqueuer');
    }
    const insight = await this.insightRepo.findById(insightId, this.workspaceId);
    if (!insight || insight.archived_at) {
      throw new RoutineInsightNotFoundError(
        `Insight ${insightId} not found in workspace ${this.workspaceId}`,
      );
    }

    const routine = await this.routinesRepo.findActiveByInsightId(insightId);
    if (routine) {
      // Refusals first: a paused routine is refused even while a run is live.
      const plan = await this.prepareManualRun(routine.id);
      const live = await this.routinesRepo.findActiveInsightRefreshRunId(insightId);
      if (live) return { runId: live, created: false, routineId: routine.id };

      const { triggerMeta, input } = buildRoutineRunPayload(plan.routine, {
        insightName: plan.insightName,
        agentKey: plan.agentKey,
        baseTriggerMeta: {
          routine_id: plan.routine.id,
          manual: true,
          fired_at: new Date().toISOString(),
        },
      });
      const { runId, created } = await this.enqueueRun({
        agentName: plan.routine.agent_name ?? DEFAULT_ROUTINE_AGENT,
        triggerSource: 'api',
        triggerMeta,
        input,
        priority: plan.routine.priority,
        originRoutineId: plan.routine.id,
        triggeredByUserId: userId,
      });
      return { runId, created, routineId: plan.routine.id };
    }

    const boundKey = insight.agent_key ?? null;
    if (boundKey && this.sectorRegistry.getSectorAgent(boundKey)?.deprecated) {
      throw new RoutineAgentPausedError(
        'agent_deprecated',
        describeRoutinePause('agent_deprecated', boundKey) ?? 'Paused',
      );
    }
    const live = await this.routinesRepo.findActiveInsightRefreshRunId(insightId);
    if (live) return { runId: live, created: false, routineId: null };

    const { triggerMeta, input } = buildOneOffRefreshRunPayload({
      insightId,
      insightName: insight.name ?? null,
      agentKey: resolveRefreshAgentKey(boundKey),
      firedAt: new Date().toISOString(),
    });
    const { runId, created } = await this.enqueueRun({
      agentName: DEFAULT_ROUTINE_AGENT,
      triggerSource: 'api',
      triggerMeta,
      input,
      originRoutineId: null,
      triggeredByUserId: userId,
    });
    return { runId, created, routineId: null };
  }

  async create(input: CreateRoutineInput, userId: string): Promise<RoutineRow> {
    const trimmedPrompt = input.prompt ? input.prompt.trim() : '';
    if (trimmedPrompt === '' && !input.insight_id) {
      throw new RoutineValidationError(
        'Prompt cannot be empty for a routine without an insight',
      );
    }

    if (input.insight_id) {
      const insight = await this.insightRepo.findById(
        input.insight_id,
        this.workspaceId,
      );
      if (!insight) {
        throw new RoutineInsightNotFoundError(
          `Insight ${input.insight_id} not found in workspace ${this.workspaceId}`,
        );
      }
      const existingActive = await this.routinesRepo.findActiveByInsightId(
        input.insight_id,
      );
      if (existingActive) {
        throw new DuplicateInsightRoutineError(input.insight_id);
      }
    }

    let normalized: NormalizedSchedule;
    try {
      normalized = normalizeSchedule(input.schedule_kind, input.schedule_spec);
    } catch (err: unknown) {
      throw new RoutineValidationError(
        err instanceof Error ? err.message : 'Invalid schedule configuration',
      );
    }

    let nextFireAt: string;
    try {
      nextFireAt = computeNextFireAt(
        normalized.cronExpression,
        input.timezone,
        new Date(),
        {
          kind: input.schedule_kind,
          spec: normalized.scheduleSpec,
        },
      );
    } catch (err: unknown) {
      throw new RoutineValidationError(
        err instanceof Error
          ? err.message
          : 'Invalid schedule timezone or cron configuration',
      );
    }

    try {
      return await this.routinesRepo.create({
        title: input.title,
        prompt: input.prompt,
        schedule_kind: input.schedule_kind,
        schedule_spec: normalized.scheduleSpec,
        cron_expression: normalized.cronExpression,
        timezone: input.timezone,
        agent_name: input.agent_name ?? null,
        priority: input.priority ?? 0,
        enabled: input.enabled ?? true,
        next_fire_at: nextFireAt,
        created_by: userId,
        insight_id: input.insight_id ?? null,
      });
    } catch (err: unknown) {
      if (isPgUniqueViolation(err)) {
        throw new DuplicateInsightRoutineError(input.insight_id ?? '');
      }
      throw err;
    }
  }

  async update(
    id: string,
    input: UpdateRoutineInput,
    userId: string,
  ): Promise<RoutineRow> {
    const existing = await this.routinesRepo.findById(id);
    if (!existing) {
      throw new RoutineNotFoundError(`Routine ${id} not found`);
    }

    if ((existing as { is_system?: boolean }).is_system) {
      throw new SystemRoutineError('System routines cannot be modified');
    }

    // Switching a system-paused routine back on by hand would leave
    // enabled=true next to a stale reason and fire the broken binding. Only a
    // rebind resumes it (InsightService.setAgentBinding).
    if (input.enabled === true && isRoutinePausedReason(existing.paused_reason)) {
      throw await this.agentPausedError(existing, existing.paused_reason);
    }

    const effectiveInsightId =
      input.insight_id !== undefined ? input.insight_id : existing.insight_id;
    const effectivePrompt =
      input.prompt !== undefined ? input.prompt : existing.prompt;

    const trimmedPrompt = effectivePrompt ? effectivePrompt.trim() : '';
    if (trimmedPrompt === '' && !effectiveInsightId) {
      throw new RoutineValidationError(
        'Prompt cannot be empty for a routine without an insight',
      );
    }

    if (
      input.insight_id !== undefined &&
      input.insight_id !== null &&
      input.insight_id !== existing.insight_id
    ) {
      const insight = await this.insightRepo.findById(
        input.insight_id,
        this.workspaceId,
      );
      if (!insight) {
        throw new RoutineInsightNotFoundError(
          `Insight ${input.insight_id} not found in workspace ${this.workspaceId}`,
        );
      }
      const active = await this.routinesRepo.findActiveByInsightId(
        input.insight_id,
      );
      if (active && active.id !== id) {
        throw new DuplicateInsightRoutineError(input.insight_id);
      }
    }

    const patch: RoutineUpdate = { updated_by: userId };
    if (input.title !== undefined) patch.title = input.title;
    if (input.prompt !== undefined) patch.prompt = input.prompt;
    if (input.agent_name !== undefined) patch.agent_name = input.agent_name;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.timezone !== undefined) patch.timezone = input.timezone;
    if (input.insight_id !== undefined) patch.insight_id = input.insight_id;

    if (input.schedule_kind && input.schedule_spec) {
      let normalized: NormalizedSchedule;
      try {
        normalized = normalizeSchedule(
          input.schedule_kind,
          input.schedule_spec,
        );
      } catch (err: unknown) {
        throw new RoutineValidationError(
          err instanceof Error ? err.message : 'Invalid schedule configuration',
        );
      }
      patch.schedule_kind = input.schedule_kind;
      patch.schedule_spec = normalized.scheduleSpec;
      patch.cron_expression = normalized.cronExpression;
      const targetTimezone = input.timezone ?? existing.timezone;
      try {
        patch.next_fire_at = computeNextFireAt(
          normalized.cronExpression,
          targetTimezone,
          new Date(),
          {
            kind: input.schedule_kind,
            spec: normalized.scheduleSpec,
          },
        );
      } catch (err: unknown) {
        throw new RoutineValidationError(
          err instanceof Error
            ? err.message
            : 'Invalid schedule timezone or cron configuration',
        );
      }
    } else if (input.timezone !== undefined) {
      // Timezone-only change still moves the next fire instant. Preserve the
      // existing schedule kind+spec so monthly clamping stays consistent.
      try {
        patch.next_fire_at = computeNextFireAt(
          existing.cron_expression,
          input.timezone,
          new Date(),
          {
            kind: existing.schedule_kind as ScheduleKind,
            spec: existing.schedule_spec as Record<string, unknown>,
          },
        );
      } catch (err: unknown) {
        throw new RoutineValidationError(
          err instanceof Error ? err.message : 'Invalid timezone configuration',
        );
      }
    } else if (existing.enabled === false && input.enabled === true) {
      // When resuming a paused routine without changing its schedule, recompute
      // next_fire_at from now so a long-paused routine doesn't fire a stale catch-up
      // the moment it resumes.
      patch.next_fire_at = computeNextFireAt(
        existing.cron_expression,
        existing.timezone,
        new Date(),
        {
          kind: existing.schedule_kind as ScheduleKind,
          spec: existing.schedule_spec as Record<string, unknown>,
        },
      );
    }

    try {
      return await this.routinesRepo.update(id, patch);
    } catch (err: unknown) {
      if (isPgUniqueViolation(err)) {
        throw new DuplicateInsightRoutineError(effectiveInsightId ?? '');
      }
      throw err;
    }
  }

  /**
   * Everything the "Run now" / "Add to current queue" route needs, read the way
   * the fire tick reads it: the routine, its insight's name, and the agent the
   * run will run on, resolved now from the insight's binding (MB-560).
   *
   * Refuses a routine the system paused for a broken binding, and a refresh
   * routine whose agent is deprecated but not yet swept (the fire tick pauses
   * it within a minute) — force-running either would run the broken binding.
   */
  async prepareManualRun(id: string): Promise<ManualRunPlan> {
    const routine = await this.routinesRepo.findById(id);
    if (!routine) {
      throw new RoutineNotFoundError(`Routine ${id} not found`);
    }
    if (isRoutinePausedReason(routine.paused_reason)) {
      throw await this.agentPausedError(routine, routine.paused_reason);
    }
    if (!routine.insight_id) {
      return { routine, insightName: null, agentKey: null };
    }

    const insight = await this.insightRepo.findById(
      routine.insight_id,
      this.workspaceId,
    );
    const boundKey = insight?.agent_key ?? null;
    if (boundKey && this.sectorRegistry.getSectorAgent(boundKey)?.deprecated) {
      throw new RoutineAgentPausedError(
        'agent_deprecated',
        describeRoutinePause('agent_deprecated', boundKey) ?? 'Paused',
      );
    }
    return {
      routine,
      insightName: insight?.name ?? null,
      agentKey: resolveRefreshAgentKey(boundKey),
    };
  }

  private async agentPausedError(
    routine: RoutineRow,
    reason: RoutinePausedReason,
  ): Promise<RoutineAgentPausedError> {
    const insight = routine.insight_id
      ? await this.insightRepo.findById(routine.insight_id, this.workspaceId)
      : null;
    return new RoutineAgentPausedError(
      reason,
      describeRoutinePause(reason, insight?.agent_key ?? null) ?? 'Paused',
    );
  }

  /** Throws RoutineInsightNotFoundError when the insight is not in this workspace. */
  async getActiveForInsight(insightId: string): Promise<RoutineRow | null> {
    const insight = await this.insightRepo.findById(
      insightId,
      this.workspaceId,
    );
    if (!insight) {
      throw new RoutineInsightNotFoundError(
        `Insight ${insightId} not found in workspace ${this.workspaceId}`,
      );
    }
    return this.routinesRepo.findActiveByInsightId(insightId);
  }
}
