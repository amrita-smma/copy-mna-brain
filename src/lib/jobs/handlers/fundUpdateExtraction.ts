import { downloadFile } from '@/lib/s3';
import { FileRepository, FlInvestorRepository, JobRepository } from '@/lib/repositories';
import type { DbClient, Tables } from '@/lib/repositories';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { orchestrateWorkbookFallback } from '@/lib/agents/fund_update_processing/orchestrateFallback';
import type { LLMClientOverride } from '@/lib/agents/fund_update_processing/structuredOutput';
import { tryDeterministicFundUpdateParse } from '@/lib/fund_updates';
import type { FundUpdateStructuredResult, WorkbookFallbackProposalV1 } from '@/lib/fund_updates/types';

export const FUND_UPDATE_EXTRACTION_TIMEOUT_SECONDS = 600; // 10 minutes

export interface FundUpdateExtractionPayload {
  fileId: string;
  workspaceId?: string;
  fileTypeOverride?: string;
  contentType?: string;
}

/**
 * Job handler for fund_update_extraction.
 * Executes deterministic STARTECH parsing first; only unknown workbooks use
 * multi-step lossless workbook interpretation, chunked extraction, normalization, and validation.
 */
export async function runFundUpdateExtraction(
  payload: FundUpdateExtractionPayload,
  deps: { db: DbClient; job: Tables<'jobs'>; llmOverride?: LLMClientOverride },
): Promise<FundUpdateStructuredResult> {
  const { fileId } = payload;
  const workspaceId = payload.workspaceId ?? deps.job.workspace_id ?? (await getActiveWorkspaceId());

  if (!fileId) {
    throw new Error('Missing required field: fileId');
  }

  const fileRepo = new FileRepository(deps.db, workspaceId);
  const jobRepo = new JobRepository(deps.db);

  const file = await fileRepo.findById(fileId);
  if (!file) {
    throw new Error(`File ${fileId} not found in workspace ${workspaceId}`);
  }

  await fileRepo.updatePartial(fileId, {
    processing_status: 'processing',
    file_type: 'fund_updates',
  });

  await jobRepo.appendLog(deps.job.id, {
    message: 'Starting fund update extraction',
    metadata: { fileId, fileName: file.file_name },
  });

  try {
    const buffer = await downloadFile(file.file_link);

    // Step 1: Try deterministic parser first
    const ext = file.file_name.split('.').pop()?.toLowerCase() ?? '';
    const fallbackContentType = ext === 'xlsm'
      ? 'application/vnd.ms-excel.sheet.macroenabled.12'
      : ext === 'xls'
        ? 'application/vnd.ms-excel'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const contentType = payload.contentType || fallbackContentType;
    let deterministicResult = await tryDeterministicFundUpdateParse(
      buffer,
      contentType,
      file.file_name,
    );
    if (deterministicResult?.parser === 'nanjing_fund_ledger_v1') {
      const knownMasterInvestors = (
        await new FlInvestorRepository(deps.db).findByWorkspaceId(workspaceId)
      ).map((investor) => investor.name);
      deterministicResult = await tryDeterministicFundUpdateParse(
        buffer,
        contentType,
        file.file_name,
        { knownMasterInvestors },
      );
    }

    if (deterministicResult) {
      await fileRepo.updatePartial(fileId, {
        raw_notes: deterministicResult.summary,
        structured_notes: JSON.stringify(deterministicResult, null, 2),
        tags: deterministicResult.tags,
        matched_companies: deterministicResult.matched_companies as Tables<'files'>['matched_companies'],
        file_date: deterministicResult.file_date || null,
        file_type: 'fund_updates',
        processing_status: 'awaiting_review',
      });

      await jobRepo.appendLog(deps.job.id, {
        message: 'Deterministic STARTECH extraction completed successfully',
        metadata: {
          parser: deterministicResult.parser,
          assetCount: deterministicResult.fund_update_proposal?.stats.asset_count ?? 0,
        },
      });

      return deterministicResult;
    }

    // Step 2: Multi-step LLM fallback for unknown workbooks
    const result = await orchestrateWorkbookFallback({
      buffer,
      fileName: file.file_name,
      contentType,
      llmOverride: deps.llmOverride,
      onProgress: async (stage, metadata) => {
        try {
          await jobRepo.appendLog(deps.job.id, {
            message: `Stage: ${stage}`,
            metadata,
          });
        } catch (logErr) {
          console.warn(`[fundUpdateExtraction] Failed to append job log: ${logErr}`);
        }
      },
    });

    const proposal = result.fund_update_proposal as WorkbookFallbackProposalV1 | undefined;
    // Missing validation defaults to non-reviewable (false) for v1
    const isReviewable = Boolean(
      proposal?.validation?.isReviewable && (proposal.validation.hardFailures?.length ?? 0) === 0,
    );
    const nextProcessingStatus = isReviewable ? 'awaiting_review' : 'failed';

    await fileRepo.updatePartial(fileId, {
      raw_notes: result.summary,
      structured_notes: JSON.stringify(result, null, 2),
      tags: result.tags,
      matched_companies: result.matched_companies as Tables<'files'>['matched_companies'],
      file_date: result.file_date || null,
      file_type: 'fund_updates',
      processing_status: nextProcessingStatus,
    });

    await jobRepo.appendLog(deps.job.id, {
      message: isReviewable
        ? 'Extraction completed successfully and is ready for review'
        : `Extraction completed with hard validation failures (${proposal?.validation?.hardFailures?.length ?? 0} failures)`,
      metadata: {
        isReviewable,
        processingStatus: nextProcessingStatus,
        totalRows: proposal?.stats?.total_data_rows ?? 0,
        parsedRows: proposal?.stats?.parsed_rows_count ?? 0,
        coveragePct: proposal?.stats?.coverage_pct ?? 0,
        hardFailures: proposal?.validation?.hardFailures ?? [],
      },
    });

    return result;
  } catch (error) {
    try {
      await fileRepo.updatePartial(fileId, {
        processing_status: 'failed',
      });
    } catch (updateErr) {
      console.warn(`[fundUpdateExtraction] Failed to mark file as failed: ${updateErr}`);
    }

    try {
      await jobRepo.appendLog(deps.job.id, {
        message: `Fund update extraction failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: {
          error: error instanceof Error ? error.stack || error.message : String(error),
        },
      });
    } catch (logErr) {
      console.warn(`[fundUpdateExtraction] Failed to append failure job log: ${logErr}`);
    }

    throw error;
  }
}
