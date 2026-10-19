import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { CompanyRepository, UserRepository } from '@/lib/repositories';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { asWorkforceEffort, type EffortChoice } from '@/lib/chat/effortTiers';
import { chatAttachmentPrefix } from '@/lib/s3';
import { isChatAttachmentRef, type ChatAttachmentRef } from '@/lib/services/chatAttachmentService';

interface HandoffBody {
  agent_name?: string;
  title?: string;
  instruction?: string;
  conversation_id?: string;
  tool_call_id?: string;
  priority?: number;
  company_ids?: string[];
  effort?: EffortChoice;
  attachments?: ChatAttachmentRef[];
}

const DEFAULT_AGENT = 'chat_handoff';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const db = createDb();
    const workspaceId = await getActiveWorkspaceId();
    const { aiWorkforceService } = createContainer(db, workspaceId);
    const toolCallId = req.nextUrl.searchParams.get('tool_call_id');
    if (toolCallId) {
      const item = await aiWorkforceService.findByToolCallId(toolCallId);
      // findByToolCallId is unscoped (shared with system-internal callers) —
      // enforce workspace ownership here, at the user-facing edge.
      if (item && item.workspace_id !== workspaceId) {
        return NextResponse.json({ item: null });
      }
      return NextResponse.json({ item });
    }
    const items = await aiWorkforceService.listQueue();
    // Attach the submitter's display name so the queue UI can show "who
    // kicked this off" rather than the agent_name. Cron/webhook rows and any
    // row whose user has since been deleted come back with null — the client
    // falls back to a per-trigger-source label.
    const userIds = Array.from(
      new Set(
        items
          .map((it) => it.triggered_by_user_id)
          .filter((id): id is string => typeof id === 'string'),
      ),
    );
    const userMap = new Map<string, string>();
    if (userIds.length > 0) {
      const userRepo = new UserRepository(db);
      const users = await userRepo.findByIds(userIds);
      for (const u of users) userMap.set(u.id, u.name);
    }
    // Global (cross-workspace) queue position — the shared single-worker
    // queue (RFC: "1 Worker model for all applications") means this
    // workspace's own pending items can each be blocked by other
    // workspaces' higher-priority or earlier rows, invisibly to a
    // workspace-local count.
    const queuedIds = items
      .filter((it) => it.status === 'pending' || it.status === 'resume_ready')
      .map((it) => it.id);
    const positions = await aiWorkforceService.getGlobalQueuePositions(queuedIds);
    const enriched = items.map((it) => ({
      ...it,
      triggered_by_user_name: it.triggered_by_user_id
        ? userMap.get(it.triggered_by_user_id) ?? null
        : null,
      ahead_globally: positions.get(it.id)?.aheadGlobally ?? null,
      ahead_other_workspaces: positions.get(it.id)?.aheadOtherWorkspaces ?? null,
    }));
    return NextResponse.json({ items: enriched });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to list workforce queue';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  try {
    const body = (await req.json()) as HandoffBody;
    const title = body.title?.trim();
    const instruction = body.instruction?.trim();

    if (!title || !instruction) {
      return NextResponse.json(
        { error: 'title and instruction are required' },
        { status: 400 },
      );
    }

    const db = createDb();
    const workspaceId = await getActiveWorkspaceId();

    // Validate attachment refs server-side rather than trusting the model.
    // Reject anything whose key is not under this workspace's chat-attachment prefix.
    const prefix = chatAttachmentPrefix(workspaceId);
    let attachments: ChatAttachmentRef[] | undefined;
    if (body.attachments !== undefined) {
      if (!Array.isArray(body.attachments)) {
        return NextResponse.json(
          { error: 'attachments must be an array' },
          { status: 400 },
        );
      }
      for (const att of body.attachments) {
        if (!isChatAttachmentRef(att) || !att.key.startsWith(prefix)) {
          return NextResponse.json(
            { error: `Invalid attachment: key must start with ${prefix}` },
            { status: 400 },
          );
        }
      }
      attachments = body.attachments;
    }

    // Server-side backstop for the dropped-company guard. The tool refuses
    // to render the card when any cited company is dropped, but the POST
    // body is still user-controllable from the browser — re-check here so
    // direct curl/replay can't bypass it.
    const companyIds = Array.isArray(body.company_ids) ? body.company_ids : [];
    if (companyIds.length > 0) {
      const droppedIds = await new CompanyRepository(db, workspaceId).findDroppedIds(
        companyIds,
      );
      if (droppedIds.length > 0) {
        return NextResponse.json(
          {
            error: `Cannot assign to Workforce: ${droppedIds.length === 1 ? 'company' : 'companies'} ${droppedIds.join(', ')} ${droppedIds.length === 1 ? 'is' : 'are'} dropped and read-only.`,
            droppedIds,
          },
          { status: 409 },
        );
      }
    }

    const { aiWorkforceService } = createContainer(db, workspaceId);
    const row = await aiWorkforceService.enqueueFromChat({
      agent_name: body.agent_name?.trim() || DEFAULT_AGENT,
      title,
      instruction,
      conversation_id: body.conversation_id,
      tool_call_id: body.tool_call_id,
      user_id: userId,
      priority: body.priority,
      // Floored at 'medium' on purpose. The workforce runs long, unattended,
      // write-capable tasks — the workload that most repays effort, and the one
      // with no user waiting to benefit from a cheaper tier. 'low' exists for
      // interactive chat lookups; it must not be reachable from the queue.
      // 'deep' is allowed here specifically for workforce workloads.
      effort: asWorkforceEffort(body.effort),
      attachments,
    });

    return NextResponse.json({
      data: {
        id: row.id,
        status: row.status,
        created_at: row.created_at,
      },
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to enqueue workforce task';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
