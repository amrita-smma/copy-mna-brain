import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { runCrmDomainClassify } from './crmDomainClassify';

const mocks = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  listUnknownDomains: vi.fn(),
  upsertBatch: vi.fn(),
  execute: vi.fn(),
  readFileSync: vi.fn(),
  listInternalDomains: vi.fn(),
  listExcludedDomains: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: mocks.messagesCreate,
    };
  },
}));

vi.mock('@/lib/repositories', () => ({
  EmployerOverrideRepository: class {
    listInternalDomains = mocks.listInternalDomains;
    listExcludedDomains = mocks.listExcludedDomains;
  },
}));

vi.mock('../repositories', () => ({
  DomainClassificationRepository: class {
    listUnknownDomains = mocks.listUnknownDomains;
    upsertBatch = mocks.upsertBatch;
  },
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: mocks.readFileSync,
  };
});

function makeDb() {
  return {
    execute: mocks.execute,
  };
}

describe('runCrmDomainClassify', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    Object.values(mocks).forEach((m) => {
      if (typeof m === 'function' && 'mockClear' in m) (m as ReturnType<typeof vi.fn>).mockClear();
    });
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    // Domain config now comes from employer_overrides (DB), not a file.
    mocks.listInternalDomains.mockResolvedValue(['starcapital.co.id']);
    mocks.listExcludedDomains.mockResolvedValue(['fireflies.ai']);
    mocks.readFileSync.mockReturnValue('{}');
    mocks.listUnknownDomains.mockResolvedValue([]);
    mocks.upsertBatch.mockResolvedValue([]);
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = originalEnv;
    vi.clearAllMocks();
  });

  it('throws when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(
      runCrmDomainClassify({}, { db: makeDb() as never, job: { id: 'j1' } as never }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('returns immediately when no candidate domains exist', async () => {
    mocks.execute.mockResolvedValueOnce([]);
    const result = await runCrmDomainClassify(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );
    expect(result.domains_input).toBe(0);
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
  });

  it('filters out internal, _excluded, and personal-mail domains', async () => {
    mocks.execute.mockResolvedValueOnce([
      { domain: 'starcapital.co.id', n: 100 }, // internal → filtered
      { domain: 'fireflies.ai', n: 50 },        // excluded → filtered
      { domain: 'gmail.com', n: 30 },           // personal mail → filtered
      { domain: 'goldman.com', n: 10 },         // unknown → passes through
    ]);
    mocks.listUnknownDomains.mockResolvedValueOnce(['goldman.com']);
    mocks.messagesCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          input: {
            'goldman.com': { name: 'Goldman Sachs', industry: 'Banking', confidence: 'high' },
          },
        },
      ],
    });
    mocks.upsertBatch.mockResolvedValueOnce([{ domain: 'goldman.com' }]);

    const result = await runCrmDomainClassify(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    expect(result.domains_input).toBe(1);
    expect(result.domains_classified).toBe(1);
    // listUnknownDomains was passed only the surviving domain
    expect(mocks.listUnknownDomains).toHaveBeenCalledWith(['goldman.com']);
  });

  it('chunks per chunkSize', async () => {
    mocks.execute.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({ domain: `dom${i}.com`, n: 10 - i })),
    );
    mocks.listUnknownDomains.mockResolvedValueOnce(
      ['dom0.com', 'dom1.com', 'dom2.com', 'dom3.com', 'dom4.com'],
    );
    mocks.messagesCreate.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          input: {},
        },
      ],
    });
    mocks.upsertBatch.mockResolvedValue([]);

    await runCrmDomainClassify(
      { chunkSize: 2 },
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    expect(mocks.messagesCreate).toHaveBeenCalledTimes(3); // 5 domains / 2 = 3 chunks (2+2+1)
  });
});
