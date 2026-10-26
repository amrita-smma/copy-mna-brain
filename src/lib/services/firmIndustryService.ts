import type { EmployerRepository } from '@/lib/repositories';
import type { JobDispatcher } from './jobDispatcher';

/** Firms one sweep claims per workspace; the next hourly sweep takes the rest. */
export const FIRM_INDUSTRY_PER_SWEEP = 60;

/** How long a firm the model could not place waits before it is tried again. */
export const FIRM_INDUSTRY_RETRY_DAYS = 14;

const FIRM_INDUSTRY_TIMEOUT_SECONDS = 240;

export interface FirmIndustrySweepResult {
  claimed: number;
  jobId: string | null;
}

/**
 * Fills in the Industry of CRM firms that ingest created without one. Ingest
 * never knows a firm's industry, so an hourly sweep labels the firms visible
 * in a workspace whose industry is still empty, from their name, domains and
 * contacts' titles. The label goes on the shared firm row; a workspace's own
 * edit stays on its curation overlay and wins.
 */
export class FirmIndustryService {
  constructor(
    private readonly employerRepo: EmployerRepository,
    private readonly jobDispatcher: JobDispatcher,
    private readonly workspaceId: string,
  ) {}

  /** Claim up to {@link FIRM_INDUSTRY_PER_SWEEP} unlabelled firms and queue one job for them. */
  async classifyUnlabelledFirms(now: Date = new Date()): Promise<FirmIndustrySweepResult> {
    const retryBefore = new Date(
      now.getTime() - FIRM_INDUSTRY_RETRY_DAYS * 86_400_000,
    ).toISOString();
    const employerIds = await this.employerRepo.claimForIndustryClassification(
      this.workspaceId,
      retryBefore,
      FIRM_INDUSTRY_PER_SWEEP,
    );
    if (employerIds.length === 0) return { claimed: 0, jobId: null };

    const workspaceId = this.workspaceId;
    const { runFirmIndustryClassification } = await import(
      '@/lib/jobs/handlers/firmIndustryClassification'
    );
    const { jobId } = await this.jobDispatcher.dispatch({
      type: 'firm_industry_classification',
      payload: { employerIds, workspaceId },
      timeoutSeconds: FIRM_INDUSTRY_TIMEOUT_SECONDS,
      work: ({ job, db }) =>
        runFirmIndustryClassification({ employerIds, workspaceId, jobId: job.id }, { db }),
    });
    return { claimed: employerIds.length, jobId };
  }
}
