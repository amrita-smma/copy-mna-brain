import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import type { ApproveFileInput } from '@/lib/services/fileService';
import { CompanyL0RequirementsError } from '@/lib/services/companyService';
import { FundUpdateValidationError } from '@/lib/services/flErrors';
import { UserRepository } from '@/lib/repositories/userRepository';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: 'File ID is required' }, { status: 400 });
    }

    const body = await request.json() as ApproveFileInput;
    if (!body.file_type) {
      return NextResponse.json({ error: 'file_type is required' }, { status: 400 });
    }

    // Audit columns such as fl_source_records.created_by are UUID foreign
    // keys, so resolve the session to the current database user instead of
    // passing the display name.
    const session = await auth();
    const db = createDb();
    const userRepo = new UserRepository(db);
    const currentUser = session?.user?.email
      ? await userRepo.findByEmail(session.user.email)
      : null;
    const enteredBy = currentUser?.id ?? null;

    // Resolve entered_by from the DB by session email — guards against stale
    // JWT user.id (e.g. after a DB re-seed); same pattern as processUpload.
    if (body.create_company_from_ai) {
      body.entered_by = enteredBy;
    }

    const { fileService } = createContainer(db, await getActiveWorkspaceId());
    const result = await fileService.approve(id, body, enteredBy);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof CompanyL0RequirementsError) {
      return NextResponse.json(
        { error: 'Missing required fields', missingFields: error.missingFields },
        { status: 422 },
      );
    }
    if (error instanceof FundUpdateValidationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 422 },
      );
    }
    console.error('Approve file error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to approve file' },
      { status: 500 },
    );
  }
}
