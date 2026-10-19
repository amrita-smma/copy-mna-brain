import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { auth } from '@/auth';
import { CompanyL0RequirementsError } from '@/lib/services/companyService';

export interface TriageDecision {
  id: string;
  action: 'keep' | 'drop';
  reason?: string;
}

export interface TriageKeepError {
  id: string;
  missingFields: string[];
}

export async function POST(req: NextRequest) {
  try {
    const { decisions } = (await req.json()) as { decisions: TriageDecision[] };

    if (!Array.isArray(decisions) || decisions.length === 0) {
      return NextResponse.json({ error: 'decisions array is required' }, { status: 400 });
    }

    const db = createDb();
    const { companyService } = createContainer(db, await getActiveWorkspaceId());

    const keeps = decisions.filter((d) => d.action === 'keep');
    const drops = decisions.filter((d) => d.action === 'drop');

    // Keep: promote each company from unreviewed → L0 (triggers MB-320 field validation).
    // The acting user fills in a blank Entered By and is credited in telemetry.
    const session = await auth();
    const triggeredByUserId = session?.user?.id ?? null;
    const keepErrors: TriageKeepError[] = [];
    let kept = 0;
    for (const decision of keeps) {
      try {
        await companyService.promote(
          decision.id,
          'unreviewed',
          'L0',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { triggeredByUserId },
        );
        kept++;
      } catch (err) {
        if (err instanceof CompanyL0RequirementsError) {
          keepErrors.push({ id: decision.id, missingFields: err.missingFields });
        } else {
          throw err;
        }
      }
    }

    // Drop: mark dropped with reason
    for (const drop of drops) {
      await companyService.drop(drop.id, drop.reason ?? 'Outside thesis');
    }

    if (keepErrors.length > 0) {
      return NextResponse.json(
        { error: 'Some companies are missing required fields', keepErrors, data: { kept, dropped: drops.length } },
        { status: 422 },
      );
    }

    return NextResponse.json({
      data: { kept, dropped: drops.length },
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
    const { companyService } = createContainer(db, await getActiveWorkspaceId());
    const source = req.nextUrl.searchParams.get('source') ?? undefined;
    const count = await companyService.countUnreviewed(source);
    return NextResponse.json({ data: { count } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to count';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
