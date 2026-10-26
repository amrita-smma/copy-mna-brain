import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceIdOrThrow, NoActiveWorkspaceError } from '@/lib/workspace';
import {
  InvalidScanNowSelectionError,
  parseScanNowSelection,
} from '@/lib/sourcing/pendingAutomation';

/**
 * Sourcing → Pending Confirmation "Scan now": queue an AI screening task on
 * the AI Workforce for every active company in Pending Confirmation — a fresh
 * match + screen, re-running criteria that already have a result — whatever
 * the auto-scan toggle says. Auto promote / auto drop still apply afterwards
 * when they are on. Companies already queued or scanning are skipped.
 *
 * GET  → `{ data: { tracks, companies } }` — every pending company with its
 *        saved tracks, whether it has a Company Card and whether it is
 *        already queued, for the confirmation dialog's track selector,
 *        per-track counts and time estimate.
 * POST → 202 `{ data: { queued, alreadyQueued } }`. An optional body
 *        `{ trackIds, includeUnmatched }` limits the scan to companies matched
 *        to those tracks (plus unmatched ones); no body scans every company.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = createDb();
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const { pendingAutoScanService } = createContainer(db, workspaceId);
    const data = await pendingAutoScanService.previewScanNow();
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof NoActiveWorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const raw = await req.text();
    let body: unknown = null;
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
    }
    const selection = parseScanNowSelection(body);
    const db = createDb();
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const { pendingAutoScanService } = createContainer(db, workspaceId);
    const data = await pendingAutoScanService.scanNow(session.user.id, selection);
    return NextResponse.json({ data }, { status: 202 });
  } catch (error: unknown) {
    if (error instanceof InvalidScanNowSelectionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof NoActiveWorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
