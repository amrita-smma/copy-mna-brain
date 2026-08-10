import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

interface RouteContext {
  params: Promise<{ id: string }>;
}

type RematchBody =
  | { action: 'add'; company_id: string }
  | { action: 'remove'; company_id?: string; unmatched_name?: string };

/**
 * Front-table rematch for Smart Files — add/remove matched companies without
 * entering HITL review. Available for every file type and status.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: 'File ID is required' }, { status: 400 });
    }

    const body = (await request.json()) as RematchBody;
    if (!body?.action || (body.action !== 'add' && body.action !== 'remove')) {
      return NextResponse.json(
        { error: 'action must be "add" or "remove"' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { fileService } = createContainer(db, await getActiveWorkspaceId());

    let data;
    if (body.action === 'add') {
      if (!body.company_id || typeof body.company_id !== 'string') {
        return NextResponse.json({ error: 'company_id is required for add' }, { status: 400 });
      }
      data = await fileService.addMatchedCompany(id, body.company_id);
    } else {
      if (body.company_id != null && typeof body.company_id !== 'string') {
        return NextResponse.json({ error: 'company_id must be a string' }, { status: 400 });
      }
      if (body.unmatched_name != null && typeof body.unmatched_name !== 'string') {
        return NextResponse.json({ error: 'unmatched_name must be a string' }, { status: 400 });
      }
      if (!body.company_id && !body.unmatched_name) {
        return NextResponse.json(
          { error: 'company_id or unmatched_name is required for remove' },
          { status: 400 },
        );
      }
      data = await fileService.removeMatchedCompanyEntry(id, {
        companyId: body.company_id,
        unmatchedName: body.unmatched_name,
      });
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('Rematch matched-companies error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to update matched companies' },
      { status: 500 },
    );
  }
}
