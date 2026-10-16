import {
  AiWorkforceQueueRepository,
  isTerminalWorkforceStatus,
  type CorrespondentRepository,
  type DbClient,
  type EmployerRepository,
  type WorkforceQueueRow,
} from '@/lib/repositories';
import {
  CRM_CONTACT_AGENT_NAME,
  missingProfileFields,
} from '@/lib/agents/crm_contact/constants';
import {
  buildContactEnrichmentPrompt,
  buildContactEnrichmentTitle,
} from '@/lib/agents/crm_contact/prompt';
import { enqueueAgentRun } from '@/lib/workforce';

export { CRM_CONTACT_AGENT_NAME } from '@/lib/agents/crm_contact/constants';

/** What the UI needs to render the fill-contact button's state. */
export interface ContactEnrichmentRun {
  runId: string;
  status: WorkforceQueueRow['status'];
  /** False once the run reaches a terminal status — stop polling. */
  active: boolean;
  /** Terminal failure message, when the run ended badly. */
  error: string | null;
  startedAt: string;
}

export class ContactNotFoundError extends Error {
  constructor(correspondentId: string) {
    super(`Correspondent ${correspondentId} not found in this workspace`);
    this.name = 'ContactNotFoundError';
  }
}

/**
 * Drives @crm_contact from the CRM UI: one button, one AI Workforce run, one
 * contact's profile filled in.
 *
 * Only two modules import the agent, and both import its import-free
 * `constants` / `prompt` files rather than its `index` — pulling the graph in
 * here would drag LangChain into `createContainer`, which every API route
 * builds on every request.
 *
 * Why the Workforce rather than running the agent inline (the way the memory
 * import route does): web research takes minutes, not the seconds a request
 * can hold. The queue already owns long work — heartbeats, the 30-minute
 * reaper, cancellation, the trace panel and the task list — so the button
 * returns a run id immediately and the user can close the CRM page and watch
 * it from `/ai-workforce` instead.
 */
