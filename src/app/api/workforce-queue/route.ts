import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { CompanyRepository } from '@/lib/repositories';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';

interface HandoffBody {
  agent_name?: string;
  title?: string;
  instruction?: string;
  conversation_id?: string;
  tool_call_id?: string;
  priority?: number;
  company_ids?: string[];
}

const DEFAULT_AGENT = 'chat_handoff';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const db = createDb();
    const { aiWorkforceService } = createContainer(db);
    const toolCallId = req.nextUrl.searchParams.get('tool_call_id');
    if (toolCallId) {
      const item = await aiWorkforceService.findByToolCallId(toolCallId);
      return NextResponse.json({ item });
    }
    const items = await aiWorkforceService.listQueue();
    return NextResponse.json({ items });
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

    // Server-side backstop for the dropped-company guard. The tool refuses
    // to render the card when any cited company is dropped, but the POST
    // body is still user-controllable from the browser — re-check here so
    // direct curl/replay can't bypass it.
    const companyIds = Array.isArray(body.company_ids) ? body.company_ids : [];
    if (companyIds.length > 0) {
      const droppedIds = await new CompanyRepository(db).findDroppedIds(
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

    const { aiWorkforceService } = createContainer(db);
    const row = await aiWorkforceService.enqueueFromChat({
      agent_name: body.agent_name?.trim() || DEFAULT_AGENT,
      title,
      instruction,
      conversation_id: body.conversation_id,
      tool_call_id: body.tool_call_id,
      user_id: userId,
      priority: body.priority,
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
