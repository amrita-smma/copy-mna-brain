import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { PgDialect } from 'drizzle-orm/pg-core';

const anthropicMocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = { create: anthropicMocks.create };
  }
  return { default: Anthropic };
});

// No real network: the post-run overview refresh would otherwise POST to the app.
const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', fetchMock);
beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ workspaceId: 'ws-1', claimed: 1 }] }),
  });
});

const overviewRefreshCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/crm-overviews/refresh'));

const crmMocks = vi.hoisted(() => ({
  upsertEphemeralCrmBatch: vi.fn().mockResolvedValue({ emails_inserted: 1 }),
  upsertEmailNotes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./emailProcessCrm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./emailProcessCrm')>();
  return {
    ...actual,
    upsertEphemeralCrmBatch: crmMocks.upsertEphemeralCrmBatch,
    upsertEmailNotes: crmMocks.upsertEmailNotes,
  };
});

vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  class UserWorkspaceRepository {
    findWorkspaceIdsBySyncedEmail = vi.fn().mockResolvedValue(['ws-1']);
  }
  class EmployerOverrideRepository {
    listExcludedDomains = vi.fn().mockResolvedValue([]);
  }
  return {
    ...actual,
    UserWorkspaceRepository,
    EmployerOverrideRepository,
  };
});

// Real extraction unless a test sets an implementation (fake PDF bytes would
// otherwise fail local validation before triage).
const extractTextMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/fileExtractor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fileExtractor')>();
  return {
    ...actual,
    extractTextFromFile: (...args: Parameters<typeof actual.extractTextFromFile>) =>
      extractTextMock.getMockImplementation()
        ? extractTextMock(...args)
        : actual.extractTextFromFile(...args),
  };
});

vi.mock('../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repositories')>();
  class MartRepository {
    refreshAll = vi.fn().mockResolvedValue(undefined);
  }
  return {
    ...actual,
    MartRepository,
  };
});
import {
  processMboxSource,
  persistHardFailure,
  getSourceRunState,
  isSourceTerminal,
  LLM_CONCURRENCY,
  PROCESS_BATCH_SIZE,
  MAX_PROCESS_FAIL_COUNT,
  smartFileOverrideForDocType,
  stickySmartFileOverrideForTriage,
  triageAttachmentForSmartFiles,
  triageDealDocumentText,
  attachmentContentDigest,
  EXTRACT_MAX_TOKENS,
  EXTRACT_MAX_TOKENS_RETRY,
  subjectLooksDealRelated,
  hasDealSignal,
  smartFileEmailContext,
  type EmailProcessResult,
} from './emailProcess';
import {
  isSensitiveAttachmentFilename,
  shouldBypassPdfTriage,
  PDF_TRIAGE_SOFT_MAX_BYTES,
  OFFICE_TRIAGE_MAX_CHARS,
  clipOfficeTriageText,
  processEmail,
} from '../mboxParser';
import {
  PERSONAL_MAIL_DOMAINS,
  INTERNAL_MAIL_DOMAINS,
} from '../lib/mailDomains';

describe('mailDomains single source', () => {
  it('includes known internal and personal domains', () => {
    expect(INTERNAL_MAIL_DOMAINS.has('starcapital.co.id')).toBe(true);
    expect(INTERNAL_MAIL_DOMAINS.has('energigroupindonesia.com')).toBe(true);
    expect(INTERNAL_MAIL_DOMAINS.has('gear.com.sg')).toBe(true);
    expect(PERSONAL_MAIL_DOMAINS.has('gmail.com')).toBe(true);
  });

  it('keeps outlook.com personal-only so deal mail to outlook counterparties is not internal_only', () => {
    expect(PERSONAL_MAIL_DOMAINS.has('outlook.com')).toBe(true);
    expect(INTERNAL_MAIL_DOMAINS.has('outlook.com')).toBe(false);
  });
});

describe('smartFileEmailContext', () => {
  it('sends the Message-ID with the sender headers in email_context', () => {
    expect(
      smartFileEmailContext({
        messageId: 'abc123@bank.example',
        parsed: {
          sender: { name: 'Jimmy Sprinkles', email: 'jimmy@bank.example' },
          subject: 'Project Atlas teaser',
          date: '2026-10-01T09:00:00.000Z',
        } as never,
      }),
    ).toEqual({
      senderName: 'Jimmy Sprinkles',
      senderEmail: 'jimmy@bank.example',
      subject: 'Project Atlas teaser',
      receivedAt: '2026-10-01T09:00:00.000Z',
      messageId: 'abc123@bank.example',
    });
  });

  it('leaves absent headers undefined', () => {
    expect(
      smartFileEmailContext({
        messageId: '',
        parsed: { sender: null, subject: '', date: null } as never,
      }),
    ).toEqual({
      senderName: undefined,
      senderEmail: undefined,
      subject: '',
      receivedAt: undefined,
      messageId: undefined,
    });
  });
});

