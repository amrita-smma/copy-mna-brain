import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { getPptxTemplate } from '@/lib/pptx/templates';
import {
  pipelinePresentationSchema,
  type PipelinePresentation,
} from '@/lib/pipeline/presentation';
import {
  pipelinePresentationToPptx,
  presentationFileName,
} from '@/lib/pptx/pipelinePresentationPptx';

const PPTX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/**
 * POST /api/pipeline/presentation/pptx — the Pipeline "Present" table as a
 * .pptx. The body is the `PipelinePresentation` the dialog is showing
 * (`buildPipelinePresentation`), so the deck is exactly the rows and columns
 * on screen. The only thing read is the workspace's PowerPoint Template
 * setting: StarCapital puts the slides on its branded master, Default leaves
 * them plain.
 */
export async function POST(req: NextRequest) {
  try {
    const parsed = pipelinePresentationSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid presentation' }, { status: 400 });
    }
    // The schema requires every field; zod's inferred type marks them optional.
    const deck = parsed.data as PipelinePresentation;
    const db = createDb();
    const workspaceId = await getActiveWorkspaceId();
    const { workspaceService } = createContainer(db, workspaceId);
    const template = getPptxTemplate(await workspaceService.getPptxTemplate(workspaceId));
    const buffer = await pipelinePresentationToPptx(deck, template);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': PPTX_CONTENT_TYPE,
        'Content-Disposition': `attachment; filename="${presentationFileName(deck)}"`,
      },
    });
  } catch (err) {
    console.error('POST pipeline/presentation/pptx error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
