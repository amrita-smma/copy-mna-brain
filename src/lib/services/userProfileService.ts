import type {
  UserProfileRow,
  UserProfileUpdate,
  UserRepository,
} from '@/lib/repositories';

/** The profile as Profile → Your Profile renders it. */
export interface UserProfile {
  id: string;
  fullName: string;
  nickName: string;
  /** Read-only on the form — it is the sign-in identity. */
  email: string;
  phoneCode: string;
  phone: string;
  jobTitle: string;
  howBrainHelps: string;
}

/** What the form may change. Every field is optional; absent means "leave it". */
export interface UserProfileInput {
  fullName?: string;
  nickName?: string;
  phoneCode?: string;
  phone?: string;
  jobTitle?: string;
  howBrainHelps?: string;
}

export class UserProfileNotFoundError extends Error {
  constructor() {
    super('User not found');
    this.name = 'UserProfileNotFoundError';
  }
}

export class UserProfileInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserProfileInvalidError';
  }
}

/** Longest a free-text profile field may be. The textarea is for a sentence or two. */
const MAX_TEXT = 500;
/** Name fields are a name, not a paragraph. */
const MAX_NAME = 120;

/**
 * The signed-in user's own profile — the form on Profile → Your Profile.
 *
 * Always acts on the session user; there is no `userId` parameter on the public
 * methods beyond the one the route passes from the session, and `email` is
 * never writable here. Changing a sign-in identity is an admin operation
 * (`/api/users/:id`), deliberately kept out of a self-service form.
 *
 * Nulls become empty strings on the way out so the form is always controlled,
 * and empty strings become null on the way in so "cleared" and "never set" are
 * the same state in the database rather than two.
 */
export class UserProfileService {
  constructor(private readonly users: Pick<UserRepository, 'findProfile' | 'updateProfile'>) {}

  async get(userId: string): Promise<UserProfile> {
    const row = await this.users.findProfile(userId);
    if (!row) throw new UserProfileNotFoundError();
    return toProfile(row);
  }

  async update(userId: string, input: UserProfileInput): Promise<UserProfile> {
    const updates = toUpdates(input);
    // Nothing to write — return what is stored rather than issuing an UPDATE
    // that would only bump `updated_at`.
    if (Object.keys(updates).length === 0) return this.get(userId);

    const row = await this.users.updateProfile(userId, updates);
    if (!row) throw new UserProfileNotFoundError();
    return toProfile(row);
  }
}

function toProfile(row: UserProfileRow): UserProfile {
  return {
    id: row.id,
    fullName: row.name ?? '',
    nickName: row.nickname ?? '',
    email: row.email ?? '',
    phoneCode: row.phone_code ?? '',
    phone: row.phone ?? '',
    jobTitle: row.job_title ?? '',
    howBrainHelps: row.how_brain_helps ?? '',
  };
}

/**
 * Map the form's camelCase onto columns, trimming and validating. An omitted
 * key is left alone; a key set to an empty string clears the column.
 */
function toUpdates(input: UserProfileInput): UserProfileUpdate {
  const updates: UserProfileUpdate = {};

  if (input.fullName !== undefined) {
    const name = clean(input.fullName, MAX_NAME, 'Full name');
    // `users.name` is NOT NULL and is what the rest of the app renders, so it
    // is the one field the form cannot blank out.
    if (!name) throw new UserProfileInvalidError('Full name is required');
    updates.name = name;
  }
  if (input.nickName !== undefined) {
    updates.nickname = clean(input.nickName, MAX_NAME, 'Nick name') || null;
  }
  if (input.phoneCode !== undefined) {
    updates.phone_code = clean(input.phoneCode, 8, 'Country code') || null;
  }
  if (input.phone !== undefined) {
    const phone = clean(input.phone, 32, 'Phone');
    if (phone && !/^[0-9 ()-]+$/.test(phone)) {
      throw new UserProfileInvalidError('Phone may only contain digits, spaces, brackets and dashes');
    }
    updates.phone = phone || null;
  }
  if (input.jobTitle !== undefined) {
    updates.job_title = clean(input.jobTitle, MAX_NAME, 'Job title') || null;
  }
  if (input.howBrainHelps !== undefined) {
    updates.how_brain_helps = clean(input.howBrainHelps, MAX_TEXT, 'How Brain can help') || null;
  }

  return updates;
}

function clean(value: string, max: number, label: string): string {
  if (typeof value !== 'string') {
    throw new UserProfileInvalidError(`${label} must be text`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new UserProfileInvalidError(`${label} must be ${max} characters or fewer`);
  }
  return trimmed;
}
