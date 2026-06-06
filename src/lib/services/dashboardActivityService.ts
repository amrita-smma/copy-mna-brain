import type { DashboardActivityRepository } from '@/lib/repositories/dashboardActivityRepository';

export type NewL0Company = Awaited<ReturnType<DashboardActivityRepository['getNewL0Companies']>>[number];
export type AiSourcedCompany = Awaited<ReturnType<DashboardActivityRepository['getAiSourcedCompanies']>>[number];
export type PipelineMove = Awaited<ReturnType<DashboardActivityRepository['getPipelineMoves']>>[number];
export type SlideGenerated = Awaited<ReturnType<DashboardActivityRepository['getSlidesGenerated']>>[number];
export type DroppedDeal = Awaited<ReturnType<DashboardActivityRepository['getDroppedDeals']>>[number];
export type WorkforceJob = Awaited<ReturnType<DashboardActivityRepository['getWorkforceJobs']>>[number];
export type NewContact = Awaited<ReturnType<DashboardActivityRepository['getNewContacts']>>[number];
export type NoteUpdated = Awaited<ReturnType<DashboardActivityRepository['getNotesUpdated']>>[number];

export interface DashboardActivity {
  newL0Companies: NewL0Company[];
  aiSourcedCompanies: AiSourcedCompany[];
  pipelineMoves: PipelineMove[];
  slidesGenerated: SlideGenerated[];
  droppedDeals: DroppedDeal[];
  workforceJobs: WorkforceJob[];
  newContacts: NewContact[];
  notesUpdated: NoteUpdated[];
}

export class DashboardActivityService {
  constructor(private repo: DashboardActivityRepository) {}

  async getActivity(from: Date, to: Date): Promise<DashboardActivity> {
    const [
      newL0Companies,
      aiSourcedCompanies,
      pipelineMoves,
      slidesGenerated,
      droppedDeals,
      workforceJobs,
      newContacts,
      notesUpdated,
    ] = await Promise.all([
      this.repo.getNewL0Companies(from, to),
      this.repo.getAiSourcedCompanies(from, to),
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
      pipelineMoves,
      slidesGenerated,
      droppedDeals,
      workforceJobs,
      newContacts,
      notesUpdated,
    };
  }
}
