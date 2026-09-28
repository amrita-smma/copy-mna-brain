import { and, eq, sql } from "drizzle-orm";
import { workspaceCorrespondents } from "@/lib/db/schema";
import type { DbClient } from "./types";

export type WorkspaceCorrespondentSource = "ingest" | "manual" | "direct";

// Provenance order: manual > direct > ingest — a conflict always upgrades
// toward the stronger value, never downgrades. 'manual' (human-affirmed,
// createContact/curateEmployer) wins outright. 'direct' (CRMService.
// ingestEmails — Vault export / file-extracted communications, no mailbox
// or is_email_synced concept at all) beats plain 'ingest' (crmIngest's real
// mailbox-sync pipeline). Only when neither side is 'manual' or 'direct'
// does it stay 'ingest'.
//
// This is provenance only — it no longer affects visibility. Reads used to
// hide `source='ingest'` rows once a workspace had no email-synced member;
// that gate is gone (see CorrespondentRepository.visibleCorrespondentIds), so
// every membership row is visible to its workspace whatever its source.
const sourceUpgradeOnConflict = sql`CASE
  WHEN excluded.source = 'manual' OR ${workspaceCorrespondents.source} = 'manual' THEN 'manual'
  WHEN excluded.source = 'direct' OR ${workspaceCorrespondents.source} = 'direct' THEN 'direct'
  ELSE 'ingest'
END`;

const SOURCE_RANK: Record<WorkspaceCorrespondentSource, number> = {
  manual: 2,
  direct: 1,
  ingest: 0,
};

export class WorkspaceCorrespondentRepository {
  constructor(private db: DbClient) {}

  /**
   * `source` is required (not defaulted) so every call site consciously
   * picks 'ingest' or 'manual' — the prerequisite for a future revoke-on-
   * unsync sweep that must never touch manually-added contacts.
   */
  async addMembership(
    workspaceId: string,
    correspondentId: string,
    source: WorkspaceCorrespondentSource,
  ): Promise<void> {
    await this.db
      .insert(workspaceCorrespondents)
      .values({ workspace_id: workspaceId, correspondent_id: correspondentId, source })
      .onConflictDoUpdate({
        target: [workspaceCorrespondents.workspace_id, workspaceCorrespondents.correspondent_id],
        set: { source: sourceUpgradeOnConflict },
      });
  }

  async addMemberships(
    pairs: Array<{ workspaceId: string; correspondentId: string; source: WorkspaceCorrespondentSource }>,
  ): Promise<void> {
    if (pairs.length === 0) return;
    // A single INSERT ON CONFLICT DO UPDATE can't touch the same row twice,
    // so duplicate (workspace, correspondent) pairs within one batch — e.g.
    // the same correspondent hit by several emails in one ingest run — must
    // collapse to one row first, keeping the most durable source.
    const deduped = new Map<string, { workspaceId: string; correspondentId: string; source: WorkspaceCorrespondentSource }>();
    for (const p of pairs) {
      const key = `${p.workspaceId}:${p.correspondentId}`;
      const existing = deduped.get(key);
      if (!existing || SOURCE_RANK[p.source] > SOURCE_RANK[existing.source]) {
        deduped.set(key, p);
      }
    }
    await this.db
      .insert(workspaceCorrespondents)
      .values(
        Array.from(deduped.values(), (p) => ({
          workspace_id: p.workspaceId,
          correspondent_id: p.correspondentId,
          source: p.source,
        })),
      )
      .onConflictDoUpdate({
        target: [workspaceCorrespondents.workspace_id, workspaceCorrespondents.correspondent_id],
        set: { source: sourceUpgradeOnConflict },
      });
  }

  async listVisibleCorrespondentIds(workspaceId: string): Promise<string[]> {
    const rows = await this.db
      .select({ correspondent_id: workspaceCorrespondents.correspondent_id })
      .from(workspaceCorrespondents)
      .where(eq(workspaceCorrespondents.workspace_id, workspaceId));
    return rows.map((r) => r.correspondent_id);
  }

  async isVisible(
    workspaceId: string,
    correspondentId: string,
  ): Promise<boolean> {
    const rows = await this.db
      .select({ correspondent_id: workspaceCorrespondents.correspondent_id })
      .from(workspaceCorrespondents)
      .where(
        and(
          eq(workspaceCorrespondents.workspace_id, workspaceId),
          eq(workspaceCorrespondents.correspondent_id, correspondentId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}
