import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { improvePrompt } from '@/lib/chat/improvePrompt';
import { runWithLangfuseUser } from '@/lib/langfuseUser';

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (!prompt.trim()) {
      return NextResponse.json({ error: 'A non-empty prompt is required' }, { status: 400 });
    }

    // `improvePrompt` runs a Haiku call and takes no user parameter, so the
    // trace is attributed from the ambient store like every other entrypoint.
    const improved = await runWithLangfuseUser(session.user.id, () =>
      improvePrompt(prompt),
    );
    return NextResponse.json({ data: { improved } });
  } catch (err) {
    console.error('[chat/improve-prompt]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