describe('knobs', () => {
  it('exposes batch + concurrency + fail-budget knobs', () => {
    expect(PROCESS_BATCH_SIZE).toBeGreaterThanOrEqual(10);
    expect(LLM_CONCURRENCY).toBeGreaterThanOrEqual(2);
    expect(MAX_PROCESS_FAIL_COUNT).toBeGreaterThanOrEqual(3);
  });

  it('exports isSensitiveAttachmentFilename for Smart Files per-file gating', () => {
    expect(isSensitiveAttachmentFilename('July_2026_payslip.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('IM_ProjectAlpha.pdf')).toBe(false);
    expect(isSensitiveAttachmentFilename('Candidate_CV.docx')).toBe(true);
  });

  it('pins trusted pipeline triage types as sticky Smart Files overrides', () => {
    expect(smartFileOverrideForDocType('mom')).toBe('mom');
    expect(smartFileOverrideForDocType('shopping_list')).toBe('shopping_list');
    expect(smartFileOverrideForDocType('market_study')).toBe('market_study');
    expect(smartFileOverrideForDocType('prospectus')).toBe('prospectus');
    // Closest sticky deal-target type Smart Files accepts.
    expect(smartFileOverrideForDocType('im')).toBe('prospectus');
    expect(smartFileOverrideForDocType('teaser')).toBe('prospectus');
    expect(smartFileOverrideForDocType('financial_statement')).toBeUndefined();
    expect(smartFileOverrideForDocType('other')).toBeUndefined();
  });

  it('applies sticky Smart Files override only on high-confidence triage', () => {
    expect(stickySmartFileOverrideForTriage('im', 'high')).toBe('prospectus');
    expect(stickySmartFileOverrideForTriage('mom', 'high')).toBe('mom');
    expect(stickySmartFileOverrideForTriage('im', 'medium')).toBeUndefined();
    expect(stickySmartFileOverrideForTriage('im', 'low')).toBeUndefined();
    expect(stickySmartFileOverrideForTriage('other', 'high')).toBeUndefined();
  });

  it('treats oversized PDFs as fail-closed Smart Files skips (not upload bypass)', () => {
    // processMboxSource skips upload when this is true — never fail-open to Smart Files.
    expect(shouldBypassPdfTriage(PDF_TRIAGE_SOFT_MAX_BYTES + 1)).toBe(true);
  });

  it('fingerprints attachment bytes for Smart Files upload idempotency', () => {
    const a = attachmentContentDigest(Buffer.from('deal-pdf-a'));
    const b = attachmentContentDigest(Buffer.from('deal-pdf-b'));
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(attachmentContentDigest(Buffer.from('deal-pdf-a')));
    expect(a).not.toBe(b);
  });
});

describe('triageAttachmentForSmartFiles', () => {
  const officeMime =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  /** A zip directory with nothing oversized, for fake Office bytes. */
  const readZipSizes = async () => new Map<string, number>();

  function mockClient(input: { doc_type: string; confidence: string }) {
    return {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'tool_use', input }],
        }),
      },
    } as never;
  }

  it('uploads deal Office files after text triage (high confidence sticky)', async () => {
    const extractText = vi.fn().mockResolvedValue(
      'Confidential Information Memorandum for Project Alpha. '.repeat(5),
    );
    const outcome = await triageAttachmentForSmartFiles({
      mime: officeMime,
      fileName: 'Project_Alpha_IM.docx',
      bytes: Buffer.from('fake-docx'),
      client: mockClient({ doc_type: 'im', confidence: 'high' }),
      model: 'claude-haiku-5-5',
      extractText,
      readZipSizes,
    });
    expect(extractText).toHaveBeenCalledOnce();
    expect(outcome).toEqual({
      kind: 'upload',
      fileTypeOverride: 'prospectus',
    });
  });

  it('uploads medium-confidence deal Office without sticky override', async () => {
    const extractText = vi.fn().mockResolvedValue(
      'Teaser for Project Nova target company overview. '.repeat(5),
    );
    const outcome = await triageAttachmentForSmartFiles({
      mime: officeMime,
      fileName: 'Project_Nova_Teaser.docx',
      bytes: Buffer.from('fake-docx'),
      client: mockClient({ doc_type: 'teaser', confidence: 'medium' }),
      model: 'claude-haiku-5-5',
      extractText,
      readZipSizes,
    });
    expect(outcome).toEqual({ kind: 'upload', fileTypeOverride: undefined });
  });

  it('skips non-deal Office files without Smart Files upload', async () => {
    const extractText = vi.fn().mockResolvedValue(
      'Weekly grocery shopping list apples bananas milk. '.repeat(5),
    );
    const outcome = await triageAttachmentForSmartFiles({
      mime: officeMime,
      fileName: 'shopping.docx',
      bytes: Buffer.from('fake-docx'),
      client: mockClient({ doc_type: 'other', confidence: 'high' }),
      model: 'claude-haiku-5-5',
      extractText,
      readZipSizes,
    });
    expect(outcome).toEqual({ kind: 'skip' });
  });

  // MBOX parts often declare application/octet-stream for real Office docs.
  it('triages Office files that arrive with a generic MIME type', async () => {
    const extractText = vi.fn().mockResolvedValue(
      'Confidential Information Memorandum for Project Alpha. '.repeat(5),
    );
    const outcome = await triageAttachmentForSmartFiles({
      mime: 'application/octet-stream',
      fileName: 'Project_Alpha_IM.docx',
      bytes: Buffer.from('fake-docx'),
      client: mockClient({ doc_type: 'im', confidence: 'high' }),
      model: 'claude-haiku-5-5',
      extractText,
      readZipSizes,
    });
    expect(extractText).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ kind: 'upload', fileTypeOverride: 'prospectus' });
  });

  it('still ignores non-Office, non-PDF attachments', async () => {
    const extractText = vi.fn();
    const outcome = await triageAttachmentForSmartFiles({
      mime: 'image/png',
      fileName: 'logo.png',
      bytes: Buffer.from('fake-png'),
      client: mockClient({ doc_type: 'im', confidence: 'high' }),
      model: 'claude-haiku-5-5',
      extractText,
    });
    expect(outcome).toEqual({ kind: 'skip' });
    expect(extractText).not.toHaveBeenCalled();
  });

  it.each(['encrypted', 'invalid', 'too_many_pages'] as const)(
    'skips (does not rewind) a %s PDF without calling Anthropic',
    async (reason) => {
      const inspectPdfBytes = vi.fn().mockResolvedValue({ ok: false, reason });
      const extractText = vi.fn();
      const create = vi.fn();
      const outcome = await triageAttachmentForSmartFiles({
        mime: 'application/pdf',
        fileName: 'doc.pdf',
        bytes: Buffer.from('fake-pdf'),
        client: { messages: { create } } as never,
        model: 'claude-haiku-5-5',
        extractText,
        inspectPdfBytes,
      });
      expect(inspectPdfBytes).toHaveBeenCalledWith(Buffer.from('fake-pdf'));
      expect(outcome).toEqual({ kind: 'skip' });
      expect(create).not.toHaveBeenCalled();
      // The page text is never extracted: Anthropic reads the PDF itself.
      expect(extractText).not.toHaveBeenCalled();
    },
  );

  it('retries PDF when local validation succeeds but Anthropic fails', async () => {
    const create = vi.fn().mockRejectedValue(new Error('anthropic down'));
    const outcome = await triageAttachmentForSmartFiles({
      mime: 'application/pdf',
      fileName: 'scan.pdf',
      bytes: Buffer.from('fake-pdf'),
      client: { messages: { create } } as never,
      model: 'claude-haiku-5-5',
      inspectPdfBytes: async () => ({ ok: true, pages: 3 }),
    });
    expect(outcome.kind).toBe('retry');
    expect(create).toHaveBeenCalledOnce();
  });

  it('skips (does not rewind) a PDF Anthropic rejects as a bad request', async () => {
    const create = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Could not process PDF'), { status: 400 }));
    const outcome = await triageAttachmentForSmartFiles({
      mime: 'application/pdf',
      fileName: 'odd.pdf',
      bytes: Buffer.from('fake-pdf'),
      client: { messages: { create } } as never,
      model: 'claude-haiku-5-5',
      inspectPdfBytes: async () => ({ ok: true, pages: 3 }),
    });
    expect(outcome).toEqual({ kind: 'skip' });
  });

  it('skips an Office file whose XML would inflate past the cap, before extracting', async () => {
    const extractText = vi.fn();
    const outcome = await triageAttachmentForSmartFiles({
      mime: officeMime,
      fileName: 'bomb.docx',
      bytes: Buffer.from('fake-docx'),
      client: mockClient({ doc_type: 'im', confidence: 'high' }),
      model: 'claude-haiku-5-5',
      extractText,
      readZipSizes: async () => new Map([['word/document.xml', 500 * 1024 * 1024]]),
    });
    expect(outcome).toEqual({ kind: 'skip' });
    expect(extractText).not.toHaveBeenCalled();
  });

  it('skips (does not rewind) an Office file that is not a readable zip', async () => {
    const extractText = vi.fn();
    const outcome = await triageAttachmentForSmartFiles({
      mime: officeMime,
      fileName: 'broken.docx',
      bytes: Buffer.from('not-a-zip'),
      client: mockClient({ doc_type: 'im', confidence: 'high' }),
      model: 'claude-haiku-5-5',
      extractText,
    });
    expect(outcome).toEqual({ kind: 'skip' });
    expect(extractText).not.toHaveBeenCalled();
  });

  it('reads a workbook through the bounded streaming prefix, not the full extractor', async () => {
    const extractText = vi.fn();
    const readXlsxPrefix = vi
      .fn()
      .mockResolvedValue('Project Nova LBO model\tRevenue\tEBITDA\n'.repeat(5));
    const outcome = await triageAttachmentForSmartFiles({
      mime: 'application/octet-stream',
      fileName: 'Project_Nova_LBO.xlsx',
      bytes: Buffer.from('fake-xlsx'),
      client: mockClient({ doc_type: 'financial_model', confidence: 'high' }),
      model: 'claude-haiku-5-5',
      extractText,
      readZipSizes,
      readXlsxPrefix,
    });
    expect(readXlsxPrefix).toHaveBeenCalledWith(Buffer.from('fake-xlsx'), OFFICE_TRIAGE_MAX_CHARS);
    expect(extractText).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'upload', fileTypeOverride: undefined });
  });

  it('skips oversized Office before extract', async () => {
    const extractText = vi.fn();
    const outcome = await triageAttachmentForSmartFiles({
      mime: officeMime,
      fileName: 'huge.docx',
      bytes: Buffer.alloc(PDF_TRIAGE_SOFT_MAX_BYTES + 1),
      client: mockClient({ doc_type: 'im', confidence: 'high' }),
      model: 'claude-haiku-5-5',
      extractText,
    });
    expect(extractText).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'skip' });
  });

  it('skips empty Office extract without upload', async () => {
    const extractText = vi.fn().mockResolvedValue('   \n');
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'tool_use', input: { doc_type: 'im', confidence: 'high' } }],
    });
    const outcome = await triageAttachmentForSmartFiles({
      mime: officeMime,
      fileName: 'empty.docx',
      bytes: Buffer.from('fake-docx'),
      client: { messages: { create } } as never,
      model: 'claude-haiku-5-5',
      extractText,
      readZipSizes,
    });
    expect(outcome).toEqual({ kind: 'skip' });
    expect(create).not.toHaveBeenCalled();
  });

  // A corrupt/password-protected file fails identically every attempt, so
  // rewinding would burn the fail budget and abandon the whole mbox source.
  it('skips (does not rewind) when Office extraction fails deterministically', async () => {
    const extractText = vi.fn().mockRejectedValue(new Error('mammoth boom'));
    const create = vi.fn();
    const outcome = await triageAttachmentForSmartFiles({
      mime: officeMime,
      fileName: 'broken.docx',
      bytes: Buffer.from('fake-docx'),
      client: { messages: { create } } as never,
      model: 'claude-haiku-5-5',
      extractText,
      readZipSizes,
    });
    expect(outcome).toEqual({ kind: 'skip' });
    expect(create).not.toHaveBeenCalled();
  });

  it('rewinds (retry) when Anthropic triage fails', async () => {
    const extractText = vi.fn().mockResolvedValue(
      'Information Memorandum Project Alpha overview section. '.repeat(5),
    );
    const client = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error('anthropic down')),
      },
    } as never;
    const outcome = await triageAttachmentForSmartFiles({
      mime: officeMime,
      fileName: 'Project_Alpha_IM.docx',
      bytes: Buffer.from('fake-docx'),
      client,
      model: 'claude-haiku-5-5',
      extractText,
      readZipSizes,
    });
    expect(outcome.kind).toBe('retry');
  });

  it('clips triage prompt text to OFFICE_TRIAGE_MAX_CHARS', async () => {
    const huge = 'd'.repeat(OFFICE_TRIAGE_MAX_CHARS + 2000);
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'tool_use', input: { doc_type: 'im', confidence: 'high' } }],
    });
    await triageDealDocumentText(
      { messages: { create } } as never,
      'claude-haiku-5-5',
      { fileName: 'big.docx', text: huge },
    );
    const prompt = create.mock.calls[0]![0].messages[0].content[0].text as string;
    const prefixMarker = 'Document text (prefix):\n';
    const start = prompt.indexOf(prefixMarker) + prefixMarker.length;
    const end = prompt.indexOf('\n\nClassify this document.');
    const sentText = prompt.slice(start, end);
    expect(sentText.length).toBe(OFFICE_TRIAGE_MAX_CHARS);
    expect(sentText).toBe(clipOfficeTriageText(huge));
  });

  it('uses the expanded deal-only triage system prompt (MB-465)', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [
        { type: 'tool_use', input: { doc_type: 'other', confidence: 'high' } },
      ],
    });
    await triageDealDocumentText(
      { messages: { create } } as never,
      'claude-haiku-5-5',
      { fileName: 'notes.docx', text: 'x'.repeat(80) },
    );
    const system = create.mock.calls[0]![0].system as string;
    expect(system).toMatch(/NON-deal/i);
    expect(system).toMatch(/prospectus/i);
    expect(system).toMatch(/boilerplate NDAs/i);
  });
});

