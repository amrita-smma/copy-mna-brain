import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import {
  COPILOT_AGENTS,
  NotSuperadminError,
  WORKSPACE_CURRENCIES,
  WORKSPACE_PPTX_TEMPLATES,
  WorkspaceNotFoundError,
} from '@/lib/services/workspaceService';
import { MNA_WORKSPACE_ID } from '@/lib/constants';

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = createDb();
    const { workspaceService } = createContainer(db, MNA_WORKSPACE_ID);
    if (!(await workspaceService.isSuperadmin(session.user.id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const { id } = await params;
    const { name, slug, copilot_agent, default_currency, pptx_template } = await req.json();
    if (
      name === undefined &&
      slug === undefined &&
      copilot_agent === undefined &&
      default_currency === undefined &&
      pptx_template === undefined
    ) {
      return NextResponse.json(
        { error: 'name, slug, copilot_agent, default_currency, or pptx_template is required' },
        { status: 400 },
      );
    }

    let data;
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return NextResponse.json({ error: 'name is required' }, { status: 400 });
      }
      data = await workspaceService.renameWorkspace(id, name.trim());
    }
    if (slug !== undefined) {
      if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
        return NextResponse.json(
          { error: 'slug must be lowercase letters, numbers, and hyphens only' },
          { status: 400 },
        );
      }
      try {
        data = await workspaceService.updateWorkspaceSlug(id, slug);
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === '23505') {
          return NextResponse.json({ error: 'Slug is already in use' }, { status: 409 });
        }
        throw err;
      }
    }
    if (copilot_agent !== undefined) {
      if (!COPILOT_AGENTS.includes(copilot_agent)) {
        return NextResponse.json(
          { error: `copilot_agent must be one of: ${COPILOT_AGENTS.join(', ')}` },
          { status: 400 },
        );
      }
      data = await workspaceService.updateCopilotAgent(id, copilot_agent);
    }
    if (default_currency !== undefined) {
      if (!WORKSPACE_CURRENCIES.includes(default_currency)) {
        return NextResponse.json(
          { error: `default_currency must be one of: ${WORKSPACE_CURRENCIES.join(', ')}` },
          { status: 400 },
        );
      }
      data = await workspaceService.updateDefaultCurrency(id, default_currency);
    }
    if (pptx_template !== undefined) {
      if (!WORKSPACE_PPTX_TEMPLATES.includes(pptx_template)) {
        return NextResponse.json(
          { error: `pptx_template must be one of: ${WORKSPACE_PPTX_TEMPLATES.join(', ')}` },
          { status: 400 },
        );
      }
      data = await workspaceService.updatePptxTemplate(id, pptx_template);
    }

    return NextResponse.json({ data });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Soft-delete (archive) a workspace. Superadmin-only — enforced here and
 * again inside `WorkspaceService.softDeleteWorkspace`. The row is kept, so
 * the slug stays reserved and `POST /api/workspaces/{id}/restore` can bring
 * the workspace back with its data and memberships intact.
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = createDb();
    const { workspaceService } = createContainer(db, MNA_WORKSPACE_ID);
    const { id } = await params;
    const data = await workspaceService.softDeleteWorkspace(session.user.id, id);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof NotSuperadminError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (error instanceof WorkspaceNotFoundError) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
