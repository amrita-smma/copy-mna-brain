import { sql, type SQL } from 'drizzle-orm';
import { escapeLikePattern } from './insightRepository';
import { sqlList, toCount, toIso } from './crmSql';
import type { DbClient } from './types';

/** Sort keys of the person-level banker list. Anything else is rejected by the service. */
export const BANKER_LIST_SORTS = [
  'recent',
  'deals_brought',
  'reached_l1',
  'team_members',
  'emails',
] as const;

export type BankerListSort = (typeof BANKER_LIST_SORTS)[number];

export interface BankerListQuery {
  /** Name, email or firm (ILIKE, wildcards escaped). */
  search?: string;
  sort: BankerListSort;
  /** Last contact on/after this ISO timestamp. */
  lastContactAfter?: string;
  /** Last contact strictly before this ISO timestamp, or never contacted (falls back to `created_at`). */
  lastContactBefore?: string;
  /** Contact has exchanged an email with any of these team members. */
  teamUserIds?: string[];
  /** Contact has at least one active deal link (either role). */
  hasDeals?: boolean;
  limit: number;
  offset: number;
  /**
   * Stage keys positioned after L0 for this workspace (soft-deleted included),
   * as `buildStageRanker(...).isPastFirstStage` decides. A deal reached L1 when
   * its current stage or any stage its logs show is in this set.
   */
  pastFirstStageKeys: string[];
}

/** One person on the banker list, numbers already aggregated. */
export interface BankerListRow {
  correspondentId: string;
  name: string;
  email: string | null;
  title: string | null;
  employerId: string;
  employerName: string;
  emailsFromUs: number;
  emailsFromThem: number;
  lastContactAt: string | null;
  teamMemberCount: number;
  dealsBrought: number;
  dealsInvolved: number;
  reachedL1: number;
}

/**
 * The stage-log patterns `stagesInLogs` (bankerScorecardService) reads, as
 * Postgres regexes: both ends of `PROMOTED_FROM_x_TO_y`, the target of
 * `PROMOTED_TO_x` / `RESTORED_TO_x` / `RESURFACED_TO_x`, and the stage a
 * `DROPPED_FROM_x` left. Capture groups are what count as stages.
 */
export const STAGE_LOG_PATTERNS = {
  fromTo: '^PROMOTED_FROM_(.+)_TO_(.+)$',
  toOnly: '^(?:PROMOTED|RESTORED|RESURFACED)_TO_(.+)$',
  droppedFrom: '^DROPPED_FROM_(.+)$',
} as const;

/** A `bankers` CTE row as node-postgres returns it (counts and timestamps as text). */
type BankerDbRow = {
  correspondent_id: string;
  name: string | null;
  email: string | null;
  title: string | null;
  employer_id: string;
  employer_name: string | null;
  emails_from_us: unknown;
  emails_from_them: unknown;
  last_contact_at: unknown;
  team_member_count: unknown;
  deals_brought: unknown;
  deals_involved: unknown;
  reached_l1: unknown;
};

/**
 * Whitelisted ORDER BY per sort key. Every order ends with last contact, name
 * and id so ties never reshuffle across pages.
 */
const ORDER_BY: Record<BankerListSort, SQL> = {
  recent: sql`b.last_contact_at DESC NULLS LAST`,
  deals_brought: sql`b.deals_brought DESC, b.reached_l1 DESC, b.last_contact_at DESC NULLS LAST`,
  reached_l1: sql`b.reached_l1 DESC, b.deals_brought DESC, b.last_contact_at DESC NULLS LAST`,
  team_members: sql`b.team_member_count DESC, b.last_contact_at DESC NULLS LAST`,
  emails: sql`(b.emails_from_us + b.emails_from_them) DESC, b.last_contact_at DESC NULLS LAST`,
};