describe('subjectLooksDealRelated / hasDealSignal (MB-465)', () => {
  it('matches deal subjects and rejects I\'m / operational project subjects', () => {
    expect(subjectLooksDealRelated('CIM - Project Titan')).toBe(true);
    expect(subjectLooksDealRelated('Project Alpha Teaser')).toBe(true);
    expect(subjectLooksDealRelated('Project-Titan CIM')).toBe(true);
    expect(subjectLooksDealRelated('Project_42 update from banker')).toBe(true);
    expect(subjectLooksDealRelated('LOI Draft')).toBe(true);
    expect(subjectLooksDealRelated('NDA for process')).toBe(true);
    expect(subjectLooksDealRelated('Information Memorandum')).toBe(true);
    expect(subjectLooksDealRelated('Re: IM for Acme')).toBe(true);
    expect(subjectLooksDealRelated('Mandate update')).toBe(true);
    expect(subjectLooksDealRelated('Process letter attached')).toBe(true);
    expect(subjectLooksDealRelated('Cinema night')).toBe(false);

    // `\bim\b` must NOT match contractions (ASCII or typographic apostrophe).
    expect(subjectLooksDealRelated("I'm following up on lunch")).toBe(false);
    expect(subjectLooksDealRelated('I’m following up on lunch')).toBe(false);
    expect(subjectLooksDealRelated("Here's what I'm seeing")).toBe(false);

    // Operational project subjects (noise words require full-word match).
    expect(subjectLooksDealRelated('Project update')).toBe(false);
    expect(subjectLooksDealRelated('Project status')).toBe(false);
    expect(subjectLooksDealRelated('Project meeting tomorrow')).toBe(false);
    expect(subjectLooksDealRelated('IT Project sync')).toBe(false);
    expect(subjectLooksDealRelated('Project management')).toBe(false);
    expect(subjectLooksDealRelated('Project budget')).toBe(false);
    // Prefix of a noise word must NOT block a real project codename.
    expect(subjectLooksDealRelated('Project Synchronicity')).toBe(true);
    expect(subjectLooksDealRelated('Project StatusQuo')).toBe(true);

    expect(subjectLooksDealRelated('Weekly team notes')).toBe(false);
    expect(subjectLooksDealRelated('')).toBe(false);
    expect(subjectLooksDealRelated(null)).toBe(false);
  });

  it('allows Smart Files on deal topic, related companies, or deal subject', () => {
    expect(
      hasDealSignal(
        {
          topics: [{ name: 'acquisition', is_deal_related: true }],
          people: [],
          related_companies: [],
        },
        'Weekly notes',
      ),
    ).toBe(true);

    expect(
      hasDealSignal(
        {
          topics: [{ name: 'semiconductors', is_deal_related: false }],
          people: [],
          related_companies: [
            {
              company_name: 'Acme',
              reason: 'explicit_pitch',
              reason_summary: 'sell-side',
              keywords: [],
              confidence: 'high',
            },
          ],
        },
        'Weekly notes',
      ),
    ).toBe(true);

    expect(
      hasDealSignal(
        {
          topics: [],
          people: [],
          related_companies: [],
        },
        'CIM - Project Titan',
      ),
    ).toBe(true);

    // Subject still wins when llm is null.
    expect(hasDealSignal(null, 'CIM - Project Titan')).toBe(true);
  });

  it('denies Smart Files when no deal topic, no related cos, and bland subject', () => {
    expect(
      hasDealSignal(
        {
          topics: [{ name: 'semiconductors', is_deal_related: false }],
          people: [],
          related_companies: [],
        },
        'Weekly notes',
      ),
    ).toBe(false);

    expect(
      hasDealSignal(
        { topics: [], people: [], related_companies: [] },
        'Please see attached',
      ),
    ).toBe(false);

    expect(hasDealSignal(null, 'Please see attached')).toBe(false);

    // Empty related_company names do not count as a deal signal.
    expect(
      hasDealSignal(
        {
          topics: [],
          people: [],
          related_companies: [
            {
              company_name: '  ',
              reason: 'other',
              reason_summary: '',
              keywords: [],
              confidence: 'low',
            },
          ],
        },
        'Please see attached',
      ),
    ).toBe(false);

    // Null-safe when topics / related_companies missing on partial LLM payloads.
    expect(
      hasDealSignal({ people: [] } as never, 'Please see attached'),
    ).toBe(false);

    // Null entries in related_companies must not throw.
    expect(
      hasDealSignal(
        {
          topics: [],
          people: [],
          related_companies: [null as never, { company_name: 'Acme' } as never],
        } as never,
        'Please see attached',
      ),
    ).toBe(true);
  });
});

