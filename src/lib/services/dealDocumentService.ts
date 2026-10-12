import { deleteFile } from '@/lib/s3';
import { detectFileKind } from '@/lib/fileType';
import type { DealDocumentRepository, TablesInsert } from '@/lib/repositories';
import { normalizeOccurredAt } from '@/lib/timeline/occurredAt';
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
    // Only one featured slide per deal — unfeature (not delete) whichever
    // document currently holds it, since that document may be a regular
    // attachment the user still wants around.
    if (data.is_featured) {
      assertFeaturedSlideKind(data.file_name);
      await this.dealDocRepo.clearFeaturedByDealId(data.deal_id);
    }

    // The timeline composer may backdate an upload to when the file was
    // actually received; without one, the column default stamps "now".
    const { created_at: rawCreatedAt, ...rest } = data;
    const created_at = normalizeOccurredAt(rawCreatedAt);

    const row = await this.dealDocRepo.insert(created_at ? { ...rest, created_at } : rest);

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

  /** Features an already-uploaded attachment instead of uploading a new file. */
  async setFeatured(dealId: string, documentId: string) {
    const row = await this.dealDocRepo.findById(documentId);
    if (row.deal_id !== dealId) {
      throw new Error('Document does not belong to this deal');
    }
    assertFeaturedSlideKind(row.file_name);
    await this.dealDocRepo.clearFeaturedByDealId(dealId);
    await this.dealDocRepo.updatePartial(documentId, { is_featured: true });
  }

  /** Unfeatures the deal's current featured slide, leaving the file itself in place. */
  async clearFeatured(dealId: string) {
    await this.dealDocRepo.clearFeaturedByDealId(dealId);
  }

  async delete(id: string) {
    const row = await this.dealDocRepo.findById(id);
    await deleteFile(row.file_path);
    await this.dealDocRepo.delete(id);
  }
}

function assertFeaturedSlideKind(fileName: string) {
  const kind = detectFileKind(fileName);
  if (kind !== 'pdf' && kind !== 'pptx') {
    throw new Error('Only PDF or PPTX files can be featured');
  }
}
