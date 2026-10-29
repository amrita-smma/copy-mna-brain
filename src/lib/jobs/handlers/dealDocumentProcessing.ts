import { downloadFile } from '@/lib/s3';
import { extractTextFromFile } from '@/lib/fileExtractor';
import { processFileContent } from '@/lib/agents/file_processing';
import { DealDocumentRepository, JobRepository } from '@/lib/repositories';
import type { DbClient, Tables } from '@/lib/repositories';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { publishLiveEvent } from '@/lib/server/liveEvents';
import { LIVE_TOPICS } from '@/lib/live/topics';

export const DEAL_DOCUMENT_PROCESSING_TIMEOUT_SECONDS = 180; // 3 minutes

export interface DealDocumentProcessingPayload {
  dealDocumentId: string;
  workspaceId?: string;
  contentType?: string;
}

/**
 * Job handler for deal_document_processing.
 *
 * Runs the same file-processing agent Smart Files uses, but only persists the
 * summary/tags/classification part of its output onto `deal_documents` —
 * an attachment is already scoped to a known company via `deal_id`, so unlike
 * `FileService.processUpload` this never auto-creates/enriches companies or
 * merges financials from the extracted content.
 */
export async function runDealDocumentProcessing(
  payload: DealDocumentProcessingPayload,
  deps: { db: DbClient; job: Tables<'jobs'> },
): Promise<void> {
  const { dealDocumentId } = payload;
  const workspaceId = payload.workspaceId ?? deps.job.workspace_id ?? (await getActiveWorkspaceId());

  const dealDocRepo = new DealDocumentRepository(deps.db, workspaceId);
  const jobRepo = new JobRepository(deps.db);

  const doc = await dealDocRepo.findById(dealDocumentId);

  await dealDocRepo.updatePartial(doc.id, { processing_status: 'processing' });
  await publishLiveEvent(workspaceId, LIVE_TOPICS.documents, [doc.id]);
  await jobRepo.appendLog(deps.job.id, {
    message: 'Starting document analysis',
    metadata: { dealDocumentId: doc.id, fileName: doc.file_name },
  });

  try {
    const buffer = await downloadFile(doc.file_path);
    const contentType = payload.contentType || doc.mime_type || 'application/octet-stream';
    const isPdf = contentType === 'application/pdf' || doc.file_name.toLowerCase().endsWith('.pdf');
    const rawText = isPdf ? '' : await extractTextFromFile(buffer, contentType, doc.file_name);

    const structured = await processFileContent(rawText, buffer, contentType, '', undefined, doc.file_name);

    await dealDocRepo.updatePartial(doc.id, {
      raw_notes: rawText,
      structured_notes: structured ? JSON.stringify(structured, null, 2) : null,
      tags: structured?.tags ?? [],
      processing_status: structured ? 'completed' : 'failed',
    });
    await publishLiveEvent(workspaceId, LIVE_TOPICS.documents, [doc.id]);

    await jobRepo.appendLog(deps.job.id, {
      message: structured ? 'Document analysis completed' : 'Document analysis produced no result',
    });
  } catch (error) {
    await dealDocRepo.updatePartial(doc.id, { processing_status: 'failed' });
    await publishLiveEvent(workspaceId, LIVE_TOPICS.documents, [doc.id]);
    await jobRepo.appendLog(deps.job.id, {
      message: `Document analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      metadata: {
        error: error instanceof Error ? error.stack || error.message : String(error),
      },
    });
    throw error;
  }
}
