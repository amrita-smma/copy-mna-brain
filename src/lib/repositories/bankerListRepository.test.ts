import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  BANKER_LIST_SORTS,
  BankerListRepository,
  STAGE_LOG_PATTERNS,
  type BankerListQuery,
  type BankerListSort,
} from './bankerListRepository';
import { stagesInLogs } from '@/lib/services/bankerScorecardService';

function makeDb() {
  return { execute: vi.fn().mockResolvedValue({ rows: [] }) };
}

function compiled(db: ReturnType<typeof makeDb>, call = 0) {
  return new PgDialect().sqlToQuery(db.execute.mock.calls[call]?.[0] as SQL);
}

function query(overrides: Partial<BankerListQuery> = {}): BankerListQuery {
  return {
    sort: 'recent',
    limit: 25,
    offset: 0,
    pastFirstStageKeys: ['L1', 'L2'],
    ...overrides,
  };
}

describe('BankerListRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: BankerListRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new BankerListRepository(db as never);
  });

  describe('list', () => {
    it('scopes every source to the workspace and applies the visibility rule', async () => {
      await repo.list('w1', query());

      expect(db.execute).toHaveBeenCalledTimes(1);
      const { sql } = compiled(db);
      expect(sql).toContain('"public"."correspondent_workspace_effective" ce');
      expect(sql).toContain('"public"."employer_workspace_effective" ee');
      expect(sql).toContain('ee.workspace_id = ce.workspace_id');
      expect(sql).toContain("ee.curation_status = 'published'");
      expect(sql).toContain('"analytics"."mart_contact_email_totals" et');
      expect(sql).toContain('"analytics"."mart_contact_interactions" mci');
      expect(sql).toContain("dc.status = 'active'");
      expect(sql).toContain('c.workspace_id =');
      // Last contact is the last counted email; nothing reads meetings.
      expect(sql).toContain('et.last_email_at AS last_contact_at');
      expect(sql).not.toContain('meeting');
    });

    it('binds the page size and offset as parameters', async () => {
      await repo.list('w1', query({ limit: 10, offset: 30 }));

      const { sql, params } = compiled(db);
      expect(sql).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
      expect(params.slice(-2)).toEqual([10, 30]);
    });

    const LEADING: Record<BankerListSort, string> = {
      recent: 'ORDER BY b.last_contact_at DESC NULLS LAST',
      deals_brought: 'ORDER BY b.deals_brought DESC',
      reached_l1: 'ORDER BY b.reached_l1 DESC',
      team_members: 'ORDER BY b.team_member_count DESC',
      emails: 'ORDER BY (b.emails_from_us + b.emails_from_them) DESC',
    };

    it.each(BANKER_LIST_SORTS.map((sort) => [sort, LEADING[sort]] as const))(
      'orders %s by its own leading column with a stable name, id tie-break',
      async (sort, leading) => {
        await repo.list('w1', query({ sort }));

        const { sql } = compiled(db);
        expect(sql).toContain(leading);
        expect(sql).toMatch(/ORDER BY [\s\S]* b\.name ASC, b\.correspondent_id ASC/);
      },
    );

    it('never puts an unknown sort into the SQL text', async () => {
      await repo.list('w1', query({ sort: "recent; DROP TABLE users; --" as never }));

      const { sql } = compiled(db);
      expect(sql).not.toContain('DROP TABLE');
      expect(sql).toContain('ORDER BY b.last_contact_at DESC NULLS LAST');
    });

    it('applies no filter beyond visibility by default', async () => {
      await repo.list('w1', query());

      const { sql } = compiled(db);
      expect(sql).not.toContain('ILIKE');
      expect(sql).not.toContain('FROM team_pairs tp');
      expect(sql).not.toContain('(b.deals_brought + b.deals_involved) > 0');
    });

    it('combines search, last contact, deals and team filters with AND', async () => {
      await repo.list(
        'w1',
        query({
          search: '50%_off',
          lastContactAfter: '2026-09-17T00:00:00.000Z',
          lastContactBefore: '2026-09-01T00:00:00.000Z',
          hasDeals: true,
          teamUserIds: ['u1', 'u2'],
        }),
      );

      const { sql, params } = compiled(db);
      expect(sql).toMatch(/b\.name ILIKE \$\d+ OR b\.email ILIKE \$\d+ OR b\.employer_name ILIKE \$\d+/);
      // Wildcards in the search are escaped.
      expect(params).toContain('%50\\%\\_off%');
      expect(sql).toContain('b.last_contact_at >=');
      expect(sql).toContain('COALESCE(b.last_contact_at, b.created_at) <');
      expect(sql).toContain('(b.deals_brought + b.deals_involved) > 0');
      expect(sql).toMatch(/tp\.user_id IN \(\$\d+, \$\d+\)/);
      expect(params).toEqual(expect.arrayContaining(['u1', 'u2', '2026-09-01T00:00:00.000Z']));
      expect(sql.match(/ AND /g)?.length ?? 0).toBeGreaterThan(5);
    });

    it('marks no deal as reached L1 when there is no stage past L0', async () => {
      await repo.list('w1', query({ pastFirstStageKeys: [] }));

      const { sql } = compiled(db);
      expect(sql).toContain("CASE WHEN dc.role = 'source' THEN false ELSE false END");
      expect(sql).not.toContain('regexp_match');
    });

    it('reads reached L1 from the current stage and every stage-log pattern', async () => {
      await repo.list('w1', query({ pastFirstStageKeys: ['L1', 'stg-x'] }));

      const { sql, params } = compiled(db);
      expect(sql).toMatch(/c\.pipeline_stage IN \(\$\d+, \$\d+\)/);
      expect(sql.match(/regexp_match/g)).toHaveLength(4);
      expect(params).toEqual(
        expect.arrayContaining([
          STAGE_LOG_PATTERNS.fromTo,
          STAGE_LOG_PATTERNS.toOnly,
          STAGE_LOG_PATTERNS.droppedFrom,
          'stg-x',
        ]),
      );
    });

    it('maps a row as node-postgres returns it (text counts and timestamps)', async () => {
      db.execute.mockResolvedValueOnce({
        rows: [
          {
            correspondent_id: 'c1',
            name: 'Jimmy',
            email: 'j@gs.example',
            title: null,
            employer_id: 'e1',
            employer_name: 'Golden Sacks',
            emails_from_us: '2',
            emails_from_them: '3',
            last_contact_at: '2026-10-14 08:00:00+00',
            team_member_count: 2,
            deals_brought: 3,
            deals_involved: 0,
            reached_l1: 2,
          },
        ],
      });
      await expect(repo.list('w1', query())).resolves.toEqual([
        {
          correspondentId: 'c1',
          name: 'Jimmy',
          email: 'j@gs.example',
          title: null,
          employerId: 'e1',
          employerName: 'Golden Sacks',
          emailsFromUs: 2,
          emailsFromThem: 3,
          lastContactAt: '2026-10-14T08:00:00.000Z',
          teamMemberCount: 2,
          dealsBrought: 3,
          dealsInvolved: 0,
          reachedL1: 2,
        },
      ]);
    });
  });

  describe('count', () => {
    it('counts with the same filters and no LIMIT', async () => {
      db.execute.mockResolvedValueOnce({ rows: [{ total: '7' }] });

      await expect(repo.count('w1', query({ hasDeals: true }))).resolves.toBe(7);
      const { sql } = compiled(db);
      expect(sql).toContain('count(*)::int AS total');
      expect(sql).toContain('(b.deals_brought + b.deals_involved) > 0');
      expect(sql).not.toContain('LIMIT');
    });

    it('returns 0 when nothing matches', async () => {
      await expect(repo.count('w1', query())).resolves.toBe(0);
    });
  });

  describe('countVisible', () => {
    it('counts visible contacts of published firms in the workspace only', async () => {
      db.execute.mockResolvedValueOnce({ rows: [{ total: 38 }] });

      await expect(repo.countVisible('w1')).resolves.toBe(38);
      const { sql, params } = compiled(db);
      expect(sql).toContain('ce.workspace_id = $1');
      expect(sql).toContain("ee.curation_status = 'published'");
      expect(sql).not.toContain('mart_contact');
      expect(params).toEqual(['w1']);
    });
  });
});

