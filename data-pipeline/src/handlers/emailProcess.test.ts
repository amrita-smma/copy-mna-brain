import { describe, expect, it, vi } from 'vitest';
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
  subjectLooksDealRelated,
  hasDealSignal,
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
    expect(PERSONAL_MAIL_DOMAINS.has('gmail.com')).toBe(true);
  });

  it('keeps outlook.com personal-only so deal mail to outlook counterparties is not internal_only', () => {
    expect(PERSONAL_MAIL_DOMAINS.has('outlook.com')).toBe(true);
    expect(INTERNAL_MAIL_DOMAINS.has('outlook.com')).toBe(false);
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
      model: 'claude-haiku-4-5-20251001',
      extractText,
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
      model: 'claude-haiku-4-5-20251001',
      extractText,
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
      model: 'claude-haiku-4-5-20251001',
      extractText,
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
      model: 'claude-haiku-4-5-20251001',
      extractText,
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
      model: 'claude-haiku-4-5-20251001',
      extractText,
    });
    expect(outcome).toEqual({ kind: 'skip' });
    expect(extractText).not.toHaveBeenCalled();
  });

  it('skips (does not rewind) when PDF validation fails deterministically', async () => {
    const extractText = vi.fn().mockRejectedValue(new Error('encrypted PDF'));
    const create = vi.fn();
    const outcome = await triageAttachmentForSmartFiles({
      mime: 'application/pdf',
      fileName: 'encrypted.pdf',
      bytes: Buffer.from('fake-pdf'),
      client: { messages: { create } } as never,
      model: 'claude-haiku-4-5-20251001',
      extractText,
    });
    expect(extractText).toHaveBeenCalledWith(
      Buffer.from('fake-pdf'),
      'application/pdf',
      'encrypted.pdf',
    );
    expect(outcome).toEqual({ kind: 'skip' });
    expect(create).not.toHaveBeenCalled();
  });

  it('retries PDF when local validation succeeds but Anthropic fails', async () => {
    const extractText = vi.fn().mockResolvedValue('');
    const create = vi.fn().mockRejectedValue(new Error('anthropic down'));
    const outcome = await triageAttachmentForSmartFiles({
      mime: 'application/pdf',
      fileName: 'scan.pdf',
      bytes: Buffer.from('fake-pdf'),
      client: { messages: { create } } as never,
      model: 'claude-haiku-4-5-20251001',
      extractText,
    });
    expect(outcome.kind).toBe('retry');
    expect(create).toHaveBeenCalledOnce();
  });

  it('skips oversized Office before extract', async () => {
    const extractText = vi.fn();
    const outcome = await triageAttachmentForSmartFiles({
      mime: officeMime,
      fileName: 'huge.docx',
      bytes: Buffer.alloc(PDF_TRIAGE_SOFT_MAX_BYTES + 1),
      client: mockClient({ doc_type: 'im', confidence: 'high' }),
      model: 'claude-haiku-4-5-20251001',
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
      model: 'claude-haiku-4-5-20251001',
      extractText,
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
      model: 'claude-haiku-4-5-20251001',
      extractText,
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
      model: 'claude-haiku-4-5-20251001',
      extractText,
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
      'claude-haiku-4-5-20251001',
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
      'claude-haiku-4-5-20251001',
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
