import { type NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { DISCOVERED_STAGE } from '@/lib/constants';

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const db = createDb();
    const { companyRelationshipService } = createContainer(db, await getActiveWorkspaceId());

    const result = await companyRelationshipService.resolveOrCreateDiscovered(name);

    if (!result.created) {
      const matchedName = result.row.target ?? result.row.project_name ?? name;
      return NextResponse.json(
        {
          error: `A company named "${matchedName}" already exists`,
          match: { id: result.row.id, name: matchedName },
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      { data: { id: result.row.id, name: result.row.target ?? result.row.project_name } },
      { status: 201 },
    );
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const nodeId = typeof body?.nodeId === 'string' ? body.nodeId : '';
    const replacementId = typeof body?.replacementId === 'string' ? body.replacementId : undefined;

    if (!nodeId) {
      return NextResponse.json({ error: 'nodeId is required' }, { status: 400 });
    }

    const db = createDb();
    const { companyService, companyGraphService } = createContainer(db, await getActiveWorkspaceId());

    // Validate the company exists and is at the discovered stage.
    const company = await companyService.findById(nodeId);
    if (!company) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }
    if (company.pipeline_stage !== DISCOVERED_STAGE) {
      return NextResponse.json(
        { error: 'Only companies at the Discovered stage can be removed from the graph' },
        { status: 403 },
      );
    }

    // Reassign edges in Neo4j (if a replacement was given) then DETACH DELETE.
    await companyGraphService.reassignAndDeleteNode(nodeId, replacementId);

    // Remove from Postgres — cascades drop related logs/documents.
    await companyService.delete(nodeId);

    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
