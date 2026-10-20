import { deleteFile } from '@/lib/s3';
import { detectFileKind, isMediaFileKind } from '@/lib/fileType';
import type { DealDocumentRepository, DealLinkRepository, TablesInsert } from '@/lib/repositories';
import { normalizeOccurredAt } from '@/lib/timeline/occurredAt';
import type { JobDispatcher } from './jobDispatcher';
import { assertFeaturableFile } from './featuredSlide';
import {
  runDealDocumentProcessing,
  DEAL_DOCUMENT_PROCESSING_TIMEOUT_SECONDS,
} from '@/lib/jobs/handlers/dealDocumentProcessing';

export class DealDocumentService {
  constructor(
    private readonly dealDocRepo: DealDocumentRepository,
    private readonly dealLinkRepo: DealLinkRepository,
    private readonly jobDispatcher: JobDispatcher,
    private readonly workspaceId: string,
  ) {}

  async register(data: Omit<TablesInsert<'deal_documents'>, 'workspace_id'>) {
    // Only one featured slide per deal — unfeature (not delete) whichever
    // document currently holds it, since that document may be a regular
    // attachment the user still wants around.
    if (data.is_featured) {
      assertFeaturableFile(data.file_name);
      await this.clearFeaturedSlide(data.deal_id);
    }

    // The timeline composer may backdate an upload to when the file was
    // actually received; without one, the column default stamps "now".
    const { created_at: rawCreatedAt, ...rest } = data;
    const created_at = normalizeOccurredAt(rawCreatedAt);

    // A video or audio recording has no text to extract, and the processing
    // job would pull the whole (often very large) file into memory to find
    // that out. Store it as `skipped` so nothing polls for insights either.
    if (isMediaFileKind(detectFileKind(data.file_name))) {
      return this.dealDocRepo.insert({
        ...rest,
        ...(created_at ? { created_at } : {}),
        processing_status: 'skipped',
      });
    }

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
    assertFeaturableFile(row.file_name);
    await this.clearFeaturedSlide(dealId);
    await this.dealDocRepo.updatePartial(documentId, { is_featured: true });
  }

  /**
   * Unfeatures the deal's current featured slide — a document or a YouTube
   * link — leaving the file or link itself in place.
   */
  async clearFeatured(dealId: string) {
    await this.clearFeaturedSlide(dealId);
  }

  async delete(id: string) {
    const row = await this.dealDocRepo.findById(id);
    await deleteFile(row.file_path);
    await this.dealDocRepo.delete(id);
  }

  /** The featured slide is one item across documents and links — clear both. */
  private async clearFeaturedSlide(dealId: string) {
    await this.dealDocRepo.clearFeaturedByDealId(dealId);
    await this.dealLinkRepo.clearFeaturedByDealId(dealId);
  }
}
