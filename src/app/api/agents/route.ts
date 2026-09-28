import { NextRequest, NextResponse } from 'next/server';
import { listSectorAgents } from '@/lib/agents/sector/registry';

/**
 * GET /api/agents — the sector agent registry for the binding selector
 * (MB-540). Session-authenticated by the `proxy.ts` middleware like every
 * other `/api/*` workspace route.
 *
 * Non-deprecated agents by default; `?include_deprecated=1` also returns
 * deprecated ones so an existing binding can still be resolved and shown.
 *
 * No createDb()/createContainer(): the registry is static code (PRD §5.1 —
 * agents are code, read-only to the app), so there is no repository or
 * service to route through, and opening a DB connection to return a constant
 * would only cost a pool slot. The registry module is LangChain-free, so this
 * route does not pull the agent stack into its bundle.
 */
export async function GET(req: NextRequest) {
  try {
    const flag = req.nextUrl.searchParams.get('include_deprecated');
    const includeDeprecated = flag === '1' || flag === 'true';
    return NextResponse.json({ data: listSectorAgents({ includeDeprecated }) });
  } catch (err) {
    console.error('[GET /api/agents]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
