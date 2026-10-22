import { describe, it, expect, vi } from 'vitest';
import { addJobTypeValueSql, JOB_TYPE_LABELS_SQL, reconcileJobTypeEnum } from './reconcileEnums';
import { jobType } from '../src/lib/db/schema';

function fakeClient(present: string[]) {
  const queries: string[] = [];
  const unsafe = vi.fn(async (query: string) => {
    queries.push(query);
    if (query === JOB_TYPE_LABELS_SQL) return present.map((label) => ({ label }));
    return [];
  });
  return { unsafe, queries };
}

describe('reconcileJobTypeEnum', () => {
  it('adds only the values the database lacks, in schema order, and reports them', async () => {
    const client = fakeClient(['slide_generation', 'bot_message']);

    const added = await reconcileJobTypeEnum(client, ['slide_generation', 'bot_message', 'bot_reply', 'bot_task_summary']);

    expect(added).toEqual(['bot_reply', 'bot_task_summary']);
    expect(client.queries).toEqual([
      JOB_TYPE_LABELS_SQL,
      "ALTER TYPE public.job_type ADD VALUE IF NOT EXISTS 'bot_reply'",
      "ALTER TYPE public.job_type ADD VALUE IF NOT EXISTS 'bot_task_summary'",
    ]);
  });

  it('is a no-op on a database that already has every value', async () => {
    const client = fakeClient(['a', 'b']);
    await expect(reconcileJobTypeEnum(client, ['a', 'b'])).resolves.toEqual([]);
    expect(client.queries).toEqual([JOB_TYPE_LABELS_SQL]);
  });

  it('defaults to every value the schema declares', async () => {
    const client = fakeClient([]);
    const added = await reconcileJobTypeEnum(client);
    expect(added).toEqual([...jobType.enumValues]);
    expect(added).toContain('bot_message');
    expect(added).toContain('bot_task_summary');
  });

  it('refuses a value that is not a plain label, since it goes into DDL unparameterised', () => {
    expect(() => addJobTypeValueSql("x'; drop table jobs; --")).toThrow(/not a plain label/);
    expect(() => addJobTypeValueSql('Bot_Message')).toThrow(/not a plain label/);
    expect(addJobTypeValueSql('bot_message')).toBe("ALTER TYPE public.job_type ADD VALUE IF NOT EXISTS 'bot_message'");
  });
});
