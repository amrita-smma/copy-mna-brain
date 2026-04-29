import { downloadFile, getSignedUrl } from '@/lib/s3';
import { deleteFile } from '@/lib/s3';
import { extractTextFromFile } from '@/lib/fileExtractor';
import { processFileContent } from '@/lib/agents/file_processing';
import type { CompanyFinancialRepository, DbClient, FileRepository, CriteriaRepository, ScreeningRepository, Tables } from '@/lib/repositories';
import type { CompanyAnalysisService } from './companyAnalysisService';
import type { AIScreeningService } from './aiScreeningService';

export class FileService {
  constructor(
    private readonly db: DbClient,
    private readonly fileRepo: FileRepository,
    private readonly companyAnalysisService: CompanyAnalysisService,
    private readonly aiScreeningService: AIScreeningService,
    private readonly criteriaRepo: CriteriaRepository,
    private readonly screeningRepo: ScreeningRepository,
    private readonly companyFinancialRepo: CompanyFinancialRepository,
  ) {}

  async findAll(fileType?: string) {
    const files = await this.fileRepo.findAll(fileType);
    return Promise.all(
      files.map(async (file) => {
        try {
          const signedUrl = await getSignedUrl(file.file_link);
          return { ...file, signed_url: signedUrl };
        } catch {
          return { ...file, signed_url: null };
        }
      }),
    );
  }

  async processUpload(
    key: string,
    fileName: string,
    contentType: string,
    rawNotes?: string,
  ) {
    const buffer = await downloadFile(key);
    const fileType = contentType || 'application/octet-stream';

    const initialData = await this.fileRepo.insert({
      file_name: fileName,
      file_link: key,
      processing_status: 'processing',
      file_type: 'other',
    });

    let rawText = '';
    let structuredResult: Awaited<ReturnType<typeof processFileContent>> = null;
    let tags: string[] = [];
    let matched_companies: unknown[] = [];

    try {
      const isPdf = fileType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
      if (!isPdf) {
        rawText = await extractTextFromFile(buffer, fileType, fileName);
      }

      structuredResult = await processFileContent(rawText, buffer, fileType, rawNotes ?? '', this.db);

      if (structuredResult) {
        tags = structuredResult.tags || [];
        matched_companies = structuredResult.matched_companies || [];
      }

      await this.fileRepo.updatePartial(initialData.id, {
        raw_notes: rawText,
        file_type: structuredResult?.file_type || 'other',
        structured_notes: structuredResult ? JSON.stringify(structuredResult, null, 2) : null,
        tags,
        matched_companies: matched_companies as Tables<'files'>['matched_companies'],
        file_date: structuredResult?.file_date || null,
        processing_status: 'completed',
      });
    } catch (processError) {
      console.error('Error during file processing:', processError);
      await this.fileRepo.updatePartial(initialData.id, {
        processing_status: 'failed',
        raw_notes: rawText || 'Extraction failed',
      });
    }

    const updatedData = await this.fileRepo.findById(initialData.id);
    const signedUrl = await getSignedUrl(key);

    const company = structuredResult?.company;
    if (!company || !company.id) {
      return { ...updatedData, signed_url: signedUrl };
    }

    await this.companyAnalysisService.dispatch({
      companyId: company.id,
      source: structuredResult?.file_type || 'other',
    }).catch((err) => console.error('Error dispatching company analysis:', err));

    void (async () => {
      try {
        const criteriaList = await this.criteriaRepo.findAll();
        if (criteriaList.length === 0) return;

        const financials = await this.companyFinancialRepo.findByCompany(company.id);
        const byYear = new Map(financials.map((r) => [r.fiscal_year, r]));
        const companyData = {
          id: company.id,
          name: company.target || company.name,
          segment: company.segment,
          geography: company.geography,
          company_focus: company.company_focus,
          ownership: company.ownership,
          website: company.website,
          revenue_2022_usd_mn: byYear.get(2022)?.revenue_usd_mn ?? null,
          revenue_2023_usd_mn: byYear.get(2023)?.revenue_usd_mn ?? null,
          revenue_2024_usd_mn: byYear.get(2024)?.revenue_usd_mn ?? null,
          ebitda_2022_usd_mn: byYear.get(2022)?.ebitda_usd_mn ?? null,
          ebitda_2023_usd_mn: byYear.get(2023)?.ebitda_usd_mn ?? null,
          ebitda_2024_usd_mn: byYear.get(2024)?.ebitda_usd_mn ?? null,
          ev_2024: byYear.get(2024)?.ev_usd_mn ?? null,
        };

        for (const criterion of criteriaList) {
          const screeningEntry = await this.screeningRepo.insert({
            company_id: company.id,
            criteria_id: criterion.id,
            state: 'pending',
          });

          await this.aiScreeningService.dispatch({
            companyId: company.id,
            criteriaId: criterion.id,
            criteriaPrompt: criterion.prompt,
            screeningId: screeningEntry.id,
            company: companyData,
          }).catch(async (err) => {
            console.error(`Error dispatching ai-screening for criterion ${criterion.id}:`, err);
            await this.screeningRepo.update(screeningEntry.id, {
              state: 'failed',
              result: 'error',
              remarks: 'Job dispatch failed',
            });
          });
        }
      } catch (err) {
        console.error('Error in ai-screening flow:', err);
      }
    })();

    return { ...updatedData, signed_url: signedUrl };
  }

  update(id: string, updates: Parameters<FileRepository['updatePartial']>[1]) {
    return this.fileRepo.update(id, updates);
  }

  async getSignedDownloadUrl(id: string) {
    const record = await this.fileRepo.findLinkAndNameById(id);
    const url = await getSignedUrl(record.file_link);
    return { url, fileName: record.file_name };
  }

  async getDownloadUrl(id: string) {
    const record = await this.fileRepo.findLinkAndNameById(id);
    const downloadUrl = await getSignedUrl(record.file_link, 3600, record.file_name);
    return { downloadUrl, fileName: record.file_name };
  }

  async delete(id: string) {
    const record = await this.fileRepo.findLinkAndNameById(id);
    try {
      await deleteFile(record.file_link);
    } catch (s3Error) {
      console.error('S3 delete error:', s3Error);
    }
    await this.fileRepo.delete(id);
  }
}
