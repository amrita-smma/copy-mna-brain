import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadSecretsFromSsm: vi.fn().mockResolvedValue(undefined),
  createLambdaDb: vi.fn(),
  pgClientEnd: vi.fn().mockResolvedValue(undefined),
  dbExecute: vi.fn(),
  findSyncedCustodianEmails: vi.fn(),
  loadVaultCredentials: vi.fn().mockReturnValue({ client_email: 'svc@x' }),
  getVaultAccessToken: vi.fn().mockResolvedValue('token'),
  createVaultMatter: vi.fn(),
  createVaultExport: vi.fn(),
}));

vi.mock('../secrets', () => ({ loadSecretsFromSsm: mocks.loadSecretsFromSsm }));
vi.mock('../db', () => ({ createLambdaDb: mocks.createLambdaDb }));
vi.mock('@/lib/services/googleVaultService', () => ({
  loadVaultCredentials: mocks.loadVaultCredentials,
  getVaultAccessToken: mocks.getVaultAccessToken,
  createVaultMatter: mocks.createVaultMatter,
  createVaultExport: mocks.createVaultExport,
  VAULT_CUSTODIAN_EMAILS: [],
}));
vi.mock('@/lib/repositories', () => {
  class UserWorkspaceRepository {
    findSyncedCustodianEmails = mocks.findSyncedCustodianEmails;
  }
  return { UserWorkspaceRepository };
});

import { handler } from './vaultArchiveStart';

/** Flattens a drizzle `sql` template: literal text plus bound values. */
function sqlParts(q: unknown): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const walk = (node: unknown): string => {
    const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks;
    if (!chunks) {
      params.push(node);
      return '?';
    }
    return chunks
      .map((c) => {
        if (c && typeof c === 'object' && 'value' in c) {
          const v = (c as { value: unknown }).value;
          return Array.isArray(v) ? v.join('') : String(v);
        }
        return walk(c);
      })
      .join('');
  };
  return { text: walk(q), params };
}

const inserts = () =>
  mocks.dbExecute.mock.calls
    .map(([q]) => sqlParts(q))
    .filter((p) => p.text.includes('INSERT INTO analytics.vault_exports'));

describe('vaultArchiveStart rewind', () => {
  let inFlight = 0;
  let existing: Array<{ window_start: string; status: string }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T05:00:00Z'));
    vi.clearAllMocks();
    inFlight = 0;
    existing = [];
    mocks.createLambdaDb.mockResolvedValue({
      pgClient: { end: mocks.pgClientEnd },
      db: { execute: mocks.dbExecute },
    });
    mocks.findSyncedCustodianEmails.mockResolvedValue(['analyst@starcapital.co.id']);
    let n = 0;
    mocks.createVaultMatter.mockImplementation(async () => `matter-${++n}`);
    mocks.createVaultExport.mockImplementation(async (_t, matterId: string) => `export-of-${matterId}`);
    mocks.dbExecute.mockImplementation(async (q: unknown) => {
      const { text } = sqlParts(q);
      if (text.includes('COUNT(*)')) return { rows: [{ count: inFlight }] };
      if (text.includes('SELECT window_start::text')) return { rows: existing };
      return { rows: [] };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates re-extract exports for already-archived days, oldest first', async () => {
    const out = await handler(
      { count: 2, rewind: { from: '2026-09-01', to: '2026-09-30' } },
      {},
    );

    expect(out.result.dispatched.map((d) => d.window_start)).toEqual([
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    ]);
    const rows = inserts();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.params.includes('reextract'))).toBe(true);
  });

  it('only counts its own re-extract exports created since startedAt as covering a day', async () => {
    existing = [{ window_start: '2026-09-01 00:00:00+00', status: 'archived' }];

    const out = await handler(
      { count: 1, rewind: { from: '2026-09-01', to: '2026-09-30', startedAt: '2026-10-21T00:00:00Z' } },
      {},
    );

    const coverage = mocks.dbExecute.mock.calls
      .map(([q]) => sqlParts(q))
      .find((p) => p.text.includes('SELECT window_start::text'))!;
    expect(coverage.text).toContain('AND mode =');
    expect(coverage.text).toContain('AND created_at >=');
    expect(coverage.params).toContain('reextract');
    expect(coverage.params).toContain('2026-10-21T00:00:00.000Z');
    // The fake DB says 09-01 is covered, so the walk resumes at 09-02.
    expect(out.result.dispatched[0]!.window_start).toBe('2026-09-02T00:00:00.000Z');
  });

  it('stops at yesterday when the range reaches into today', async () => {
    const out = await handler(
      { count: 3, rewind: { from: '2026-10-20', to: '2026-10-25' } },
      {},
    );
    expect(out.result.dispatched.map((d) => d.window_start)).toEqual([
      '2026-10-20T00:00:00.000Z',
      '2026-10-21T00:00:00.000Z',
    ]);
  });

  it('respects the in-flight cap', async () => {
    inFlight = 3;
    const out = await handler(
      { count: 3, rewind: { from: '2026-09-01', to: '2026-09-30' } },
      {},
    );
    expect(out.result.dispatched).toEqual([]);
    expect(mocks.createVaultExport).not.toHaveBeenCalled();
  });

  it('rejects a bad rewind before touching the DB or Vault', async () => {
    await expect(
      handler({ rewind: { from: '2026-09-30', to: '2026-09-01' } }, {}),
    ).rejects.toThrow('after rewind.to');
    expect(mocks.createLambdaDb).not.toHaveBeenCalled();
    expect(mocks.createVaultMatter).not.toHaveBeenCalled();
  });

  it('a scheduled run without rewind still writes daily exports over every mode', async () => {
    await handler({}, {});
    const coverage = mocks.dbExecute.mock.calls
      .map(([q]) => sqlParts(q))
      .find((p) => p.text.includes('SELECT window_start::text'))!;
    expect(coverage.text).not.toContain('AND mode =');
    expect(inserts()[0]!.params).toContain('daily');
  });
});