/**
 * The person-level banker list (MB-858; Brain Bots, and the CRM Bankers view
 * behind `CRM_BANKERS_VIEW_ENABLED`): one row per PERSON visible in the workspace,
 * with email / team / deal numbers, sorted, filtered and paginated
 * in SQL so order holds across pages.
 *
 * Visibility is `CorrespondentRepository.search`'s rule: the contact is in the
 * workspace (the rows of `correspondent_workspace_effective`) and its firm is
 * published (`curation_status = 'published'`, so flagged firms stay hidden
 * until approved, as on the Firms list). Names come from the per-workspace
 * views, so this workspace's curated names win.
 *
 * Numbers (same sources as `ContactInsightsService.getInteractionSummaries`):
 * - emails and last contact: `analytics.mart_contact_email_totals` (distinct
 *   emails per contact);
 * - team members: distinct users over email pairs (`mart_contact_interactions`);
 * - deals: active `deal_contacts` joined to the workspace's companies; reached
 *   L1 per company = current stage or any logged stage in `pastFirstStageKeys`.
 */
export class BankerListRepository {
  constructor(private readonly db: DbClient) {}

  /** One page of bankers. */
  async list(workspaceId: string, q: BankerListQuery): Promise<BankerListRow[]> {
    const { rows } = await this.db.execute<BankerDbRow>(sql`
      ${this.bankersCte(workspaceId, q)}
      SELECT b.*
      FROM bankers b
      WHERE ${this.filters(q)}
      ORDER BY ${ORDER_BY[q.sort] ?? ORDER_BY.recent}, b.name ASC, b.correspondent_id ASC
      LIMIT ${q.limit} OFFSET ${q.offset}
    `);
    return rows.map((r) => ({
      correspondentId: r.correspondent_id,
      name: r.name ?? '',
      email: r.email,
      title: r.title,
      employerId: r.employer_id,
      employerName: r.employer_name ?? '',
      emailsFromUs: toCount(r.emails_from_us),
      emailsFromThem: toCount(r.emails_from_them),
      lastContactAt: toIso(r.last_contact_at),
      teamMemberCount: toCount(r.team_member_count),
      dealsBrought: toCount(r.deals_brought),
      dealsInvolved: toCount(r.deals_involved),
      reachedL1: toCount(r.reached_l1),
    }));
  }

  /** How many bankers match the filters (all pages). */
  async count(workspaceId: string, q: BankerListQuery): Promise<number> {
    const { rows } = await this.db.execute<{ total: number }>(sql`
      ${this.bankersCte(workspaceId, q)}
      SELECT count(*)::int AS total
      FROM bankers b
      WHERE ${this.filters(q)}
    `);
    return toCount(rows[0]?.total);
  }

  /** How many bankers the workspace can see, before any filter. */
  async countVisible(workspaceId: string): Promise<number> {
    const { rows } = await this.db.execute<{ total: number }>(sql`
      SELECT count(*)::int AS total
      ${this.visibleFrom(workspaceId)}
    `);
    return toCount(rows[0]?.total);
  }

  private visibleFrom(workspaceId: string): SQL {
    return sql`
      FROM "public"."correspondent_workspace_effective" ce
      JOIN "public"."employer_workspace_effective" ee
        ON ee.id = ce.employer_id
       AND ee.workspace_id = ce.workspace_id
       AND ee.curation_status = 'published'
       -- The workspace filter sits in the ON clause, not a WHERE, because
       -- callers append LEFT JOINs after this fragment.
       AND ce.workspace_id = ${workspaceId}
    `;
  }

  /** `true` when company `c` reached a stage positioned after L0. */
  private reachedExpr(pastFirstStageKeys: string[]): SQL {
    if (pastFirstStageKeys.length === 0) return sql`false`;
    const keys = sqlList(pastFirstStageKeys);
    return sql`(
      c.pipeline_stage IN (${keys})
      OR EXISTS (
        SELECT 1
        FROM "public"."company_logs" cl
        CROSS JOIN LATERAL (VALUES
          ((regexp_match(cl.action, ${STAGE_LOG_PATTERNS.fromTo}))[1]),
          ((regexp_match(cl.action, ${STAGE_LOG_PATTERNS.fromTo}))[2]),
          ((regexp_match(cl.action, ${STAGE_LOG_PATTERNS.toOnly}))[1]),
          ((regexp_match(cl.action, ${STAGE_LOG_PATTERNS.droppedFrom}))[1])
        ) AS s(stage)
        WHERE cl.company_id = c.id
          AND s.stage IN (${keys})
      )
    )`;
  }

