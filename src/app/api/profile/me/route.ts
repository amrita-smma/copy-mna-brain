import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { getSession } from '@/lib/server/session';
import {
  UserProfileInvalidError,
  UserProfileNotFoundError,
} from '@/lib/services/userProfileService';

/**
 * The signed-in user's own profile — Profile → Your Profile.
 *
 * Always the session user: there is no `userId` param or body field, so one
 * member can neither read nor edit another's. `email` comes back for display
 * but is not writable here; changing a sign-in identity is an admin operation
 * (`/api/users/:id`).
 */
export async function GET() {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = createDb();
    const { userProfileService } = createContainer(db, await getActiveWorkspaceId());
    return NextResponse.json({ data: await userProfileService.get(userId) });
  } catch (err) {
    if (err instanceof UserProfileNotFoundError) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    console.error('[GET /api/profile/me]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** Save the editable profile fields. Omitted keys are left as they are. */
export async function PATCH(req: NextRequest) {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const db = createDb();
    const { userProfileService } = createContainer(db, await getActiveWorkspaceId());
    const data = await userProfileService.update(userId, {
      fullName: body?.fullName,
      nickName: body?.nickName,
      phoneCode: body?.phoneCode,
      phone: body?.phone,
      jobTitle: body?.jobTitle,
      howBrainHelps: body?.howBrainHelps,
    });

    return NextResponse.json({ data });
  } catch (err) {
    // A typed domain error is the user's own input being wrong, so its message
    // is safe (and useful) to show them.
    if (err instanceof UserProfileInvalidError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof UserProfileNotFoundError) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    console.error('[PATCH /api/profile/me]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
