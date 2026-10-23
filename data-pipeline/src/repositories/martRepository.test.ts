import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MartRepository, MART_VIEWS } from './martRepository';

function makeDb() {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
  };
}

// sql.raw(text) wraps the literal in a StringChunk; pull the text back out.
function rawText(arg: unknown): string {
  const chunk = (arg as { queryChunks?: Array<{ value?: unknown[] }> })
    .queryChunks?.[0];
  return String(chunk?.value?.[0] ?? '');
}

describe('MartRepository.refresh', () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
  });

  it('issues a CONCURRENTLY refresh for the named mart', async () => {
    const repo = new MartRepository(db as never);
    await repo.refresh('mart_crm');
    expect(db.execute).toHaveBeenCalledTimes(1);
    const stmt = rawText(db.execute.mock.calls[0][0]);
    expect(stmt).toContain('REFRESH MATERIALIZED VIEW CONCURRENTLY');
    expect(stmt).toContain('analytics.mart_crm');
  });
});

describe('MartRepository.refreshAll', () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
  });

  it('refreshes every mart and returns all names on success', async () => {
    const repo = new MartRepository(db as never);
    const refreshed = await repo.refreshAll();
    expect(refreshed).toEqual([...MART_VIEWS]);
    expect(db.execute).toHaveBeenCalledTimes(MART_VIEWS.length);
  });

  it('isolates a single failure: other marts still refresh, only failures are dropped', async () => {
    db.execute
      .mockResolvedValueOnce(undefined) // mart_crm ok
      .mockRejectedValueOnce(new Error('relation does not exist')) // mart_mom fails
      .mockResolvedValueOnce(undefined) // mart_topics ok
      .mockResolvedValueOnce(undefined) // mart_contact_interactions ok
      .mockResolvedValueOnce(undefined); // mart_contact_email_totals ok
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const repo = new MartRepository(db as never);

    const refreshed = await repo.refreshAll();

    expect(refreshed).toEqual([
      'mart_crm',
      'mart_topics',
      'mart_contact_interactions',
      'mart_contact_email_totals',
    ]);
    expect(db.execute).toHaveBeenCalledTimes(MART_VIEWS.length);
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('returns [] when every mart fails (e.g. 4a migration not applied)', async () => {
    db.execute.mockRejectedValue(new Error('relation does not exist'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const repo = new MartRepository(db as never);

    expect(await repo.refreshAll()).toEqual([]);
    errSpy.mockRestore();
  });
});
