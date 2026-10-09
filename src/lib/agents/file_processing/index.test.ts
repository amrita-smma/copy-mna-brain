import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  deleteFile: vi.fn(),
  toFile: vi.fn(),
  stream: vi.fn(),
  getAllCompanyReferences: vi.fn(),
  createAgent: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    beta = { files: { upload: mocks.upload, delete: mocks.deleteFile } };
  }
  return { default: Anthropic, toFile: mocks.toFile };
});

vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class {
    constructor(public opts: Record<string, unknown>) {}
  },
}));

vi.mock('langchain', () => ({
  createAgent: (...args: unknown[]) => {
    mocks.createAgent(...args);
    return { stream: mocks.stream };
  },
}));

vi.mock('@/lib/fuzzySearch', () => ({
  getAllCompanyReferences: mocks.getAllCompanyReferences,
}));

import { processFileContent } from './index';

const FILES_API_BETA = 'files-api-2025-04-14';

// A minimal agent reply containing the JSON contract block the parser expects.
const JSON_BLOCK =
  '```json\n' +
  JSON.stringify({
    file_type: 'other',
    summary: 's',
    companies_detected: [],
    company_notes: [],
  }) +
  '\n```';

/** Build a one-shot async stream that mimics `agent.stream(...)`. */
function streamReturning(content: string) {
  return (async function* () {
    yield { messages: [{ content }] };
  })();
}

function jsonBlock(payload: object): string {
  return '```json\n' + JSON.stringify(payload) + '\n```';
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  mocks.getAllCompanyReferences.mockResolvedValue([]);
  mocks.toFile.mockResolvedValue('FILE');
  mocks.deleteFile.mockResolvedValue(undefined);
  mocks.createAgent.mockReset();
  mocks.stream.mockImplementation(() => Promise.resolve(streamReturning(JSON_BLOCK)));
});

afterEach(() => vi.clearAllMocks());

