import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { CrmSuggestedQuestionRepository } from './crmSuggestedQuestionRepository';

type Chain = Record<string, ReturnType<typeof vi.fn>> & {
  then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise<unknown>;
};

/** Drizzle chain stub: every builder step returns the chain; awaiting it yields `result`. */
function makeDb(result: unknown[] = []) {
  const chain = {} as Chain;
  for (const m of [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'insert',
    'values',
    'onConflictDoUpdate',
  ]) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

const dialect = new PgDialect();
const toQuery = (s: unknown) => dialect.sqlToQuery(s as SQL);

describe('CrmSuggestedQuestionRepository.findLatestForUser', () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb([{ workspaceId: 'w1', userId: 'u1', forDate: '2026-10-17', questions: {} }]);
  });

  it('scopes to the workspace and the user, on or before the date, newest first', async () => {
    const row = await new CrmSuggestedQuestionRepository(db as never).findLatestForUser(
      'w1',
      'u1',
      '2026-10-17',
    );

    expect(row).toMatchObject({ userId: 'u1', forDate: '2026-10-17' });
    const where = toQuery(db.where.mock.calls[0][0]);
    expect(where.sql).toContain('"crm_suggested_questions"."workspace_id" = $1');
    expect(where.sql).toContain('"crm_suggested_questions"."user_id" = $2');
    expect(where.sql).toContain('"crm_suggested_questions"."for_date" <= $3');
    expect(where.params).toEqual(['w1', 'u1', '2026-10-17']);
    expect(toQuery(db.orderBy.mock.calls[0][0]).sql).toContain('"for_date" desc');
    expect(db.limit).toHaveBeenCalledWith(1);
  });

  it('returns undefined when the user has no saved day', async () => {
    db = makeDb([]);
    await expect(
      new CrmSuggestedQuestionRepository(db as never).findLatestForUser('w1', 'u1', '2026-10-17'),
    ).resolves.toBeUndefined();
  });
});

describe('CrmSuggestedQuestionRepository.upsertMany', () => {
  it('does not hit the DB for an empty list', async () => {
    const db = makeDb();
    await new CrmSuggestedQuestionRepository(db as never).upsertMany([]);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('writes every row in one statement and replaces the day on conflict', async () => {
    const db = makeDb();
    await new CrmSuggestedQuestionRepository(db as never).upsertMany([
      { workspaceId: 'w1', userId: 'u1', forDate: '2026-10-18', questions: { a: 1 } },
      { workspaceId: 'w1', userId: 'u2', forDate: '2026-10-18', questions: { b: 2 } },
    ]);

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.values).toHaveBeenCalledWith([
      { workspace_id: 'w1', user_id: 'u1', for_date: '2026-10-18', questions: { a: 1 } },
      { workspace_id: 'w1', user_id: 'u2', for_date: '2026-10-18', questions: { b: 2 } },
    ]);
    const conflict = db.onConflictDoUpdate.mock.calls[0][0] as {
      target: Array<{ name: string }>;
      set: Record<string, unknown>;
    };
    expect(conflict.target.map((c) => c.name)).toEqual(['workspace_id', 'user_id', 'for_date']);
    expect(toQuery(conflict.set.questions).sql).toBe('excluded.questions');
  });
});
