import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function POST(req: NextRequest) {
  try {
    const { email, name, password } = await req.json();
    const db = createDb();
    const { authService } = createContainer(db, await getActiveWorkspaceId());
    await authService.signUp(email, name, password);
    return NextResponse.json({ error: null });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Signup failed';
    const status = message === 'Email already registered' ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
