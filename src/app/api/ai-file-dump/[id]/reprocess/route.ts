import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: 'File ID is required' }, { status: 400 });
    }

    const db = createDb();
    const { fileService } = createContainer(db);
    const result = await fileService.reprocess(id);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error('Reprocess file error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to reprocess file' },
      { status: 500 },
    );
  }
}