describe('processFileContent (Files API for PDFs)', () => {
  it('uploads the whole PDF once by id and deletes it immediately after processing', async () => {
    mocks.upload.mockResolvedValueOnce({ id: 'file_a' });

    await processFileContent('raw text', Buffer.from('pdf'), 'application/pdf', '');

    // The whole buffer is uploaded once — no chunking — and deleted afterwards.
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.objectContaining({ file: 'FILE', betas: [FILES_API_BETA] }),
    );
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
    expect(mocks.deleteFile).toHaveBeenCalledWith('file_a', { betas: [FILES_API_BETA] });

    // The message references the uploaded file by id — never base64 data.
    const firstMessage = mocks.stream.mock.calls[0][0].messages[0];
    const fileBlock = firstMessage.content.find((b: { type: string }) => b.type === 'file');
    expect(fileBlock).toEqual({ type: 'file', fileId: 'file_a' });
    expect(JSON.stringify(firstMessage.content)).not.toContain('source_type');
  });

  it('deletes the uploaded file even when the agent stream throws', async () => {
    mocks.upload.mockResolvedValueOnce({ id: 'file_a' });
    mocks.stream.mockRejectedValueOnce(new Error('boom'));

    await expect(
      processFileContent('raw text', Buffer.from('pdf'), 'application/pdf', ''),
    ).rejects.toThrow('boom');

    expect(mocks.deleteFile).toHaveBeenCalledWith('file_a', { betas: [FILES_API_BETA] });
  });

  it('does not touch the Files API for non-PDF content', async () => {
    await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it('constructs the Sonnet 5 model without a temperature sampling param', async () => {
    // Sonnet 5 returns 400 "temperature is deprecated for this model" if a
    // temperature is sent. The model must be built with temperature unset so
    // ChatAnthropic omits the field from the request.
    await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    const model = mocks.createAgent.mock.calls[0][0].model as {
      opts: Record<string, unknown>;
    };
    expect(model.opts.model).toBe('claude-sonnet-5-5');
    expect(model.opts.temperature).toBeUndefined();
  });

  it('constructs the model with token streaming enabled', async () => {
    // With maxTokens 32000, the Anthropic SDK rejects non-streaming requests
    // ("Streaming is required for operations that may take longer than 10
    // minutes"). The model must stream at the Messages API level — LangGraph's
    // agent.stream() alone does not do this.
    await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    const model = mocks.createAgent.mock.calls[0][0].model as {
      opts: Record<string, unknown>;
    };
    expect(model.opts.streaming).toBe(true);
  });
});

describe('processFileContent (filename hint)', () => {
  it('includes filename prefix in the human message for non-PDF content', async () => {
    await processFileContent('raw text', Buffer.from('x'), 'text/plain', '', undefined, 'Acme Corp - IM.pdf');

    const firstMessage = mocks.stream.mock.calls[0][0].messages[0];
    expect(firstMessage.content).toContain('Filename: Acme Corp - IM.pdf');
  });

  it('includes filename in the text block of the PDF human message', async () => {
    mocks.upload.mockResolvedValueOnce({ id: 'file_b' });

    await processFileContent('', Buffer.from('pdf'), 'application/pdf', '', undefined, 'Project Tulia Teaser.pdf');

    const firstMessage = mocks.stream.mock.calls[0][0].messages[0];
    const textBlock = firstMessage.content.find((b: { type: string }) => b.type === 'text');
    expect(textBlock.text).toContain('Filename: Project Tulia Teaser.pdf');
  });

  it('includes filename in the system prompt', async () => {
    await processFileContent('raw text', Buffer.from('x'), 'text/plain', '', undefined, 'Acme Corp - IM.pdf');

    const systemPrompt: string = mocks.createAgent.mock.calls[0][0].systemPrompt;
    expect(systemPrompt).toContain('Acme Corp - IM.pdf');
    expect(systemPrompt).toContain('File Name Hint');
  });

  it('omits filename hint from system prompt when no fileName is given', async () => {
    await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    const systemPrompt: string = mocks.createAgent.mock.calls[0][0].systemPrompt;
    expect(systemPrompt).not.toContain('File Name Hint');
  });

  it('omits filename prefix in the human message when no fileName is given', async () => {
    await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    const firstMessage = mocks.stream.mock.calls[0][0].messages[0];
    expect(firstMessage.content).not.toContain('Filename:');
  });
});

describe('processFileContent (generic name denylist)', () => {
  it('strips generic phrases from companies_detected', async () => {
    mocks.stream.mockImplementationOnce(() =>
      Promise.resolve(
        streamReturning(
          jsonBlock({
            file_type: 'other',
            summary: 's',
            companies_detected: ['Project Overview', 'Acme Corp'],
            company_notes: [],
          }),
        ),
      ),
    );

    const result = await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    const names = (result.matched_companies as Array<{ name: string }>).map((m) => m.name);
    expect(names).not.toContain('Project Overview');
    expect(names).toContain('Acme Corp');
  });

  it('ignores the prospectus fallback when project_name is a generic phrase', async () => {
    mocks.stream.mockImplementationOnce(() =>
      Promise.resolve(
        streamReturning(
          jsonBlock({
            file_type: 'prospectus',
            summary: 's',
            companies_detected: [],
            company_notes: [],
            prospectus_summary: {
              company_name: null,
              project_name: 'Company Overview',
            },
          }),
        ),
      ),
    );

    const result = await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    expect((result.matched_companies as unknown[]).length).toBe(0);
  });

  it('keeps a real project codename from the prospectus fallback', async () => {
    mocks.stream.mockImplementationOnce(() =>
      Promise.resolve(
        streamReturning(
          jsonBlock({
            file_type: 'prospectus',
            summary: 's',
            companies_detected: [],
            company_notes: [],
            prospectus_summary: {
              company_name: null,
              project_name: 'Project Atlas',
            },
          }),
        ),
      ),
    );

    const result = await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    const names = (result.matched_companies as Array<{ name: string }>).map((m) => m.name);
    expect(names).toContain('Project Atlas');
  });

  it('system prompt warns the model not to classify section headings', async () => {
    await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    const systemPrompt: string = mocks.createAgent.mock.calls[0][0].systemPrompt;
    expect(systemPrompt).toContain('Project Overview');
    expect(systemPrompt).toContain('Executive Summary');
    expect(systemPrompt).toContain('Do NOT classify document section headings');
  });

  it('nulls out generic company_name in prospectus_summary before returning', async () => {
    mocks.stream.mockImplementationOnce(() =>
      Promise.resolve(
        streamReturning(
          jsonBlock({
            file_type: 'prospectus',
            summary: 's',
            companies_detected: [],
            company_notes: [],
            prospectus_summary: {
              company_name: 'Company Overview',
              project_name: null,
              financials: [],
              fx_adjustments: [],
            },
          }),
        ),
      ),
    );

    const result = await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    expect(result.prospectus_summary?.company_name).toBeNull();
  });

  it('nulls out generic project_name in prospectus_summary before returning', async () => {
    mocks.stream.mockImplementationOnce(() =>
      Promise.resolve(
        streamReturning(
          jsonBlock({
            file_type: 'prospectus',
            summary: 's',
            companies_detected: [],
            company_notes: [],
            prospectus_summary: {
              company_name: null,
              project_name: 'Executive Summary',
              financials: [],
              fx_adjustments: [],
            },
          }),
        ),
      ),
    );

    const result = await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    expect(result.prospectus_summary?.project_name).toBeNull();
  });

  it('preserves a real company_name in prospectus_summary', async () => {

    mocks.stream.mockImplementationOnce(() =>
      Promise.resolve(
        streamReturning(
          jsonBlock({
            file_type: 'prospectus',
            summary: 's',
            companies_detected: [],
            company_notes: [],
            prospectus_summary: {
              company_name: 'PT Sinar Mas',
              project_name: null,
              financials: [],
              fx_adjustments: [],
            },
          }),
        ),
      ),
    );

    const result = await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    expect(result.prospectus_summary?.company_name).toBe('PT Sinar Mas');
  });
});

describe('processFileContent (multi-company extraction)', () => {
  it('sanitizes every entry of the companies array and mirrors companies[0] into prospectus_summary', async () => {
    mocks.stream.mockImplementationOnce(() =>
      Promise.resolve(
        streamReturning(
          jsonBlock({
            file_type: 'shopping_list',
            summary: 's',
            companies_detected: [],
            company_notes: [],
            companies: [
              {
                company_name: 'Acme Corp',
                project_name: 'Company Overview', // generic → must be nulled
                financials: [
                  { fiscal_year: 2024, revenue_usd_mn: 10, ebitda_usd_mn: null, ev_usd_mn: null, ebitda_margin: null, ev_ebitda: null, revenue_cagr_vs_prior: null },
                  { fiscal_year: 2023, revenue_usd_mn: null, ebitda_usd_mn: null, ev_usd_mn: null, ebitda_margin: null, ev_ebitda: null, revenue_cagr_vs_prior: null }, // empty row → dropped
                ],
                fx_adjustments: [],
              },
              {
                company_name: 'Executive Summary', // generic → must be nulled
                project_name: 'Project Atlas',
                financials: [],
                fx_adjustments: [],
              },
            ],
          }),
        ),
      ),
    );

    const result = await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    expect(result.companies).toHaveLength(2);
    expect(result.companies[0].company_name).toBe('Acme Corp');
    expect(result.companies[0].project_name).toBeNull();
    expect(result.companies[0].financials).toEqual([
      expect.objectContaining({ fiscal_year: 2024, revenue_usd_mn: 10 }),
    ]);
    expect(result.companies[1].company_name).toBeNull();
    expect(result.companies[1].project_name).toBe('Project Atlas');
    // prospectus_summary stays in sync with the primary target.
    expect(result.prospectus_summary).toBe(result.companies[0]);
  });

  it('falls back to the legacy single prospectus_summary when no companies array is emitted', async () => {
    mocks.stream.mockImplementationOnce(() =>
      Promise.resolve(
        streamReturning(
          jsonBlock({
            file_type: 'prospectus',
            summary: 's',
            companies_detected: [],
            company_notes: [],
            prospectus_summary: {
              company_name: 'PT Sinar Mas',
              project_name: null,
              financials: [],
              fx_adjustments: [],
            },
          }),
        ),
      ),
    );

    const result = await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    expect(result.companies).toHaveLength(1);
    expect(result.companies[0].company_name).toBe('PT Sinar Mas');
    expect(result.prospectus_summary).toBe(result.companies[0]);
  });

  it('backfills USD figures from local-currency FX rows per entry', async () => {
    mocks.stream.mockImplementationOnce(() =>
      Promise.resolve(
        streamReturning(
          jsonBlock({
            file_type: 'shopping_list',
            summary: 's',
            companies_detected: [],
            company_notes: [],
            companies: [
              {
                company_name: 'Hanguk Co',
                project_name: null,
                financials: [
                  { fiscal_year: 2024, revenue_usd_mn: null, ebitda_usd_mn: null, ev_usd_mn: null, ebitda_margin: null, ev_ebitda: null, revenue_cagr_vs_prior: null },
                ],
                fx_adjustments: [
                  {
                    fiscal_year: 2024,
                    currency: 'KRW',
                    revenue_local: 1370,
                    revenue_local_unit: 'mn',
                    ebitda_local: null,
                    ebitda_local_unit: null,
                    assumed_forex: 1370,
                    forex_change_vs_prior: null,
                    revenue_cagr_domestic: null,
                  },
                ],
              },
            ],
          }),
        ),
      ),
    );

    const result = await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    expect(result.companies[0].financials).toEqual([
      expect.objectContaining({ fiscal_year: 2024, revenue_usd_mn: 1 }),
    ]);
  });

  it('uses company names from the companies array as the companies_detected fallback', async () => {
    mocks.stream.mockImplementationOnce(() =>
      Promise.resolve(
        streamReturning(
          jsonBlock({
            file_type: 'shopping_list',
            summary: 's',
            companies_detected: [],
            company_notes: [],
            companies: [
              { company_name: 'Acme Corp', project_name: null },
              { company_name: null, project_name: 'Project Atlas' },
              { company_name: 'Company Overview', project_name: null }, // generic → excluded
            ],
          }),
        ),
      ),
    );

    const result = await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    const names = (result.matched_companies as Array<{ name: string }>).map((m) => m.name);
    expect(names).toContain('Acme Corp');
    expect(names).toContain('Project Atlas');
    expect(names).not.toContain('Company Overview');
  });

  it('does not emit a companies array for non deal-target file types', async () => {
    mocks.stream.mockImplementationOnce(() =>
      Promise.resolve(
        streamReturning(
          jsonBlock({
            file_type: 'mom',
            summary: 's',
            companies_detected: [],
            company_notes: [],
          }),
        ),
      ),
    );

    const result = await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    expect(result.companies).toBeUndefined();
  });

  it('instructs the model to honor user inclusion/exclusion notes', async () => {
    await processFileContent('raw text', Buffer.from('x'), 'text/plain', 'only include Acme');

    const systemPrompt: string = mocks.createAgent.mock.calls[0][0].systemPrompt;
    expect(systemPrompt).toContain('Company inclusion/exclusion instructions');
    expect(systemPrompt).toContain('only include Acme');
  });
});

