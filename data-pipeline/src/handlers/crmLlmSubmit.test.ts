import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { runCrmLlmSubmit } from './crmLlmSubmit';

const mocks = vi.hoisted(() => ({
  // Anthropic SDK
  batchesCreate: vi.fn(),
  messagesCreate: vi.fn(),
  // processEmail (the library function)
  processEmail: vi.fn(),
  // repos
  upsertExtract: vi.fn(),
  setLlmResult: vi.fn(),
  insertBatch: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: mocks.messagesCreate,
      batches: { create: mocks.batchesCreate },
    };
  },
}));

vi.mock('../mboxParser', async () => {
  const actual = await vi.importActual<typeof import('../mboxParser')>(
    '../mboxParser',
  );
  return {
    ...actual,
    processEmail: mocks.processEmail,
  };
});

vi.mock('../repositories', () => ({
  RawEmailEnrichmentRepository: class {
    upsertExtract = mocks.upsertExtract;
    setLlmResult = mocks.setLlmResult;
  },
  LlmBatchRepository: class {
    insert = mocks.insertBatch;
  },
}));

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    message_id: 'msg-1@x',
    from_address: 'a@b.com',
    from_display_name: 'A',
    to_addresses: ['x@y.com'],
    cc_addresses: [],
    subject: 'hi',
    body_text: 'body',
    sent_at: '2026-04-01T00:00:00Z',
    custodian_email: 'h@s.co',
    llm_status: 'pending',
    ...overrides,
  };
}