  /** `WITH ... bankers AS (...)`: every visible person with their numbers. */
  private bankersCte(workspaceId: string, q: BankerListQuery): SQL {
    return sql`
      WITH team_pairs AS (
        SELECT mci.correspondent_id, mci.user_id
        FROM "analytics"."mart_contact_interactions" mci
        WHERE mci.workspace_id = ${workspaceId}
      ),
      team AS (
        SELECT correspondent_id, count(DISTINCT user_id)::int AS team_member_count
        FROM team_pairs
        GROUP BY correspondent_id
      ),
      links AS (
        SELECT dc.correspondent_id, dc.role, c.id AS company_id,
               CASE WHEN dc.role = 'source' THEN ${this.reachedExpr(q.pastFirstStageKeys)} ELSE false END AS reached_l1
        FROM "public"."deal_contacts" dc
        JOIN "public"."companies" c
          ON c.id = dc.company_id
         AND c.workspace_id = ${workspaceId}
        WHERE dc.workspace_id = ${workspaceId}
          AND dc.status = 'active'
      ),
      deals AS (
        SELECT correspondent_id,
               count(*) FILTER (WHERE role = 'source')::int AS deals_brought,
               count(*) FILTER (WHERE role = 'involved')::int AS deals_involved,
               count(*) FILTER (WHERE role = 'source' AND reached_l1)::int AS reached_l1
        FROM links
        GROUP BY correspondent_id
      ),
      bankers AS (
        SELECT ce.id AS correspondent_id, ce.name, ce.email, ce.title,
               ce.created_at,
               ee.id AS employer_id, ee.name AS employer_name,
               COALESCE(et.emails_from_us, 0) AS emails_from_us,
               COALESCE(et.emails_from_them, 0) AS emails_from_them,
               et.last_email_at AS last_contact_at,
               COALESCE(t.team_member_count, 0) AS team_member_count,
               COALESCE(d.deals_brought, 0) AS deals_brought,
               COALESCE(d.deals_involved, 0) AS deals_involved,
               COALESCE(d.reached_l1, 0) AS reached_l1
        ${this.visibleFrom(workspaceId)}
        LEFT JOIN "analytics"."mart_contact_email_totals" et
          ON et.workspace_id = ${workspaceId}
         AND et.correspondent_id = ce.id
        LEFT JOIN team t ON t.correspondent_id = ce.id
        LEFT JOIN deals d ON d.correspondent_id = ce.id
      )
    `;
  }

  private filters(q: BankerListQuery): SQL {
    const conditions: SQL[] = [sql`true`];
    const search = q.search?.trim();
    if (search) {
      const pattern = `%${escapeLikePattern(search)}%`;
      conditions.push(
        sql`(b.name ILIKE ${pattern} OR b.email ILIKE ${pattern} OR b.employer_name ILIKE ${pattern})`,
      );
    }
    if (q.lastContactAfter) {
      conditions.push(sql`b.last_contact_at >= ${q.lastContactAfter}`);
    }
    if (q.lastContactBefore) {
      // Mirrors the Firms list: never-contacted falls back to when the record was created.
      conditions.push(sql`COALESCE(b.last_contact_at, b.created_at) < ${q.lastContactBefore}`);
    }
    if (q.hasDeals) {
      conditions.push(sql`(b.deals_brought + b.deals_involved) > 0`);
    }
    if (q.teamUserIds && q.teamUserIds.length > 0) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM team_pairs tp
        WHERE tp.correspondent_id = b.correspondent_id
          AND tp.user_id IN (${sqlList(q.teamUserIds)})
      )`);
    }
    return sql.join(conditions, sql` AND `);
  }
}
