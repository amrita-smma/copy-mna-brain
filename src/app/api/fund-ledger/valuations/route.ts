import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import {
  createContainer,
  FL_DOMAIN_ERRORS,
  type RecordValuationInput,
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

export async function GET(req: NextRequest) {
  try {
    const workspaceId = await getActiveWorkspaceId();
    const searchParams = req.nextUrl.searchParams;

    const isSeries =
      searchParams.get('series') === 'true' ||
      searchParams.get('series') === '1';
    const assetId = searchParams.get('assetId') || undefined;
    const fundId = searchParams.get('fundId') || undefined;
    const positionId = searchParams.get('positionId') || undefined;
    const asOf =
      searchParams.get('asOf') ||
      searchParams.get('asOfDate') ||
      undefined;

    const db = createDb();
    const { flValuationService } = createContainer(db, workspaceId);

    if (isSeries) {
      const data = await flValuationService.getSeries(workspaceId, {
        assetId,
        fundId,
        positionId,
      });
      return NextResponse.json({ data });
    }

    const assetIdsParam = searchParams.get('assetIds');
    const assetIds = assetIdsParam
      ? assetIdsParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : assetId
        ? [assetId]
        : undefined;

    const fundIdsParam = searchParams.get('fundIds');
    const fundIds = fundIdsParam
      ? fundIdsParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : fundId
        ? [fundId]
        : undefined;

    const positionIdsParam = searchParams.get('positionIds');
    const positionIds = positionIdsParam
      ? positionIdsParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : positionId
        ? [positionId]
        : undefined;

    const data = await flValuationService.getLatestForTargets(
      workspaceId,
      {
        assetIds,
        fundIds,
        positionIds,
      },
      asOf,
    );

    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flValuationService } = createContainer(db, workspaceId);
    const body = await req.json();

    // Internal-only deterministic IDs (id) are intentionally omitted:
    // API routes must never forward caller-supplied internal IDs
    // and must build service inputs field-by-field rather than spreading request JSON.
    // Financial/unit fields pass through directly without coercion so invalid numeric JSON
    // is preserved and rejected by domain validation in Phase 3.
    const data = await flValuationService.record(workspaceId, {
      asset_id: body.asset_id ?? null,
      fund_id: body.fund_id ?? null,
      position_id: body.position_id ?? null,
      as_of_date: body.as_of_date,
      valuation_method: body.valuation_method ?? null,
      currency: body.currency ?? 'USD',
      market_value: body.market_value ?? null,
      price_per_unit: body.price_per_unit ?? null,
      units_outstanding: body.units_outstanding ?? null,
      gross_value: body.gross_value ?? null,
      net_value: body.net_value ?? null,
      data_status: body.data_status ?? 'verified',
      source_record_id: body.source_record_id ?? null,
      notes: body.notes ?? null,
    });

    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
