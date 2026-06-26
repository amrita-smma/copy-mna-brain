import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import type { ApproveFileInput } from '@/lib/services/fileService';

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
    const { fileService } = createContainer(db);
    const result = await fileService.approve(id, body, enteredBy);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error('Approve file error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to approve file' },
      { status: 500 },
    );
  }
}
