import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import {
  FL_DOMAIN_ERRORS,
  type OpenPositionInput,
} from '@/lib/services';

function handleRouteError(error: unknown) {
  if (
    FL_DOMAIN_ERRORS.some(
      (cls) =>
        error instanceof cls ||
        (error instanceof Error && error.name === cls.name),
    )
  ) {
    const err = error as Error;
    return NextResponse.json(
      { error: err.message, error_name: err.name },
      { status: 422 },
    );
  }
  const message =
    error instanceof Error ? error.message : 'Internal server error';
  return NextResponse.json({ error: message }, { status: 500 });
}

function parseTriState(val: string | null): string | null | undefined {
  if (val === null) return undefined;
  if (val === 'null') return null;
  return val || undefined;
}

export async function GET(req: NextRequest) {
  try {
    const workspaceId = await getActiveWorkspaceId();
    const searchParams = req.nextUrl.searchParams;
    const fundId = searchParams.get('fundId') || undefined;
    const holderInvestorId = searchParams.get('holderInvestorId') || undefined;
    const holderFundId = searchParams.get('holderFundId') || undefined;
    const assetId = searchParams.get('assetId') || undefined;
    const holderSourceOfFundId = parseTriState(searchParams.get('holderSourceOfFundId'));

    const db = createDb();
    const { flPositionService } = createContainer(db, workspaceId);
    const data = await flPositionService.listPositions(workspaceId, {
      fundId,
      holderInvestorId,
      holderFundId,
      assetId,
      holderSourceOfFundId,
    });

    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flPositionService } = createContainer(db, workspaceId);
    const body = await req.json();

    // Internal-only deterministic IDs (id) are intentionally omitted:
    // API routes must never forward caller-supplied internal IDs
    // and must build service inputs field-by-field rather than spreading request JSON.
    const data = await flPositionService.openPosition(workspaceId, {
      holder_investor_id: body.holder_investor_id ?? null,
      holder_fund_id: body.holder_fund_id ?? null,
      fund_id: body.fund_id ?? null,
      asset_id: body.asset_id ?? null,
      holder_source_of_fund_id: body.holder_source_of_fund_id ?? null,
      opened_at: body.opened_at ?? null,
      notes: body.notes ?? null,
    });

    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
