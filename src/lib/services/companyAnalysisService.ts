import type { CompanyAnalysisRepository, CompanyRepository } from '@/lib/repositories';
import type { Tables } from '@/lib/repositories';
import type { DbClient } from '@/lib/repositories';
import { AiWorkforceQueueRepository, isTerminalWorkforceStatus } from '@/lib/repositories';
import type { CompanyAnalysisPayload, RelatedCompany } from '@/lib/jobs/handlers/companyAnalysis';
import { enqueueAgentRun } from '@/lib/workforce';

/** agent_name recorded on the AI Workforce queue row for card-generation runs. */
export const COMPANY_CARD_AGENT_NAME = 'company_card';

/** Card run statuses that have not started executing yet. */
const QUEUED_CARD_STATUSES = new Set<string>(['pending', 'resume_ready']);

export class CompanyAnalysisService {
  constructor(
    private readonly companyAnalysisRepo: CompanyAnalysisRepository,
    private readonly companyRepo: CompanyRepository,
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  findByCompanyId(companyId: string) {
    return this.companyAnalysisRepo.findByCompanyId(companyId);
  }

  /**
   * Enqueue an AI Workforce run that drives `generate_company_card`.
   *
   * Shared by first-time generation and regeneration; `extraInstruction` is
   * appended so a regeneration can tell the agent why it is running.
   */
  private async enqueueCardRun(
    companyId: string,
    opts: {
      source?: string | null;
      reason?: string | null;
      extraInstruction?: string | null;
      triggeredByUserId?: string | null;
      idempotencyKey?: string | null;
      /** Pre-resolved display name, so a batched caller doesn't re-read the row. */
      companyName?: string | null;
    },
  ): Promise<{ runId: string; created: boolean }> {
    let companyName = opts.companyName ?? null;
    if (!companyName) {
      const company = await this.companyRepo.findById(companyId);
      companyName = company?.target || company?.project_name || 'the company';
    }

    const instruction =
      `Generate the AI Company Card for "${companyName}" (company_id: ${companyId}). ` +
      `Call the generate_company_card tool with company_id "${companyId}". ` +
      `It researches the company, produces and saves the structured Company Card, and links the company's ` +
      `related companies (suppliers, partners, investors) into the relationship graph — creating any unknown ` +
      `company at the "discovered" stage. After it returns, briefly summarise what was produced and which ` +
      `related companies were linked.` +
      (opts.extraInstruction ? ` ${opts.extraInstruction}` : '');

    return enqueueAgentRun(this.db, {
      agentName: COMPANY_CARD_AGENT_NAME,
      triggerSource: 'api',
      triggerMeta: {
        company_id: companyId,
        source: opts.source ?? null,
        reason: opts.reason ?? null,
      },
      input: {
        title: opts.reason
          ? `Company card refresh: ${companyName}`
          : `Company card: ${companyName}`,
        instruction,
        prompt: instruction,
        company_id: companyId,
      },
      triggeredByUserId: opts.triggeredByUserId ?? null,
      idempotencyKey: opts.idempotencyKey ?? null,
    });
  }

  /**
   * Idempotency key that collapses a burst of regeneration requests for the
   * same company into a single queue row.
   *
   * `findActiveByCompanyId` catches the common case (a run is already queued or
   * executing) but is a read-then-write, so two concurrent stage moves can both
   * pass it. `ai_workforce_queue.idempotency_key` is uniquely indexed, so a
   * shared key makes the second insert a no-op at the database level. The key
   * is bucketed per minute: near-simultaneous moves collapse, while a genuine
   * refresh requested later still gets its own run.
   */
  private static regenerationIdempotencyKey(companyId: string): string {
    const minuteBucket = Math.floor(Date.now() / 60_000);
    return `${COMPANY_CARD_AGENT_NAME}:regen:${companyId}:${minuteBucket}`;
  }

  /**
   * Enqueue a regeneration under the per-minute key, but only let it collapse
   * onto a run that is still alive.
   *
   * `idempotency_key` is unique table-wide and for all time, so a run that has
   * already reached a terminal state still owns its minute's key. Cancelling a
   * card run marks it `failed`, so without this a user who cancels and
   * immediately retries would get a 202 pointing at the dead row and no work
   * would ever be done. When the key collapses onto a terminal run we retry
   * with no key at all — the caller has already established that nothing is in
   * flight, so a plain insert is what it asked for.
   */
  private async enqueueRegeneration(
    companyId: string,
    queueRepo: AiWorkforceQueueRepository,
    opts: {
      source?: string | null;
      reason: string | null;
      companyName?: string | null;
      triggeredByUserId?: string | null;
    },
  ): Promise<{ runId: string }> {
    const args = {
      source: opts.source ?? null,
      reason: opts.reason,
      companyName: opts.companyName ?? null,
      extraInstruction: CompanyAnalysisService.regenerationInstruction(opts.reason),
      triggeredByUserId: opts.triggeredByUserId ?? null,
    };

    const first = await this.enqueueCardRun(companyId, {
      ...args,
      idempotencyKey: CompanyAnalysisService.regenerationIdempotencyKey(companyId),
    });
    if (first.created) return { runId: first.runId };

    const existing = await queueRepo.findById(first.runId);
    if (existing && !isTerminalWorkforceStatus(existing.status)) {
      // A concurrent request won the key and its run is still live — reuse it.
      return { runId: first.runId };
    }

    const retried = await this.enqueueCardRun(companyId, { ...args, idempotencyKey: null });
    return { runId: retried.runId };
  }

  /**
   * Batched {@link regenerate} for a bulk stage move.
   *
   * One query resolves which companies already have a run in flight and one
   * more resolves their display names, so a 50-deal promote does not fire two
   * reads per deal (the per-id-lookup-in-a-loop pattern CLAUDE.md forbids).
   * The enqueue itself is inherently per-company — each needs its own queue row
   * — and is awaited sequentially so a large bulk move doesn't open a
   * connection per deal.
   */
  async regenerateMany(
    companyIds: string[],
    opts?: {
      /** Per-company reason, keyed by company id. */
      reasonById?: Map<string, string | null>;
      source?: string | null;
      triggeredByUserId?: string | null;
    },
  ): Promise<{ enqueued: string[]; skipped: string[] }> {
    const ids = [...new Set(companyIds)];
    if (ids.length === 0) return { enqueued: [], skipped: [] };

    const queueRepo = new AiWorkforceQueueRepository(this.db, this.workspaceId);
    const [active, names] = await Promise.all([
      queueRepo.findActiveCompanyIds(COMPANY_CARD_AGENT_NAME, ids),
      this.companyRepo.findIdAndNameByIds(ids),
    ]);
    const nameById = new Map(
      names.map((n) => [n.id, n.target || n.project_name || 'the company']),
    );

    const enqueued: string[] = [];
    const skipped: string[] = [];
    for (const companyId of ids) {
      if (active.has(companyId)) {
        skipped.push(companyId);
        continue;
      }
      const reason = opts?.reasonById?.get(companyId)?.trim() || null;
      await this.enqueueRegeneration(companyId, queueRepo, {
        source: opts?.source ?? null,
        reason,
        // Explicit fallback, never null: a null name would send enqueueCardRun
        // back to a per-id findById and reintroduce the fan-out this method
        // exists to avoid. A miss here means the row isn't in this workspace.
        companyName: nameById.get(companyId) ?? 'the company',
        triggeredByUserId: opts?.triggeredByUserId ?? null,
      });
      enqueued.push(companyId);
    }
    return { enqueued, skipped };
  }

  /** Shared regeneration addendum: what the agent must do differently on a refresh. */
  private static regenerationInstruction(reason: string | null): string {
    return (
      `This is a REGENERATION of an existing card${reason ? ` (${reason})` : ''}. ` +
      `Refresh it against the latest information, including the company's uploaded files and deal ` +
      `documents. The prompt lists the date the previous card was generated alongside each document's ` +
      `date — where a document and the existing card disagree, the later-dated source wins.`
    );
  }

  /**
   * Force a fresh Company Card run even when a completed card already exists.
   *
   * Unlike {@link dispatch} this is *not* idempotent on a completed card — that
   * is the point: a stage move (or an explicit "Regenerate") must re-research
   * the company and pick up anything that landed since the card was written.
   *
   * The existing `company_analyses` row is deliberately left in place. It
   * carries `created_at` (re-stamped by each completed run) and the current
   * card text, and the generation
   * handler reads both to date-rank the card against the company's documents:
   * on a conflict the later-dated source wins. Deleting the row first would
   * throw that comparison away.
   *
   * Still idempotent on an *in-flight* run: if a card run is already queued or
   * executing for this company we leave it alone rather than stacking a
   * duplicate. That check is a read-then-write, so it is backed by a
   * per-minute idempotency key (see {@link enqueueRegeneration}) that collapses
   * concurrent requests at the unique index — while never collapsing onto a run
   * that has already finished or been cancelled.
   */
  async regenerate(
    companyId: string,
    opts?: {
      reason?: string | null;
      source?: string | null;
      triggeredByUserId?: string | null;
    },
  ): Promise<{ runId: string } | { skipped: 'already_running' }> {
    const queueRepo = new AiWorkforceQueueRepository(this.db, this.workspaceId);
    const active = await queueRepo.findActiveByCompanyId(COMPANY_CARD_AGENT_NAME, companyId);
    if (active) return { skipped: 'already_running' };

    const reason = opts?.reason?.trim() || null;
    return this.enqueueRegeneration(companyId, queueRepo, {
      source: opts?.source ?? null,
      reason,
      triggeredByUserId: opts?.triggeredByUserId ?? null,
    });
  }

  /**
   * Generate the AI Company Card via the AI Workforce.
   *
   * Previously a `company_analysis` job; now enqueues a workforce run that
   * drives the `generate_company_card` tool. The tool both persists the card
   * (which the Company Card UI polls for via findByCompanyId) and links the
   * company's related companies into the relationship graph.
   *
   * Idempotent on a *completed* card: if one already exists we return it
   * without enqueueing. Use {@link regenerate} to force a refresh of a card
   * that already exists — it keeps the row so the run can compare the card's
   * `created_at` against the company's documents.
   *
   * `triggeredByUserId` is the logged-in user who clicked "Generate Company
   * Card". It owns the resulting AI Workforce run so the task is attributed to
   * them (not "System") in the UI and the completion email goes to them.
   */
  async dispatch(
    payload: CompanyAnalysisPayload,
    triggeredByUserId?: string | null,
  ): Promise<{ runId: string } | { existing: Tables<'company_analyses'> }> {
    const existing = await this.companyAnalysisRepo.findCompletedByCompanyId(payload.companyId);
    if (existing) return { existing };

    const { runId } = await this.enqueueCardRun(payload.companyId, {
      source: payload.source ?? null,
      triggeredByUserId,
    });

    return { runId };
  }

  /** The subset of `companyIds` that already have a completed Company Card, in one query. */
  findCompanyIdsWithCard(companyIds: string[]): Promise<Set<string>> {
    return this.companyAnalysisRepo.findCompletedCompanyIds(companyIds);
  }

  /**
   * Generate the Company Card right now, inside the caller's run, when the
   * company has never had a completed one — the Pending Confirmation scan's
   * first step, so screening runs against a company that has a card.
   *
   * The AI Workforce runs one task at a time, so a card *queued* from inside a
   * scan could not start until the scan had finished. The card is therefore
   * generated inline; a card run already queued for the company (e.g. by the
   * stage move that brought it into Pending Confirmation) is cancelled as
   * superseded rather than run twice. A run that is already executing is left
   * alone.
   *
   * Returns the related companies the card surfaced; linking them into the
   * relationship graph is the caller's job (`CompanyRelationshipService`).
   */
  async generateNowIfMissing(
    companyId: string,
    opts?: { source?: string | null },
  ): Promise<
    | { status: 'exists' }
    | { status: 'already_running' }
    | { status: 'generated'; companyName: string; relatedCompanies: RelatedCompany[] }
  > {
    const existing = await this.companyAnalysisRepo.findCompletedByCompanyId(companyId);
    if (existing) return { status: 'exists' };

    const queueRepo = new AiWorkforceQueueRepository(this.db, this.workspaceId);
    const active = await queueRepo.findActiveByCompanyId(COMPANY_CARD_AGENT_NAME, companyId);
    if (active) {
      if (!QUEUED_CARD_STATUSES.has(active.status)) return { status: 'already_running' };
      await queueRepo.cancelById(active.id, {
        reason: 'Superseded: the Pending Confirmation scan generated the Company Card first',
      });
    }

    // Resolved lazily to keep this service off the agent/tool import cycle
    // (see TECH_DEBT.md "Runtime import cycle").
    const { generateCompanyCard } = await import('@/lib/jobs/handlers/companyAnalysis');
    const { companyName, relatedCompanies } = await generateCompanyCard(
      { companyId, source: opts?.source ?? undefined },
      { db: this.db, workspaceId: this.workspaceId },
    );
    return { status: 'generated', companyName, relatedCompanies };
  }

  /**
   * Cancel an in-flight Company Card generation for a company.
   *
   * Finds the non-terminal AI Workforce run for this company (matched on
   * trigger_meta.company_id, so it works even when the client doesn't hold the
   * runId — e.g. after a reload) and flips it to a terminal cancelled state.
   * Also clears the `company_analyses` row so the UI resets back to the
   * "Generate AI Company Card" state.
   *
   * Returns whether a running queue row was found and cancelled.
   */
  async cancelDispatch(
    companyId: string,
    cancelledByUserId?: string | null,
  ): Promise<{ cancelled: boolean }> {
    const queueRepo = new AiWorkforceQueueRepository(this.db, this.workspaceId);
    const active = await queueRepo.findActiveByCompanyId(
      COMPANY_CARD_AGENT_NAME,
      companyId,
    );

    let cancelled = false;
    if (active) {
      const row = await queueRepo.cancelById(active.id, {
        userId: cancelledByUserId ?? null,
        reason: 'Company Card generation cancelled by user',
      });
      cancelled = row != null;
    }

    // Drop any in-progress analysis row so the UI returns to the pre-generation
    // state. A completed card is left untouched.
    const existing = await this.companyAnalysisRepo.findByCompanyId(companyId);
    if (existing && existing.status !== 'completed') {
      await this.companyAnalysisRepo.deleteByCompanyId(companyId);
    }

    return { cancelled };
  }

  delete(companyId: string) {
    return this.companyAnalysisRepo.deleteByCompanyId(companyId);
  }
}
