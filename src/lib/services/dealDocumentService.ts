import { deleteFile } from '@/lib/s3';
import type { DealDocumentRepository, TablesInsert } from '@/lib/repositories';
import type { JobDispatcher } from './jobDispatcher';
import {
  runDealDocumentProcessing,
  DEAL_DOCUMENT_PROCESSING_TIMEOUT_SECONDS,
} from '@/lib/jobs/handlers/dealDocumentProcessing';

export class DealDocumentService {
  constructor(
    private readonly dealDocRepo: DealDocumentRepository,
    private readonly jobDispatcher: JobDispatcher,
    private readonly workspaceId: string,
  ) {}

  async register(data: Omit<TablesInsert<'deal_documents'>, 'workspace_id'>) {
    const row = await this.dealDocRepo.insert(data);

    await this.jobDispatcher.dispatch({
      type: 'deal_document_processing',
      payload: { dealDocumentId: row.id, workspaceId: this.workspaceId, contentType: row.mime_type },
      timeoutSeconds: DEAL_DOCUMENT_PROCESSING_TIMEOUT_SECONDS,
      work: (ctx) =>
        runDealDocumentProcessing(
          { dealDocumentId: row.id, workspaceId: this.workspaceId, contentType: row.mime_type ?? undefined },
          { db: ctx.db, job: ctx.job },
        ),
    });

    return row;
  }

  async delete(id: string) {
    const row = await this.dealDocRepo.findById(id);
    await deleteFile(row.file_path);
    await this.dealDocRepo.delete(id);
  }
}
