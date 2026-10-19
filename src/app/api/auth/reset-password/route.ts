import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

export async function POST(req: NextRequest) {
  try {
    const { key, password } = await req.json();
    const db = createDb();
    const { authService } = createContainer(db, await getActiveWorkspaceId());
    await authService.resetPassword(key, password);
    return NextResponse.json({ error: null });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to reset password';
    const status = message === 'Invalid or expired reset token' ? 400 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