describe('STAGE_LOG_PATTERNS', () => {
  /** What the SQL extracts from one action, using the same regexes. */
  function sqlStages(action: string): string[] {
    const out: string[] = [];
    const fromTo = action.match(new RegExp(STAGE_LOG_PATTERNS.fromTo));
    if (fromTo) out.push(fromTo[1], fromTo[2]);
    const toOnly = action.match(new RegExp(STAGE_LOG_PATTERNS.toOnly));
    if (toOnly) out.push(toOnly[1]);
    const dropped = action.match(new RegExp(STAGE_LOG_PATTERNS.droppedFrom));
    if (dropped) out.push(dropped[1]);
    return out.sort();
  }

  it.each([
    'PROMOTED_FROM_L0_TO_L1',
    'PROMOTED_FROM_L2_TO_L1',
    'PROMOTED_FROM_unreviewed_TO_L0',
    'PROMOTED_FROM_stg-abc_def_TO_L3',
    'PROMOTED_TO_L2',
    'RESTORED_TO_L1',
    'RESURFACED_TO_stg-x',
    'DROPPED_FROM_L1',
    'DROPPED_FROM_stg-old',
    'auto_created_from_file:123',
    'NOTE_ADDED',
  ])('extracts the same stages as stagesInLogs for %s', (action) => {
    expect(sqlStages(action)).toEqual([...stagesInLogs([action])].sort());
  });
});
