import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getStatelessAgentGraph } from '@/lib/agents/analysis';
import { createDb } from '@/lib/server/db';
import { enqueueAgentRun } from '@/lib/workforce';

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    const userId = session?.user?.id ?? null;

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const thesisOverride = typeof body.thesis === 'string' ? body.thesis : null;
    const sourcesCount = typeof body.sourcesCount === 'number' ? body.sourcesCount : 5;

    const prompt = thesisOverride
      ? `Run market screening using this investment thesis: ${thesisOverride}\n\nUse the run_market_screening tool and pass sources_count=${sourcesCount}.`
      : `Run the market scan. Use the run_market_screening tool with sources_count=${sourcesCount} to discover new acquisition targets matching our active investment thesis.`;

    const db = createDb();
    const { runId } = await enqueueAgentRun(db, {
      agentName: 'analysis',
      triggerSource: 'api',
      input: { prompt, title: 'Market Screening' },
      priority: 1,
      triggeredByUserId: userId,
    });

    return NextResponse.json({ runId }, { status: 202 });
  } catch (error: unknown) {
    console.error('Market screening error:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  const agent = await getStatelessAgentGraph();
  return NextResponse.json({
    status: agent ? 'ok' : 'not_configured',
    message: agent ? 'Agent is ready' : 'Agent not available. Check ANTHROPIC_API_KEY.',
  });
}