export class CrmContactEnrichmentService {
  constructor(
    private readonly correspondentRepo: CorrespondentRepository,
    private readonly employerRepo: EmployerRepository,
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  /**
   * Queue a run that fills this contact's empty profile fields.
   *
   * Idempotent on an in-flight run: a double-click, or a second user on the
   * same firm, joins the run already going rather than stacking a duplicate
   * that would race it to the same overlay row. That check is a read before a
   * write, so it is backed by a per-minute `idempotency_key` — unique
   * table-wide — that collapses genuinely concurrent requests at the index.
   * The key is bucketed rather than permanent so a deliberate re-run later
   * still gets its own row.
   */
  async enrich(
    correspondentId: string,
    opts: { triggeredByUserId?: string | null } = {},
  ): Promise<{ run: ContactEnrichmentRun; created: boolean }> {
    const queueRepo = new AiWorkforceQueueRepository(this.db, this.workspaceId);
    const existing = await queueRepo.findLatestByCorrespondentId(
      CRM_CONTACT_AGENT_NAME,
      correspondentId,
    );
    if (existing && !isTerminalWorkforceStatus(existing.status)) {
      return { run: toContactEnrichmentRun(existing), created: false };
    }

    const contact = await this.correspondentRepo.findById(
      correspondentId,
      this.workspaceId,
    );
    if (!contact) throw new ContactNotFoundError(correspondentId);

    const employer = await this.employerRepo.findById(contact.employer_id);
    const employerName = employer?.name ?? 'an unknown firm';
    const missingFields = missingProfileFields(contact);

    const prompt = buildContactEnrichmentPrompt({
      correspondentId,
      contactName: contact.name,
      employerName,
      missingFields,
    });

    const enqueue = (idempotencyKey: string | null) =>
      enqueueAgentRun(this.db, {
        agentName: CRM_CONTACT_AGENT_NAME,
        triggerSource: 'api',
        // `correspondent_id` is what findLatestByCorrespondentId matches on —
        // it has to be in trigger_meta, not only in the prompt text.
        triggerMeta: {
          correspondent_id: correspondentId,
          employer_id: contact.employer_id,
        },
        input: {
          title: buildContactEnrichmentTitle(contact.name, employerName),
          prompt,
          instruction: prompt,
          correspondent_id: correspondentId,
        },
        triggeredByUserId: opts.triggeredByUserId ?? null,
        idempotencyKey,
      });

    let { runId, created } = await enqueue(
      CrmContactEnrichmentService.idempotencyKey(correspondentId),
    );
    let row = await queueRepo.findById(runId);

    // The key collapsed onto a run that has already finished — which happens
    // when someone re-runs within the same minute bucket, including straight
    // after cancelling. The caller established above that nothing is in
    // flight, so honour the request with a plain keyless insert rather than
    // handing back a dead row and doing no work.
    if (!created && row && isTerminalWorkforceStatus(row.status)) {
      ({ runId, created } = await enqueue(null));
      row = await queueRepo.findById(runId);
    }

    // The row was just inserted (or collapsed onto a live one); a miss here
    // means it is not readable in this workspace, which is a bug worth
    // surfacing rather than a state the caller can act on.
    if (!row) throw new Error(`enrich: queue row ${runId} is not readable`);
    return { run: toContactEnrichmentRun(row), created };
  }

  /**
   * The latest enrichment run for this contact, for the button to poll.
   * `null` when the contact has never been enriched.
   */
  async latestRun(correspondentId: string): Promise<ContactEnrichmentRun | null> {
    const queueRepo = new AiWorkforceQueueRepository(this.db, this.workspaceId);
    const row = await queueRepo.findLatestByCorrespondentId(
      CRM_CONTACT_AGENT_NAME,
      correspondentId,
    );
    return row ? toContactEnrichmentRun(row) : null;
  }

  /**
   * Every contact of one employer, mapped to its latest enrichment run.
   * Contacts that have never been enriched are simply absent from the map.
   *
   * This is what the contacts tab loads once on open. The per-contact
   * {@link latestRun} exists for the single button that is already polling;
   * rendering a tab must never call it in a loop, which would be one HTTP
   * request and one query per row.
   */
  async latestRunsForEmployer(
    employerId: string,
  ): Promise<Record<string, ContactEnrichmentRun>> {
    const contacts = await this.correspondentRepo.findByEmployerId(
      employerId,
      this.workspaceId,
    );
    if (contacts.length === 0) return {};
    const queueRepo = new AiWorkforceQueueRepository(this.db, this.workspaceId);
    const rows = await queueRepo.findLatestByCorrespondentIds(
      CRM_CONTACT_AGENT_NAME,
      contacts.map((c) => c.id),
    );
    const byContact: Record<string, ContactEnrichmentRun> = {};
    for (const row of rows) {
      const id = row.trigger_meta?.correspondent_id;
      if (typeof id === 'string') byContact[id] = toContactEnrichmentRun(row);
    }
    return byContact;
  }

  /**
   * Per-minute idempotency key. `ai_workforce_queue.idempotency_key` is unique
   * table-wide and forever, so bucketing by minute is what keeps a deliberate
   * re-run from colliding with a run that finished an hour ago.
   */
  private static idempotencyKey(correspondentId: string): string {
    const minuteBucket = Math.floor(Date.now() / 60_000);
    return `${CRM_CONTACT_AGENT_NAME}:${correspondentId}:${minuteBucket}`;
  }
}

/** Map a queue row to what a run-watching button needs. */
export function toContactEnrichmentRun(row: WorkforceQueueRow): ContactEnrichmentRun {
  const error =
    row.error && typeof row.error === 'object' && typeof row.error.message === 'string'
      ? row.error.message
      : null;
  return {
    runId: row.id,
    status: row.status,
    active: !isTerminalWorkforceStatus(row.status),
    error,
    startedAt: row.created_at,
  };
}
