import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId, getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { auth } from '@/auth';
import { toSummary } from '@/lib/services/insightService';
import { insightErrorResponse } from '@/app/api/insights/errorResponse';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { insightService } = createContainer(db, workspaceId);

    const versionParam = req.nextUrl.searchParams.get('version');
    let versionNo: number | undefined;
    if (versionParam !== null) {
      const parsed = parseInt(versionParam, 10);
      if (isNaN(parsed) || parsed < 1) {
        return NextResponse.json(
          { error: 'Invalid version query parameter' },
          { status: 400 },
        );
      }
      versionNo = parsed;
    }

    const data = await insightService.get(workspaceId, id, versionNo);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return insightErrorResponse(error, '[GET /api/insights/[id]]');
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const db = createDb();
    const { insightService } = createContainer(db, workspaceId);

    const body = await req.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json(
        { error: 'Request body must be a JSON object' },
        { status: 400 },
      );
    }
    // Present-but-null is meaningful (unbind), so test for the key, not truthiness.
    const hasAgentKey = 'agent_key' in body;
    // Each field is its own service write with no shared transaction, so a
    // body carrying several would half-apply when a later one is rejected.
    // Every client sends exactly one; refuse the rest instead of guessing.
    // `archive` (or its older spelling `is_archived`): true archives, false
    // restores an archived insight.
    const archiveValue: boolean | undefined =
      typeof body.archive === 'boolean'
        ? body.archive
        : typeof body.is_archived === 'boolean'
          ? body.is_archived
          : undefined;
    if (
      typeof body.archive === 'boolean' &&
      typeof body.is_archived === 'boolean' &&
      body.archive !== body.is_archived
    ) {
      return NextResponse.json(
        { error: 'archive and is_archived disagree' },
        { status: 400 },
      );
    }
    const fieldCount = [
      archiveValue !== undefined,
      typeof body.name === 'string',
      typeof body.is_featured === 'boolean',
      hasAgentKey,
    ].filter(Boolean).length;
    if (fieldCount > 1) {
      return NextResponse.json(
        { error: 'Update one of name, is_featured, agent_key or archive per request' },
        { status: 400 },
      );
    }
    if (
      hasAgentKey &&
      body.agent_key !== null &&
      typeof body.agent_key !== 'string'
    ) {
      return NextResponse.json(
        { error: 'agent_key must be a string or null' },
        { status: 400 },
      );
    }

    const session = await auth();
    const userId = session?.user?.id ?? null;

    let updated = null;

    if (archiveValue === true) {
      updated = await insightService.archive(workspaceId, id);
    } else if (archiveValue === false) {
      updated = await insightService.restore(workspaceId, id);
    } else {
      if (typeof body.name === 'string') {
        updated = await insightService.rename(
          workspaceId,
          id,
          body.name,
          userId,
        );
      }
      if (typeof body.is_featured === 'boolean') {
        updated = await insightService.setFeatured(
          workspaceId,
          id,
          body.is_featured,
          userId,
        );
      }
      if (hasAgentKey) {
        // The sector agent binding (MB-546). Any workspace member who can
        // PATCH the insight can change it — the same gate as rename.
        updated = await insightService.setAgentBinding(
          workspaceId,
          id,
          body.agent_key as string | null,
          userId,
        );
      }
    }

    if (!updated) {
      // If no valid patch fields were provided, fetch current state
      const detail = await insightService.get(workspaceId, id);
      updated = toSummary(detail, detail.latest_version_no);
    }

    return NextResponse.json({ data: updated });
  } catch (error: unknown) {
    return insightErrorResponse(error, '[PATCH /api/insights/[id]]');
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const db = createDb();
    const { insightService, copilotChatsService } = createContainer(db, workspaceId);

    const body = (await req.json()) ?? {};
    const html = body.html;
    if (html === undefined || html === null || typeof html !== 'string') {
      return NextResponse.json(
        { error: 'Missing required field: html' },
        { status: 400 },
      );
    }
    // With `section`, `html` is that one block's replacement fragment and the
    // service splices it into the current version; without, the whole document.
    const section = body.section;
    if (section !== undefined && section !== null && typeof section !== 'string') {
      return NextResponse.json(
        { error: 'section must be a string' },
        { status: 400 },
      );
    }

    const session = await auth();
    const userId = session?.user?.id ?? null;
    const baseVersionNo =
      body.baseVersionNo ?? body.base_version_no ?? null;

    // Published from an approved CoPilot edit card: stamp the version with the
    // agent the chat thread runs on (MB-549), read from the chat row — never
    // from the body — and null for the general CoPilot.
    const agentStamp =
      typeof body.chat_id === 'string' && userId
        ? await copilotChatsService.agentStampFor(body.chat_id, userId)
        : null;

    const common = {
      workspaceId,
      insightId: id,
      label: body.label ?? null,
      userId,
      baseVersionNo:
        typeof baseVersionNo === 'number' ? baseVersionNo : null,
      agentStamp,
    };
    const data =
      typeof section === 'string' && section.trim() !== ''
        ? await insightService.publishSectionEdit({ ...common, section, fragment: html })
        : await insightService.publishVersion({ ...common, html });

    return NextResponse.json({ data });
  } catch (error: unknown) {
    return insightErrorResponse(error, '[POST /api/insights/[id]]');
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const db = createDb();
    const { insightService } = createContainer(db, workspaceId);

    if (req.nextUrl.searchParams.get('hard') === 'true') {
      await insightService.delete(workspaceId, id);
      return NextResponse.json({ data: { id, deleted: true } });
    }

    const data = await insightService.archive(workspaceId, id);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return insightErrorResponse(error, '[DELETE /api/insights/[id]]');
  }
}
