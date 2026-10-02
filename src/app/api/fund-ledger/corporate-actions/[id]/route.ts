import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { corporateActionsEnabled } from '@/lib/flags';
import {
  createContainer,
  FL_DOMAIN_ERRORS,
  type OwnershipChangeRequest,
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
  console.error(error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** Builds participant inputs field-by-field; never spreads request JSON into the service. */
function parseParticipants(raw: unknown): OwnershipChangeRequest[] {
  if (!Array.isArray(raw)) return raw as OwnershipChangeRequest[];
  return raw.map((p: Record<string, unknown>) => ({
    position_id: p?.position_id as string,
    pct_before: p?.pct_before as string,
    follow_on_amount: (p?.follow_on_amount as string | null | undefined) ?? null,
    pct_override: (p?.pct_override as string | null | undefined) ?? null,
    override_remark: (p?.override_remark as string | null | undefined) ?? null,
    pct_after: (p?.pct_after as string | null | undefined) ?? null,
  }));
}

/** PUT — replace the action's terms and participants; its type stays as recorded. */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await corporateActionsEnabled())) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flCorporateActionService } = createContainer(db, workspaceId);
    const body = await req.json();

    const data = await flCorporateActionService.update(workspaceId, id, {
      action_date: body.action_date,
      label: body.label ?? null,
      currency: body.currency,
      pre_money: body.pre_money,
      round_size: body.round_size,
      notes: body.notes ?? null,
      participants: parseParticipants(body.participants),
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}

/** DELETE — remove the round and its changes. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await corporateActionsEnabled())) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flCorporateActionService } = createContainer(db, workspaceId);

    await flCorporateActionService.delete(workspaceId, id);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
