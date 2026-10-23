import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { emailInWorkspace, sqlList, toCount, toIso, viewerCanSeeEmail } from './crmSql';

const dialect = new PgDialect();

describe('toIso', () => {
  it('turns Postgres timestamp text into ISO 8601', () => {
    expect(toIso('2026-10-17 08:00:00+00')).toBe('2026-10-17T08:00:00.000Z');
    expect(toIso('2026-10-17 08:00:00.123456+00')).toBe('2026-10-17T08:00:00.123Z');
    expect(toIso('2026-10-17 15:00:00+07')).toBe('2026-10-17T08:00:00.000Z');
  });

  it('returns null for null and unparseable input, never the raw string', () => {
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
    expect(toIso('not a date')).toBeNull();
  });
});

describe('toCount', () => {
  it('reads bigint text as a number and null or garbage as 0', () => {
    expect(toCount('42')).toBe(42);
    expect(toCount(null)).toBe(0);
    expect(toCount('x')).toBe(0);
  });
});

describe('sqlList', () => {
  it('binds each value as its own parameter', () => {
    const q = dialect.sqlToQuery(sql`IN (${sqlList(['a', 'b'])})`);
    expect(q.sql).toBe('IN ($1, $2)');
    expect(q.params).toEqual(['a', 'b']);
  });
});

describe('emailInWorkspace', () => {
  it('matches the custodian mailbox exactly against a workspace member', () => {
    const q = dialect.sqlToQuery(emailInWorkspace(sql.raw('e.custodian_email'), 'ws-1'));
    expect(q.sql).toContain('WHERE cu.email = e.custodian_email');
    expect(q.sql).toContain('cuw.workspace_id = $1');
    expect(q.params).toEqual(['ws-1']);
  });
});

describe('viewerCanSeeEmail', () => {
  it('lets the viewer see an email they are on, or one from their own mailbox', () => {
    const q = dialect.sqlToQuery(
      viewerCanSeeEmail(sql.raw('e.id'), sql.raw('e.custodian_email'), 'u-1'),
    );
    expect(q.sql).toContain('vp.email_id = e.id AND vp.user_id = $1');
    expect(q.sql).toContain('vu.id = $2 AND lower(vu.email) = lower(e.custodian_email)');
    expect(q.params).toEqual(['u-1', 'u-1']);
  });
});