describe('live processEmail related-companies flag (MB-465)', () => {
  it('requests related companies when wantRelatedCompanies is true', () => {
    const out = processEmail(
      {
        message_id: '<m1@x>',
        date: '2026-01-01',
        subject: 'Deal mail',
        sender: { email: 'banker@goldman.com', name: 'Banker' },
        recipients: [{ email: 'a@external.com', name: 'A' }],
        cc: [],
        body: 'We represent Acme Corp in a sell-side process.',
        signature: '',
      },
      { wantRelatedCompanies: true },
    );
    expect(out.llm_payload?.want_related_companies).toBe(true);
  });
});

describe('isSourceTerminal', () => {
  it('is false for no state / in-progress / retryable failed', () => {
    expect(isSourceTerminal(null)).toBe(false);
    expect(isSourceTerminal({ status: 'in_progress', fail_count: 0 })).toBe(
      false,
    );
    expect(isSourceTerminal({ status: 'failed', fail_count: 1 })).toBe(false);
  });

  it('is true once completed, or failed with the budget spent', () => {
    expect(isSourceTerminal({ status: 'completed', fail_count: 0 })).toBe(true);
    expect(
      isSourceTerminal({ status: 'failed', fail_count: MAX_PROCESS_FAIL_COUNT }),
    ).toBe(true);
  });
});

describe('getSourceRunState', () => {
  it('returns the latest run row for a source_key', async () => {
    const db = {
      execute: vi
        .fn()
        .mockResolvedValue([{ status: 'in_progress', fail_count: 2 }]),
    };
    const state = await getSourceRunState(db as never, 'k1');
    expect(state).toEqual({ status: 'in_progress', fail_count: 2 });
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('returns null when no run exists', async () => {
    const db = { execute: vi.fn().mockResolvedValue([]) };
    expect(await getSourceRunState(db as never, 'k1')).toBeNull();
  });
});

describe('processMboxSource terminal short-circuit', () => {
  const noopStream = vi.fn(() => {
    throw new Error('openStream must not be called for terminal sources');
  });

  it('skips a completed source without opening the stream', async () => {
    const db = {
      execute: vi
        .fn()
        .mockResolvedValue([{ status: 'completed', fail_count: 0 }]),
    };
    const result = await processMboxSource(
      { sourceKey: 'k1', custodianEmail: 'a@b.co', openStream: noopStream },
      {},
      { db: db as never },
    );
    expect(result.status).toBe('completed');
    expect(noopStream).not.toHaveBeenCalled();
    // Only the getSourceRunState probe ran — no ensureRun insert.
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('skips an abandoned (budget-spent) source', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        { status: 'failed', fail_count: MAX_PROCESS_FAIL_COUNT },
      ]),
    };
    const result = await processMboxSource(
      { sourceKey: 'k1', custodianEmail: 'a@b.co', openStream: noopStream },
      {},
      { db: db as never },
    );
    expect(result.status).toBe('abandoned');
    expect(noopStream).not.toHaveBeenCalled();
  });
});

