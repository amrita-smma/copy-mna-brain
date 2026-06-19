import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
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
    const { companyAnalysisService } = createContainer(db);
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
    const body = (await request.json()) as CompanyAnalysisPayload;
    if (!body.companyId) {
      return NextResponse.json(
        { error: 'Missing required field: companyId' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { companyAnalysisService } = createContainer(db);
    const result = await companyAnalysisService.dispatch(body);

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
    const { companyAnalysisService } = createContainer(db);
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
