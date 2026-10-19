import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import type { CompanyAnalysisPayload } from '@/lib/jobs/handlers/companyAnalysis';

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
    const { companyAnalysisService } = createContainer(db, await getActiveWorkspaceId());
    const data = await companyAnalysisService.findByCompanyId(companyId);

    if (!data) {
      return NextResponse.json({ error: 'No analysis found for this company' }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('GET company-analysis error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as CompanyAnalysisPayload & { force?: boolean };
    if (!body.companyId) {
      return NextResponse.json(
        { error: 'Missing required field: companyId' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { companyAnalysisService } = createContainer(db, await getActiveWorkspaceId());

    // `force` is the "Regenerate" button. It re-runs even though a completed
    // card exists, and deliberately keeps the existing row: the run reads its
    // `created_at` and content to date-rank the card against the company's
    // documents, letting the later-dated source win a conflict.
    if (body.force) {
      const result = await companyAnalysisService.regenerate(body.companyId, {
        reason: 'manual regenerate',
        source: body.source ?? null,
        triggeredByUserId: session.user.id,
      });
      if ('skipped' in result) {
        return NextResponse.json(
          { error: 'A Company Card run is already in progress for this company' },
          { status: 409 },
        );
      }
      return NextResponse.json({ runId: result.runId }, { status: 202 });
    }

    // Attribute the workforce run to the user who clicked "Generate Company
    // Card" so it shows as their task (not "System") and they get the email.
    const result = await companyAnalysisService.dispatch(body, session.user.id);

    if ('existing' in result) {
      return NextResponse.json(result.existing);
    }

    // Card generation now runs on the AI Workforce; return the queue run id.
    return NextResponse.json({ runId: result.runId }, { status: 202 });
  } catch (error) {
    console.error('POST company-analysis error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const companyId = new URL(request.url).searchParams.get('companyId');
    if (!companyId) {
      return NextResponse.json(
        { error: 'Missing required query parameter: companyId' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { companyAnalysisService } = createContainer(db, await getActiveWorkspaceId());
    await companyAnalysisService.delete(companyId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('DELETE company-analysis error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Internal server error' },
      { status: 500 },
    );
  }
}
