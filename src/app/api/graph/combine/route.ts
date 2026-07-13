import { type NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceId } from '@/lib/workspace';
import {
  CompanyNotFoundError,
  InvalidCombineError,
} from '@/lib/services/companyRelationshipService';

/**
 * Combine several companies into one "main" company: reroute every graph edge
 * to/from the absorbed companies onto the main company, roll their names up as
 * aliases on the main company, and delete the absorbed rows.
 *
 * Workspace-admin only — a privileged, destructive action.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { workspaceService, companyRelationshipService } = createContainer(db, workspaceId);

    if (!(await workspaceService.isWorkspaceAdmin(session.user.id, workspaceId))) {
      return NextResponse.json(
        { error: 'Only workspace admins can combine companies' },
        { status: 403 },
      );
    }

    const body = await req.json();
    const mainId = typeof body?.mainId === 'string' ? body.mainId : '';
    const otherIds = Array.isArray(body?.otherIds)
      ? body.otherIds.filter((id: unknown): id is string => typeof id === 'string')
      : [];

    if (!mainId) {
      return NextResponse.json({ error: 'mainId is required' }, { status: 400 });
    }
    if (otherIds.length === 0) {
      return NextResponse.json({ error: 'otherIds must contain at least one company' }, { status: 400 });
    }

    const result = await companyRelationshipService.combineCompanies({ mainId, otherIds });
    return NextResponse.json({ data: result });
  } catch (err) {
    if (err instanceof InvalidCombineError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof CompanyNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
