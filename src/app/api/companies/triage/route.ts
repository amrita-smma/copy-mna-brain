import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';

export interface TriageDecision {
  id: string;
  action: 'keep' | 'drop';
  reason?: string;
}

export async function POST(req: NextRequest) {
  try {
    const { decisions } = (await req.json()) as { decisions: TriageDecision[] };

    if (!Array.isArray(decisions) || decisions.length === 0) {
      return NextResponse.json({ error: 'decisions array is required' }, { status: 400 });
    }

    const db = createDb();
    const { companyService } = createContainer(db);

    const keeps = decisions.filter((d) => d.action === 'keep').map((d) => d.id);
    const drops = decisions.filter((d) => d.action === 'drop');

    // Keep: transition unreviewed → reviewed (stays L0, awaiting prospectus review)
    if (keeps.length > 0) {
      await companyService.bulkMarkReviewed(keeps);
    }

    // Drop: mark dropped with reason
    for (const drop of drops) {
      await companyService.drop(drop.id, drop.reason ?? 'Outside thesis');
    }

    return NextResponse.json({
      data: { kept: keeps.length, dropped: drops.length },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Triage failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Count of unreviewed companies (for badge)
export async function GET(req: NextRequest) {
  try {
    const db = createDb();
    const { companyService } = createContainer(db);
    const source = req.nextUrl.searchParams.get('source') ?? undefined;
    const count = await companyService.countUnreviewed(source);
    return NextResponse.json({ data: { count } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to count';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
