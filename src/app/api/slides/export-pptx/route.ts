import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { exportSlidesToPptx } from '@/lib/services/slideExportService';

export async function GET(request: NextRequest) {
  try {
    const companyId = new URL(request.url).searchParams.get('companyId');
    if (!companyId) {
      return NextResponse.json(
        { error: 'Missing required query parameter: companyId' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { slideService } = createContainer(db, await getActiveWorkspaceId());
    const slides = await slideService.findByCompanyId(companyId);

    if (slides.length === 0) {
      return NextResponse.json({ error: 'No slides found for this company' }, { status: 404 });
    }

    const pptxBuffer = await exportSlidesToPptx(slides);

    return new NextResponse(new Uint8Array(pptxBuffer), {
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'Content-Disposition': 'attachment; filename="slides.pptx"',
      },
    });
  } catch (error) {
    console.error('GET slides/export-pptx error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Internal server error' },
      { status: 500 },
    );
  }
}
