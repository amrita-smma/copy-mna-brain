import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { RELATION_TYPES, type RelationType } from '@/lib/repositories/companyRelationRepository';

function isValidType(v: unknown): v is RelationType {
  return typeof v === 'string' && RELATION_TYPES.includes(v as RelationType);
}

async function getAuthorizedContainer(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return null;
  const db = createDb();
  const workspaceId = await getActiveWorkspaceId();
  const container = createContainer(db, workspaceId);
  return { container, workspaceId };
}

async function validateCompanyIds(
  container: Awaited<ReturnType<typeof getAuthorizedContainer>>['container'],
  ids: string[],
): Promise<boolean> {
  const companies = await container.companyService.list({});
  const ownIds = new Set(companies.map((c) => c.id));
  return ids.every((id) => ownIds.has(id));
}

export async function POST(req: NextRequest) {
  try {
    const result = await getAuthorizedContainer(req);
    if (!result) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { container } = result;

    const body = await req.json();
    const { sourceId, targetId, type, notes, evidence, date } = body as Record<string, string>;

    if (!sourceId || !targetId || !isValidType(type)) {
      return NextResponse.json({ error: 'sourceId, targetId, and type are required' }, { status: 400 });
    }
    if (sourceId === targetId) {
      return NextResponse.json({ error: 'sourceId and targetId must differ' }, { status: 400 });
    }

    const valid = await validateCompanyIds(container, [sourceId, targetId]);
    if (!valid) return NextResponse.json({ error: 'Company not found in workspace' }, { status: 404 });

    await container.companyGraphService.updateRelation({
      rawSourceId: sourceId,
      rawTargetId: targetId,
      rawType: type,
      newSourceId: sourceId,
      newTargetId: targetId,
      newType: type,
      notes: notes || undefined,
      evidence: evidence || undefined,
      date: date || undefined,
    });

    return NextResponse.json({ data: { ok: true } }, { status: 201 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const result = await getAuthorizedContainer(req);
    if (!result) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { container } = result;

    const body = await req.json();
    const { rawSourceId, rawTargetId, rawType, sourceId, targetId, type, notes, evidence, date } =
      body as Record<string, string>;

    if (!rawSourceId || !rawTargetId || !isValidType(rawType)) {
      return NextResponse.json({ error: 'rawSourceId, rawTargetId, and rawType are required' }, { status: 400 });
    }
    const newSourceId = sourceId || rawSourceId;
    const newTargetId = targetId || rawTargetId;
    const newType = isValidType(type) ? type : rawType;

    if (newSourceId === newTargetId) {
      return NextResponse.json({ error: 'sourceId and targetId must differ' }, { status: 400 });
    }

    const valid = await validateCompanyIds(container, [rawSourceId, rawTargetId, newSourceId, newTargetId]);
    if (!valid) return NextResponse.json({ error: 'Company not found in workspace' }, { status: 404 });

    await container.companyGraphService.updateRelation({
      rawSourceId,
      rawTargetId,
      rawType,
      newSourceId,
      newTargetId,
      newType,
      notes: notes || undefined,
      evidence: evidence || undefined,
      date: date || undefined,
    });

    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const result = await getAuthorizedContainer(req);
    if (!result) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { container } = result;

    const body = await req.json();
    const { sourceId, targetId, type } = body as Record<string, string>;

    if (!sourceId || !targetId || !isValidType(type)) {
      return NextResponse.json({ error: 'sourceId, targetId, and type are required' }, { status: 400 });
    }

    const valid = await validateCompanyIds(container, [sourceId, targetId]);
    if (!valid) return NextResponse.json({ error: 'Company not found in workspace' }, { status: 404 });

    await container.companyGraphService.deleteRelation(sourceId, targetId, type);

    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