describe('runCrmLlmSubmit', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    Object.values(mocks).forEach((m) => {
      if (typeof m === 'function' && 'mockClear' in m) (m as ReturnType<typeof vi.fn>).mockClear();
    });
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    mocks.upsertExtract.mockResolvedValue({});
    mocks.setLlmResult.mockResolvedValue({});
    mocks.insertBatch.mockResolvedValue({ id: 'b1' });
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = originalEnv;
    vi.clearAllMocks();
  });

  it('throws if ANTHROPIC_API_KEY is not configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(
      runCrmLlmSubmit({}, { db: makeDb() as never, job: { id: 'j1' } as never }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('marks needs_llm=false rows as not_needed without calling Anthropic', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([makeRow({ id: 'r1' })]);
    mocks.processEmail.mockReturnValueOnce({
      message_id: 'msg-1@x',
      subject: 'hi',
      sender: { name: 'A', email: 'a@b.com' },
      candidates: [],
      domain_tag: null,
      needs_llm: false,
      llm_payload: null,
    });

    const result = await runCrmLlmSubmit(
      { mode: 'batch' },
      { db: db as never, job: { id: 'j1' } as never },
    );

    expect(result.rows_no_llm).toBe(1);
    expect(result.batches_submitted).toBe(0);
    expect(mocks.batchesCreate).not.toHaveBeenCalled();
  });

  it('submits a batch for rows needing LLM and inserts an llm_batches row', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([makeRow({ id: 'r1' })]);
    mocks.processEmail.mockReturnValueOnce({
      message_id: 'msg-1@x',
      subject: 'hi',
      sender: { name: 'A', email: 'a@b.com' },
      candidates: [{ type: 'email', value: 'a@b.com', context: 'sig' }],
      domain_tag: null,
      needs_llm: true,
      llm_payload: { body_snippet: 'hi', candidates: [], want_topics: true, want_names: true },
    });
    mocks.batchesCreate.mockResolvedValueOnce({ id: 'msgbatch_xyz' });

    const result = await runCrmLlmSubmit(
      { mode: 'batch' },
      { db: db as never, job: { id: 'j1' } as never },
    );

    expect(result.batches_submitted).toBe(1);
    expect(result.requests_submitted).toBe(1);
    expect(mocks.insertBatch).toHaveBeenCalled();
    const insertArg = mocks.insertBatch.mock.calls[0][0];
    expect(insertArg).toMatchObject({
      anthropic_batch_id: 'msgbatch_xyz',
      status: 'in_progress',
      request_count: 1,
      submit_job_id: 'j1',
    });
  });

  it('filters out auto-replies before extraction (no LLM, no CRM ingest)', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([
      makeRow({
        id: 'r1',
        raw_headers: { 'auto-submitted': 'auto-replied' },
      }),
    ]);

    const result = await runCrmLlmSubmit(
      { mode: 'batch' },
      { db: db as never, job: { id: 'j1' } as never },
    );

    expect(result.rows_filtered).toBe(1);
    expect(result.rows_extracted).toBe(0);
    expect(mocks.processEmail).not.toHaveBeenCalled();
    expect(mocks.batchesCreate).not.toHaveBeenCalled();
  });

  it('filters out newsletters via List-Unsubscribe header', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([
      makeRow({
        id: 'r1',
        raw_headers: { 'list-unsubscribe': '<mailto:unsub@example.com>' },
      }),
    ]);

    const result = await runCrmLlmSubmit(
      { mode: 'batch' },
      { db: db as never, job: { id: 'j1' } as never },
    );

    expect(result.rows_filtered).toBe(1);
  });

  it('filters out mail where every sender and recipient is on the internal-domain list', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([
      makeRow({
        id: 'r1',
        raw_headers: { from: 'alice@smma.id', to: 'bob@smma.id' },
      }),
    ]);

    const result = await runCrmLlmSubmit(
      { mode: 'batch' },
      { db: db as never, job: { id: 'j1' } as never },
    );

    expect(result.rows_filtered).toBe(1);
    expect(result.rows_extracted).toBe(0);
    expect(mocks.processEmail).not.toHaveBeenCalled();
  });

  it('keeps outbound mail from an internal sender to an external recipient (needed for response-time tracking)', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([
      makeRow({
        id: 'r1',
        raw_headers: { from: 'alice@smma.id', to: 'bob@external.com' },
      }),
    ]);
    mocks.processEmail.mockReturnValueOnce({
      message_id: 'msg-1@x',
      subject: 'hi',
      sender: { name: 'Alice', email: 'alice@smma.id' },
      candidates: [],
      domain_tag: null,
      needs_llm: false,
      llm_payload: null,
    });

    const result = await runCrmLlmSubmit(
      { mode: 'batch' },
      { db: db as never, job: { id: 'j1' } as never },
    );

    expect(result.rows_filtered).toBe(0);
    expect(result.rows_extracted).toBe(1);
    expect(mocks.processEmail).toHaveBeenCalled();
  });

  it('keeps inbound mail from an external sender to an internal recipient', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([
      makeRow({
        id: 'r1',
        raw_headers: { from: 'bob@external.com', to: 'alice@smma.id' },
      }),
    ]);
    mocks.processEmail.mockReturnValueOnce({
      message_id: 'msg-1@x',
      subject: 'hi',
      sender: { name: 'Bob', email: 'bob@external.com' },
      candidates: [],
      domain_tag: null,
      needs_llm: false,
      llm_payload: null,
    });

    const result = await runCrmLlmSubmit(
      { mode: 'batch' },
      { db: db as never, job: { id: 'j1' } as never },
    );

    expect(result.rows_filtered).toBe(0);
    expect(result.rows_extracted).toBe(1);
    expect(mocks.processEmail).toHaveBeenCalled();
  });

  it('sync mode calls messages.create per row and marks enriched', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([makeRow({ id: 'r1' })]);
    mocks.processEmail.mockReturnValueOnce({
      message_id: 'msg-1@x',
      subject: 'hi',
      sender: { name: 'A', email: 'a@b.com' },
      candidates: [],
      domain_tag: null,
      needs_llm: true,
      llm_payload: { body_snippet: 'hi', candidates: [], want_topics: true, want_names: true },
    });
    mocks.messagesCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          input: { topics: ['nda'], people: [] },
        },
      ],
    });

    const result = await runCrmLlmSubmit(
      { mode: 'sync' },
      { db: db as never, job: { id: 'j1' } as never },
    );

    expect(result.sync_enriched).toBe(1);
    expect(mocks.setLlmResult).toHaveBeenCalled();
    const setArg = mocks.setLlmResult.mock.calls[0];
    expect(setArg[0]).toBe('r1');
    expect(setArg[1].topics).toEqual(['nda']);
  });

  it('sync mode drops personal/1-1 emails as filtered without ingesting evidence', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([makeRow({ id: 'r1' })]);
    mocks.processEmail.mockReturnValueOnce({
      message_id: 'msg-1@x',
      subject: 'coffee',
      sender: { name: 'A', email: 'a@b.com' },
      candidates: [],
      domain_tag: null,
      needs_llm: true,
      llm_payload: { body_snippet: 'lets grab coffee', candidates: [], want_topics: true, want_names: true },
    });
    mocks.messagesCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          input: { is_personal: true, topics: [], people: [], related_companies: [] },
        },
      ],
    });

    const result = await runCrmLlmSubmit(
      { mode: 'sync' },
      { db: db as never, job: { id: 'j1' } as never },
    );

    expect(result.rows_filtered).toBe(1);
    expect(result.sync_enriched).toBe(0);
    // No CRM evidence written for a personal email.
    expect(mocks.setLlmResult).not.toHaveBeenCalled();
  });

  it('sync mode tolerates tool output that omits the people field', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([makeRow({ id: 'r1' })]);
    mocks.processEmail.mockReturnValueOnce({
      message_id: 'msg-1@x',
      subject: 'hi',
      sender: { name: 'A', email: 'a@b.com' },
      candidates: [],
      domain_tag: null,
      needs_llm: true,
      llm_payload: { body_snippet: 'hi', candidates: [], want_topics: true, want_names: true },
    });
    // Model returned topics but no `people` key at all — must not throw.
    mocks.messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', input: { topics: ['nda'] } }],
    });

    const result = await runCrmLlmSubmit(
      { mode: 'sync' },
      { db: db as never, job: { id: 'j1' } as never },
    );

    expect(result.sync_enriched).toBe(1);
    expect(result.errors).toBe(0);
    expect(mocks.setLlmResult.mock.calls[0][1].people).toEqual([]);
  });
});
