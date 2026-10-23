import { NextRequest, NextResponse } from 'next/server';
import { createContainer } from '@/lib/services/container';
import { cronUnauthorized, sweepWorkspaces } from '@/lib/server/cron';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Daily "Ask Brain" question generation (MB-862).
 *
 * - Fires at 22:00 UTC = 05:00 WIB (vercel.json crons), so the new
 *   Asia/Jakarta day's questions are ready before anyone opens the CRM.
 * - Runs across EVERY live workspace, like `task-reminders`: Vercel Cron
 *   carries no session. Each workspace is `CrmSuggestedQuestionService.runDaily`
 *   (the workspace's Smart Files deal-link reconcile, then generation): a fixed
 *   handful of queries (no per-user fan-out) and no LLM call, so the sweep
 *   runs inline; a missed or failed workspace is covered by on-demand
 *   generation when a member opens the CRM.
 * - Idempotent: it upserts the day's row per member, so a re-run refreshes.
 *
 * Protected by CRON_SECRET (`cronUnauthorized`).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const unauthorized = cronUnauthorized(req);
  if (unauthorized) return unauthorized;

  try {
    let generated = 0;
    let reconciled = 0;
    let forDate: string | null = null;
    const reconcileFailedWorkspaces: string[] = [];
    const { workspaces, failedWorkspaces } = await sweepWorkspaces(
      'cron/crm-suggested-questions',
      async (workspaceId, db) => {
        const { crmSuggestedQuestionService } = createContainer(db, workspaceId);
        const result = await crmSuggestedQuestionService.runDaily();
        generated += result.generated;
        reconciled += result.reconciled;
        forDate = result.forDate;
        if (result.reconcileFailed) reconcileFailedWorkspaces.push(workspaceId);
      },
    );

    return NextResponse.json({
      ok: true,
      forDate,
      workspaces,
      generated,
      reconciled,
      ...(failedWorkspaces.length ? { failedWorkspaces } : {}),
      ...(reconcileFailedWorkspaces.length ? { reconcileFailedWorkspaces } : {}),
    });
  } catch (err) {
    console.error('[cron/crm-suggested-questions] failed:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