describe('persistHardFailure', () => {
  const emptyResult: EmailProcessResult = {
    run_id: 'run-1',
    status: 'failed',
    messages_seen: 0,
    messages_skipped: 0,
    messages_ingested: 0,
    attachments_uploaded: 0,
    message_offset: 0,
    fail_count: 0,
  };

  it('bumps fail_count on the run row and returns the next count', async () => {
    const db = { execute: vi.fn().mockResolvedValue([]) };
    const next = await persistHardFailure({
      db: db as never,
      runId: 'run-1',
      failCount: 0,
      result: emptyResult,
      err: new Error('ANTHROPIC_API_KEY is not configured'),
    });
    expect(next).toBe(1);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('reaches the abandon threshold at MAX', async () => {
    const db = { execute: vi.fn().mockResolvedValue([]) };
    const next = await persistHardFailure({
      db: db as never,
      runId: 'run-1',
      failCount: MAX_PROCESS_FAIL_COUNT - 1,
      result: emptyResult,
      err: new Error('boom'),
    });
    expect(next).toBe(MAX_PROCESS_FAIL_COUNT);
  });
});

function makeMbox(
  messages: Array<{
    id: string;
    from?: string;
    to?: string;
    subject?: string;
    body?: string;
  }>,
) {
  const content = messages
    .map((m) => {
      const from = m.from ?? 'banker@external.com';
      const to = m.to ?? 'alice@starcapital.co.id';
      const subject = m.subject ?? 'Project Deal Discussion';
      const body =
        m.body ??
        'We are pleased to discuss the acquisition terms and M&A advisory mandate for Project Falcon.';
      return [
        `From envelope-${m.id} Mon Jan  1 00:00:00 2024`,
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Date: Mon, 01 Jan 2024 10:00:00 +0000`,
        `Message-ID: <${m.id}>`,
        ``,
        body,
        ``,
      ].join('\n');
    })
    .join('\n');

  return async function* () {
    yield Buffer.from(content, 'utf-8');
  };
}

function createProcessDb(opts: {
  /** fail_count of the run being resumed. */
  runFailCount?: number;
  existingEmails?: string[];
  /** Rows a re-extract already wrote (matched by its `created_at >=` filter). */
  reextractedEmails?: string[];
  noteStatus?: Array<{ message_id: string; id: string; has_note: boolean }>;
}) {
  const existingEmailSet = new Set(opts.existingEmails ?? []);
  const noteStatus = opts.noteStatus ?? [];

  return {
    execute: vi.fn(async (query: unknown) => {
      const sqlStr = JSON.stringify(query);

      if (sqlStr.includes('has_note')) {
        return noteStatus;
      }

      if (
        sqlStr.includes('SELECT message_id FROM analytics.emails') &&
        sqlStr.includes('created_at >=')
      ) {
        return (opts.reextractedEmails ?? []).map((mid) => ({ message_id: mid }));
      }

      if (sqlStr.includes('email_process_runs')) {
        return [
          {
            id: 'run-1',
            message_offset: 0,
            fail_count: opts.runFailCount ?? 0,
            afd_uploaded_digests: [],
          },
        ];
      }

      if (sqlStr.includes('SELECT message_id FROM analytics.emails')) {
        return Array.from(existingEmailSet).map((mid) => ({
          message_id: mid,
        }));
      }

      if (sqlStr.includes('has_deal_topic')) {
        return [];
      }

      return [];
    }),
  };
}

describe('flushBatch stop_reason handling', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    anthropicMocks.create.mockReset();
    crmMocks.upsertEphemeralCrmBatch
      .mockReset()
      .mockResolvedValue({ emails_inserted: 1 });
    crmMocks.upsertEmailNotes.mockReset().mockResolvedValue(undefined);
  });

  const extraction = {
    content: [{ type: 'tool_use', input: { topics: [], people: [], related_companies: [] } }],
    stop_reason: 'end_turn',
  };
  const truncatedResponse = { content: [], stop_reason: 'max_tokens' };

  it('retries a truncated extraction once with the larger budget and keeps the email', async () => {
    anthropicMocks.create
      .mockResolvedValueOnce(truncatedResponse)
      .mockResolvedValueOnce(extraction);
    const db = createProcessDb({ existingEmails: [] });

    const result = await processMboxSource(
      {
        sourceKey: 'src-truncation-retry',
        custodianEmail: 'alice@starcapital.co.id',
        openStream: makeMbox([{ id: 'msg-trunc-1' }]),
      },
      {},
      { db: db as never },
    );

    expect(result.status).toBe('completed');
    expect(result.fail_count).toBe(0);
    expect(anthropicMocks.create.mock.calls.map(([req]) => req.max_tokens)).toEqual([
      EXTRACT_MAX_TOKENS,
      EXTRACT_MAX_TOKENS_RETRY,
    ]);
    expect(crmMocks.upsertEphemeralCrmBatch).toHaveBeenCalledWith(
      [expect.objectContaining({ message_id: 'msg-trunc-1' })],
      expect.anything(),
    );
  });

  it('skips an email that overflows even the larger budget and keeps processing the file', async () => {
    anthropicMocks.create.mockImplementation(async (req: { messages: Array<{ content: unknown }> }) =>
      JSON.stringify(req.messages).includes('VERY-LONG-THREAD') ? truncatedResponse : extraction,
    );
    const db = createProcessDb({ existingEmails: [] });

    const result = await processMboxSource(
      {
        sourceKey: 'src-truncation-skip',
        custodianEmail: 'alice@starcapital.co.id',
        openStream: makeMbox([
          {
            id: 'msg-trunc-long',
            body: 'VERY-LONG-THREAD: acquisition terms and M&A advisory mandate for Project Falcon.',
          },
          { id: 'msg-after-long' },
        ]),
      },
      {},
      { db: db as never },
    );

    // Not an llm_retry: the same email would overflow on every attempt and
    // abandon the rest of the file.
    expect(result.status).toBe('completed');
    expect(result.fail_count).toBe(0);
    expect(result.messages_skipped).toBe(1);
    expect(result.message_offset).toBe(2);
    // Fail closed: no extraction means no is_personal verdict, so not ingested.
    const ingested = crmMocks.upsertEphemeralCrmBatch.mock.calls.flatMap(([msgs]) =>
      (msgs as Array<{ message_id: string }>).map((m) => m.message_id),
    );
    expect(ingested).toEqual(['msg-after-long']);
  });
});

describe('Backfill notes for existing emails', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    anthropicMocks.create.mockReset();
    crmMocks.upsertEphemeralCrmBatch
      .mockReset()
      .mockResolvedValue({ emails_inserted: 1 });
    crmMocks.upsertEmailNotes.mockReset().mockResolvedValue(undefined);
  });

  it('an existing email with no note row gets exactly one note-only call and a note write', async () => {
    anthropicMocks.create.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          input: {
            email_note: {
              summary: 'Backfilled summary of discussion.',
              key_points: ['Key point 1'],
              next_step: 'Send deck',
              next_step_status: 'action',
              sentiment: 'positive',
              counterparty_roles: [
                {
                  address: 'banker@external.com',
                  label: 'advisory',
                  confidence: 'high',
                  evidence: 'M&A sell-side advisor.',
                },
              ],
            },
          },
        },
      ],
      stop_reason: 'end_turn',
    });

    const db = createProcessDb({
      existingEmails: ['msg-dup-1'],
      noteStatus: [
        {
          message_id: 'msg-dup-1',
          id: '00000000-0000-0000-0000-000000000001',
          has_note: false,
        },
      ],
    });

    const result = await processMboxSource(
      {
        sourceKey: 'src-backfill-1',
        custodianEmail: 'alice@starcapital.co.id',
        openStream: makeMbox([{ id: 'msg-dup-1' }]),
      },
      {},
      { db: db as never },
    );

    expect(result.status).toBe('completed');
    expect(anthropicMocks.create).toHaveBeenCalledTimes(1);
    expect(crmMocks.upsertEmailNotes).toHaveBeenCalledTimes(1);
    expect(crmMocks.upsertEmailNotes).toHaveBeenCalledWith(
      db,
      expect.arrayContaining([
        expect.objectContaining({
          emailId: '00000000-0000-0000-0000-000000000001',
          note: expect.objectContaining({
            summary: 'Backfilled summary of discussion.',
          }),
        }),
      ]),
    );
    expect(crmMocks.upsertEphemeralCrmBatch).not.toHaveBeenCalled();

    // The backfilled note makes the contact's overview stale: one refresh
    // request for the custodian's workspaces, after the run.
    const calls = overviewRefreshCalls();
    expect(calls).toHaveLength(1);
    const [, init] = calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'x-api-secret': expect.any(String) });
    const body = JSON.parse(init.body);
    expect(body.workspaceIds).toEqual(['ws-1']);
    expect(Number.isNaN(Date.parse(body.since))).toBe(false);
  });

  it('a failed overview refresh never fails the run', async () => {
    anthropicMocks.create.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          input: {
            email_note: {
              summary: 'Backfilled summary.',
              key_points: [],
              next_step: null,
              next_step_status: 'none',
              sentiment: 'neutral',
              counterparty_roles: [],
            },
          },
        },
      ],
      stop_reason: 'end_turn',
    });
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const db = createProcessDb({
      existingEmails: ['msg-dup-9'],
      noteStatus: [
        { message_id: 'msg-dup-9', id: '00000000-0000-0000-0000-000000000009', has_note: false },
      ],
    });

    const result = await processMboxSource(
      {
        sourceKey: 'src-backfill-9',
        custodianEmail: 'alice@starcapital.co.id',
        openStream: makeMbox([{ id: 'msg-dup-9' }]),
      },
      {},
      { db: db as never },
    );

    expect(result.status).toBe('completed');
    expect(overviewRefreshCalls()).toHaveLength(1);
  });

  it('an existing email that already has a note row gets no call', async () => {
    const db = createProcessDb({
      existingEmails: ['msg-dup-has-note'],
      noteStatus: [
        {
          message_id: 'msg-dup-has-note',
          id: '00000000-0000-0000-0000-000000000002',
          has_note: true,
        },
      ],
    });

    const result = await processMboxSource(
      {
        sourceKey: 'src-backfill-2',
        custodianEmail: 'alice@starcapital.co.id',
        openStream: makeMbox([{ id: 'msg-dup-has-note' }]),
      },
      {},
      { db: db as never },
    );

    expect(result.status).toBe('completed');
    expect(anthropicMocks.create).not.toHaveBeenCalled();
    expect(crmMocks.upsertEmailNotes).not.toHaveBeenCalled();
    expect(crmMocks.upsertEphemeralCrmBatch).not.toHaveBeenCalled();
    // Nothing written, nothing to refresh.
    expect(overviewRefreshCalls()).toHaveLength(0);
  });

  it('a failed backfill call does not set llm_retry and does not stop the offset advancing', async () => {
    anthropicMocks.create.mockRejectedValue(new Error('anthropic rate limit'));

    const db = createProcessDb({
      existingEmails: ['msg-dup-fail'],
      noteStatus: [
        {
          message_id: 'msg-dup-fail',
          id: '00000000-0000-0000-0000-000000000003',
          has_note: false,
        },
      ],
    });

    const result = await processMboxSource(
      {
        sourceKey: 'src-backfill-3',
        custodianEmail: 'alice@starcapital.co.id',
        openStream: makeMbox([{ id: 'msg-dup-fail' }]),
      },
      {},
      { db: db as never },
    );

    expect(result.status).toBe('completed');
    expect(result.message_offset).toBe(1);
    expect(crmMocks.upsertEphemeralCrmBatch).not.toHaveBeenCalled();
    expect(crmMocks.upsertEmailNotes).not.toHaveBeenCalled();
  });

  it('the CRM upsert is never called for backfilled emails', async () => {
    anthropicMocks.create.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          input: {
            email_note: {
              summary: 'Discussion',
              key_points: [],
              next_step: null,
              next_step_status: 'none',
              sentiment: 'neutral',
              counterparty_roles: [],
            },
          },
        },
      ],
      stop_reason: 'end_turn',
    });

    const db = createProcessDb({
      existingEmails: ['msg-dup-nocrm'],
      noteStatus: [
        {
          message_id: 'msg-dup-nocrm',
          id: '00000000-0000-0000-0000-000000000004',
          has_note: false,
        },
      ],
    });

    await processMboxSource(
      {
        sourceKey: 'src-backfill-nocrm',
        custodianEmail: 'alice@starcapital.co.id',
        openStream: makeMbox([{ id: 'msg-dup-nocrm' }]),
      },
      {},
      { db: db as never },
    );

    expect(crmMocks.upsertEphemeralCrmBatch).not.toHaveBeenCalled();
  });
});


const extraction = {
  topics: [{ name: 'Project Falcon sale', is_deal_related: true }],
  related_companies: [],
  people: [],
  is_personal: false,
  email_note: {
    summary: 'Banker shares the Project Falcon teaser.',
    key_points: [],
    next_step: null,
    next_step_status: 'none',
    sentiment: 'neutral',
    counterparty_roles: [],
  },
};

/** Extraction for `extract_email_info`, a deal-teaser verdict for PDF triage. */
function answerByTool() {
  anthropicMocks.create.mockImplementation(
    async (req: { tool_choice?: { name?: string } }) => ({
      content: [
        {
          type: 'tool_use',
          input:
            req.tool_choice?.name === 'classify_document'
              ? { doc_type: 'teaser', confidence: 'high' }
              : extraction,
        },
      ],
      stop_reason: 'end_turn',
    }),
  );
}

/** A real 1-page PDF, padded past the attachment minimum size. */
let validPdf: Buffer;
beforeAll(async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.setSubject('Project Falcon teaser '.repeat(1_500));
  validPdf = Buffer.from(await doc.save());
});

/** One deal email carrying a PDF large enough to reach triage. */
function makePdfMbox(
  id: string,
  headers: { from?: string; to?: string; cc?: string } = {},
) {
  const pdf = validPdf.toString('base64').replace(/(.{76})/g, '$1\n');
  const content = [
    `From envelope-${id} Mon Jan  1 00:00:00 2024`,
    `From: ${headers.from ?? 'banker@external.com'}`,
    `To: ${headers.to ?? 'alice@starcapital.co.id'}`,
    ...(headers.cc ? [`Cc: ${headers.cc}`] : []),
    'Subject: Project Falcon teaser',
    'Date: Mon, 01 Jan 2024 10:00:00 +0000',
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BOUND"',
    '',
    '--BOUND',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Attached is the teaser for the Project Falcon acquisition and M&A advisory mandate.',
    '--BOUND',
    'Content-Type: application/pdf; name="Falcon_Teaser.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="Falcon_Teaser.pdf"',
    '',
    pdf,
    '--BOUND--',
    '',
  ].join('\n');
  return async function* () {
    yield Buffer.from(content, 'utf-8');
  };
}

const uploadUrlCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/smart-files/upload-url'));

describe('Re-extract export', () => {
  const SINCE = '2026-10-22 01:00:00.123456+00';

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    anthropicMocks.create.mockReset();
    crmMocks.upsertEphemeralCrmBatch.mockReset().mockResolvedValue({ emails_inserted: 1 });
    crmMocks.upsertEmailNotes.mockReset().mockResolvedValue(undefined);
    extractTextMock.mockReset().mockResolvedValue('Project Falcon teaser');
  });

  afterEach(() => {
    extractTextMock.mockReset();
  });

  it('extracts an email ingested before the re-extract again and replaces its row', async () => {
    answerByTool();
    const db = createProcessDb({ existingEmails: ['msg-old-1'], reextractedEmails: [] });

    const result = await processMboxSource(
      {
        sourceKey: 'src-reextract-1',
        custodianEmail: 'alice@starcapital.co.id',
        reextractSince: SINCE,
        openStream: makeMbox([{ id: 'msg-old-1' }]),
      },
      {},
      { db: db as never },
    );

    expect(result.status).toBe('completed');
    expect(anthropicMocks.create).toHaveBeenCalledTimes(1);
    expect(crmMocks.upsertEphemeralCrmBatch).toHaveBeenCalledWith(
      [expect.objectContaining({ message_id: 'msg-old-1' })],
      { db, replaceBefore: SINCE },
    );
  });

  it('skips an email this re-extract already wrote, with no LLM call', async () => {
    const db = createProcessDb({
      existingEmails: ['msg-done-1'],
      reextractedEmails: ['msg-done-1'],
      noteStatus: [{ message_id: 'msg-done-1', id: 'e-1', has_note: true }],
    });

    const result = await processMboxSource(
      {
        sourceKey: 'src-reextract-2',
        custodianEmail: 'alice@starcapital.co.id',
        reextractSince: SINCE,
        openStream: makeMbox([{ id: 'msg-done-1' }]),
      },
      {},
      { db: db as never },
    );

    expect(result.status).toBe('completed');
    expect(anthropicMocks.create).not.toHaveBeenCalled();
    expect(crmMocks.upsertEphemeralCrmBatch).not.toHaveBeenCalled();
  });

  it('a normal ingest passes no replaceBefore', async () => {
    answerByTool();
    const db = createProcessDb({ existingEmails: [] });

    await processMboxSource(
      {
        sourceKey: 'src-reextract-3',
        custodianEmail: 'alice@starcapital.co.id',
        openStream: makeMbox([{ id: 'msg-new-1' }]),
      },
      {},
      { db: db as never },
    );

    expect(crmMocks.upsertEphemeralCrmBatch).toHaveBeenCalledWith(expect.any(Array), {
      db,
      replaceBefore: null,
    });
  });

  it('sends a deal attachment to Smart Files on a normal ingest', async () => {
    answerByTool();
    const db = createProcessDb({ existingEmails: [] });

    await processMboxSource(
      {
        sourceKey: 'src-reextract-4',
        custodianEmail: 'alice@starcapital.co.id',
        openStream: makePdfMbox('msg-pdf-1'),
      },
      {},
      { db: db as never },
    );

    expect(uploadUrlCalls().length).toBeGreaterThan(0);
  });

  it('never triages or sends an attachment to Smart Files on a re-extract', async () => {
    answerByTool();
    const db = createProcessDb({ existingEmails: ['msg-pdf-2'], reextractedEmails: [] });

    const result = await processMboxSource(
      {
        sourceKey: 'src-reextract-5',
        custodianEmail: 'alice@starcapital.co.id',
        reextractSince: SINCE,
        openStream: makePdfMbox('msg-pdf-2'),
      },
      {},
      { db: db as never },
    );

    expect(result.status).toBe('completed');
    expect(crmMocks.upsertEphemeralCrmBatch).toHaveBeenCalledTimes(1);
    expect(
      anthropicMocks.create.mock.calls.filter(
        ([req]) => req.tool_choice?.name === 'classify_document',
      ),
    ).toHaveLength(0);
    expect(uploadUrlCalls()).toHaveLength(0);
  });
});

describe('attachments on mail from an internal sender', () => {
  const triageCalls = () =>
    anthropicMocks.create.mock.calls.filter(
      ([req]) => req.tool_choice?.name === 'classify_document',
    );

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    anthropicMocks.create.mockReset();
    crmMocks.upsertEphemeralCrmBatch.mockReset().mockResolvedValue({ emails_inserted: 1 });
    crmMocks.upsertEmailNotes.mockReset().mockResolvedValue(undefined);
    extractTextMock.mockReset().mockResolvedValue('Project Falcon teaser');
  });

  afterEach(() => {
    extractTextMock.mockReset();
  });

  it('ingests the email into the CRM but never triages or sends its attachment to Smart Files', async () => {
    answerByTool();
    const db = createProcessDb({ existingEmails: [] });

    const result = await processMboxSource(
      {
        sourceKey: 'src-internal-1',
        custodianEmail: 'dessi@starcapital.co.id',
        openStream: makePdfMbox('msg-internal-1', {
          from: 'kartyan@starcapital.co.id',
          to: 'banker@external.com',
          cc: 'dessi@starcapital.co.id',
        }),
      },
      {},
      { db: db as never },
    );

    expect(result.status).toBe('completed');
    expect(crmMocks.upsertEphemeralCrmBatch).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          message_id: 'msg-internal-1',
          from_address: 'kartyan@starcapital.co.id',
          direction: 'outbound',
        }),
      ],
      expect.anything(),
    );
    expect(triageCalls()).toHaveLength(0);
    expect(uploadUrlCalls()).toHaveLength(0);
  });

  it('applies to every internal group domain, not only starcapital.co.id', async () => {
    answerByTool();
    const db = createProcessDb({ existingEmails: [] });

    await processMboxSource(
      {
        sourceKey: 'src-internal-2',
        custodianEmail: 'dessi@starcapital.co.id',
        openStream: makePdfMbox('msg-internal-2', {
          from: 'Nico <Nico@SMMA.id>',
          to: 'banker@external.com, dessi@starcapital.co.id',
        }),
      },
      {},
      { db: db as never },
    );

    expect(crmMocks.upsertEphemeralCrmBatch).toHaveBeenCalledTimes(1);
    expect(uploadUrlCalls()).toHaveLength(0);
  });

  it('does not send the attachment when resuming an email that is already ingested', async () => {
    answerByTool();
    const db = createProcessDb({ existingEmails: ['msg-internal-3'] });

    const result = await processMboxSource(
      {
        sourceKey: 'src-internal-3',
        custodianEmail: 'dessi@starcapital.co.id',
        openStream: makePdfMbox('msg-internal-3', {
          from: 'kartyan@starcapital.co.id',
          to: 'banker@external.com',
        }),
      },
      {},
      { db: db as never },
    );

    expect(result.status).toBe('completed');
    expect(triageCalls()).toHaveLength(0);
    expect(uploadUrlCalls()).toHaveLength(0);
  });

  it('still sends the attachment when the sender is external and we are on the thread', async () => {
    answerByTool();
    const db = createProcessDb({ existingEmails: [] });

    await processMboxSource(
      {
        sourceKey: 'src-internal-4',
        custodianEmail: 'dessi@starcapital.co.id',
        openStream: makePdfMbox('msg-external-4', {
          from: 'banker@external.com',
          to: 'dessi@starcapital.co.id',
          cc: 'kartyan@starcapital.co.id',
        }),
      },
      {},
      { db: db as never },
    );

    expect(uploadUrlCalls().length).toBeGreaterThan(0);
  });
});

describe('crash-loop guard', () => {
  /** fail_count written by each `updateRun`, in order (null = left unchanged). */
  function failCountWrites(db: ReturnType<typeof createProcessDb>): Array<number | null> {
    return db.execute.mock.calls
      .map(([q]) => new PgDialect().sqlToQuery(q as never))
      .filter((q) => q.sql.includes('UPDATE analytics.email_process_runs SET'))
      .map((q) => q.params[7] as number | null);
  }

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    anthropicMocks.create.mockReset();
    crmMocks.upsertEphemeralCrmBatch.mockReset().mockResolvedValue({ emails_inserted: 1 });
    crmMocks.upsertEmailNotes.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts the attempt before any extraction, so a process crash still spends budget', async () => {
    const db = createProcessDb({ runFailCount: 2 });
    let writesBeforeLlm: Array<number | null> = [];
    anthropicMocks.create.mockImplementation(async () => {
      writesBeforeLlm = failCountWrites(db);
      throw new Error('stand-in for a crash: nothing after this point runs');
    });

    await processMboxSource(
      {
        sourceKey: 'src-guard-1',
        custodianEmail: 'alice@starcapital.co.id',
        openStream: makeMbox([{ id: 'msg-guard-1' }]),
      },
      {},
      { db: db as never },
    );

    expect(writesBeforeLlm[0]).toBe(3);
  });

  it('gives the attempt back once a batch makes progress', async () => {
    anthropicMocks.create.mockResolvedValue({
      content: [{ type: 'tool_use', input: { topics: [], people: [], related_companies: [] } }],
      stop_reason: 'end_turn',
    });
    const db = createProcessDb({ runFailCount: 2 });

    const result = await processMboxSource(
      {
        sourceKey: 'src-guard-2',
        custodianEmail: 'alice@starcapital.co.id',
        openStream: makeMbox([{ id: 'msg-guard-2' }]),
      },
      {},
      { db: db as never },
    );

    expect(result.status).toBe('completed');
    expect(result.fail_count).toBe(0);
    const writes = failCountWrites(db);
    expect(writes[0]).toBe(3);
    expect(writes).toContain(0);
    expect(writes.at(-1)).toBe(0);
  });

  it('a soft stop before any progress restores the previous count', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
    const db = createProcessDb({ runFailCount: 2 });

    const result = await processMboxSource(
      {
        sourceKey: 'src-guard-3',
        custodianEmail: 'alice@starcapital.co.id',
        openStream: makeMbox([{ id: 'msg-guard-3a' }, { id: 'msg-guard-3b' }]),
      },
      { softStopMs: 30_000 },
      { db: db as never },
    );

    expect(result.status).toBe('in_progress');
    expect(anthropicMocks.create).not.toHaveBeenCalled();
    const writes = failCountWrites(db);
    expect(writes[0]).toBe(3);
    expect(writes.at(-1)).toBe(2);
  });

  it('a graceful failure is counted once, not twice', async () => {
    anthropicMocks.create.mockRejectedValue(new Error('anthropic down'));
    const db = createProcessDb({ runFailCount: 2 });

    const result = await processMboxSource(
      {
        sourceKey: 'src-guard-4',
        custodianEmail: 'alice@starcapital.co.id',
        openStream: makeMbox([{ id: 'msg-guard-4' }]),
      },
      {},
      { db: db as never },
    );

    expect(result.fail_count).toBe(3);
    expect(failCountWrites(db).filter((n) => n !== null).every((n) => n === 3)).toBe(true);
  });
});

describe('hard-failure cursor', () => {
  const pending = { id: 'msg-cursor-pending' };
  // Internal-only mail is dropped by the privacy filter before the batch.
  const skipped = {
    id: 'msg-cursor-skipped',
    from: 'alice@starcapital.co.id',
    to: 'bob@starcapital.co.id',
  };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    anthropicMocks.create.mockReset().mockResolvedValue({
      content: [{ type: 'tool_use', input: { topics: [], people: [], related_companies: [] } }],
      stop_reason: 'end_turn',
    });
    crmMocks.upsertEphemeralCrmBatch
      .mockReset()
      .mockRejectedValue(new Error('duplicate key value violates unique constraint'));
    crmMocks.upsertEmailNotes.mockReset().mockResolvedValue(undefined);
  });

  it('keeps the cursor before a pending message when a later skipped one is read first', async () => {
    const result = await processMboxSource(
      {
        sourceKey: 'src-cursor-1',
        custodianEmail: 'alice@starcapital.co.id',
        openStream: makeMbox([pending, skipped]),
      },
      {},
      { db: createProcessDb({}) as never },
    );

    expect(result.status).toBe('failed');
    expect(result.messages_skipped).toBe(1);
    // The retry must start at the pending message, not after the skipped one.
    expect(result.message_offset).toBe(0);
  });

  it('still advances past skipped messages when nothing is pending', async () => {
    const result = await processMboxSource(
      {
        sourceKey: 'src-cursor-2',
        custodianEmail: 'alice@starcapital.co.id',
        openStream: makeMbox([skipped, pending]),
      },
      {},
      { db: createProcessDb({}) as never },
    );

    expect(result.status).toBe('failed');
    expect(result.message_offset).toBe(1);
  });
});
