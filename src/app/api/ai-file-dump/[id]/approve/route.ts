import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import type { ApproveFileInput } from '@/lib/services/fileService';
import { CompanyL0RequirementsError } from '@/lib/services/companyService';
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

    // Stamp who uploaded the file as the company's `entered_by`.
    const session = await auth();
    const enteredBy = session?.user?.name ?? null;

    const db = createDb();

    // Resolve entered_by from the DB by session email — guards against stale
    // JWT user.id (e.g. after a DB re-seed); same pattern as processUpload.
    if (body.create_company_from_ai) {
      const session = await auth();
      if (session?.user?.email) {
        const userRepo = new UserRepository(db);
        const user = await userRepo.findByEmail(session.user.email);
        body.entered_by = user?.id ?? null;
      }
    }

    const { fileService } = createContainer(db);
    const result = await fileService.approve(id, body, enteredBy);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof CompanyL0RequirementsError) {
      return NextResponse.json(
        { error: 'Missing required fields', missingFields: error.missingFields },
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
