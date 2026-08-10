import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: 'File ID is required' }, { status: 400 });
    }

    // Optional override — caller can compare against a different company than
    // the one stored on the file (e.g. user picked a new match in the dialog).
    // Empty string means "no company" explicitly; absence means "use stored".
    const url = new URL(request.url);
    const companyIdOverride = url.searchParams.has('company_id')
      ? url.searchParams.get('company_id')
      : undefined;

    const db = createDb();
    const { fileService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fileService.getReviewData(id, companyIdOverride);

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('Get review data error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to get review data' },
      { status: 500 },
    );
  }
}
