import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResetPasswordTokenRepository, UserRepository } from '@/lib/repositories';
import type { Tables } from '@/lib/repositories';
import { AuthService, UserNotRegisteredError } from './authService';
import { hashPassword } from './password';

type User = Tables<'users'>;
type ResetToken = Tables<'reset_password_tokens'>;

const enqueueSendEmailMock = vi.fn().mockResolvedValue({ messageId: 'msg-1' });

vi.mock('@/lib/queue', () => ({
  enqueueSendEmail: (...args: unknown[]) => enqueueSendEmailMock(...args),
  TOPICS: { sendEmail: 'send-email' },
}));

const verifyGoogleIdTokenMock = vi.fn();

vi.mock('./googleToken', () => ({
  verifyGoogleIdToken: (...args: unknown[]) => verifyGoogleIdTokenMock(...args),
}));

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    name: 'Test User',
    email: 'test@example.com',
    password: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as User;
}

function makeUserRepoStub(): UserRepository {
  return {
    findByEmail: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findFavoriteCompanies: vi.fn(),
  } as unknown as UserRepository;
}

function makeTokenRepoStub(): ResetPasswordTokenRepository {
  return {
    create: vi.fn(),
    findValidByToken: vi.fn(),
    deleteByToken: vi.fn(),
  } as unknown as ResetPasswordTokenRepository;
}

describe('AuthService.signIn', () => {
  let userRepo: UserRepository;
  let service: AuthService;

  beforeEach(() => {
    userRepo = makeUserRepoStub();
    service = new AuthService(userRepo, makeTokenRepoStub());
  });

  it('throws when user is not found', async () => {
    vi.mocked(userRepo.findByEmail).mockResolvedValue(undefined);
    await expect(service.signIn('nobody@example.com', 'pw')).rejects.toThrow('Invalid email or password');
  });

  it('throws when password is wrong', async () => {
    const hash = await hashPassword('correct');
    vi.mocked(userRepo.findByEmail).mockResolvedValue(makeUser({ password: hash }));
    await expect(service.signIn('test@example.com', 'wrong')).rejects.toThrow('Invalid email or password');
  });

  it('returns the user on correct credentials', async () => {
    const hash = await hashPassword('correct');
    const user = makeUser({ password: hash });
    vi.mocked(userRepo.findByEmail).mockResolvedValue(user);
    const result = await service.signIn('test@example.com', 'correct');
    expect(result).toBe(user);
  });
});

describe('AuthService.signInWithGoogleToken', () => {
  let userRepo: UserRepository;
  let service: AuthService;

  beforeEach(() => {
    verifyGoogleIdTokenMock.mockReset();
    userRepo = makeUserRepoStub();
    service = new AuthService(userRepo, makeTokenRepoStub());
  });

  it('propagates the verification error for an invalid token without touching the DB', async () => {
    verifyGoogleIdTokenMock.mockRejectedValue(new Error('Google token verification failed'));
    await expect(service.signInWithGoogleToken('bad-token')).rejects.toThrow('verification failed');
    expect(userRepo.findByEmail).not.toHaveBeenCalled();
  });

  it('throws a UserNotRegisteredError when no local account matches the verified email', async () => {
    verifyGoogleIdTokenMock.mockResolvedValue('ghost@example.com');
    vi.mocked(userRepo.findByEmail).mockResolvedValue(undefined);
    await expect(service.signInWithGoogleToken('good-token')).rejects.toBeInstanceOf(
      UserNotRegisteredError,
    );
    await expect(service.signInWithGoogleToken('good-token')).rejects.toThrow(
      'Your user is not registered in the system, please contact the MnA team',
    );
    expect(userRepo.findByEmail).toHaveBeenCalledWith('ghost@example.com');
  });

  it('returns the matching user for a valid token', async () => {
    const user = makeUser({ email: 'test@example.com' });
    verifyGoogleIdTokenMock.mockResolvedValue('test@example.com');
    vi.mocked(userRepo.findByEmail).mockResolvedValue(user);

    const result = await service.signInWithGoogleToken('good-token');

    expect(result).toBe(user);
    expect(verifyGoogleIdTokenMock).toHaveBeenCalledWith('good-token');
  });
});

describe('AuthService.signUp', () => {
  let userRepo: UserRepository;
  let service: AuthService;

  beforeEach(() => {
    userRepo = makeUserRepoStub();
    service = new AuthService(userRepo, makeTokenRepoStub());
    vi.mocked(userRepo.findByEmail).mockResolvedValue(undefined);
  });

  it('throws when required fields are missing', async () => {
    await expect(service.signUp('', 'name', 'pw')).rejects.toThrow('required');
    await expect(service.signUp('a@b.com', '', 'pw')).rejects.toThrow('required');
    await expect(service.signUp('a@b.com', 'name', '')).rejects.toThrow('required');
  });

  it('throws when email is already registered', async () => {
    vi.mocked(userRepo.findByEmail).mockResolvedValue(makeUser());
    await expect(service.signUp('test@example.com', 'name', 'pw')).rejects.toThrow('already registered');
  });

  it('normalizes email to lowercase and trims whitespace before lookup', async () => {
    await service.signUp('  User@Example.COM  ', 'name', 'password');
    expect(userRepo.findByEmail).toHaveBeenCalledWith('user@example.com');
  });

  it('stores a hashed password, not the plaintext', async () => {
    await service.signUp('new@example.com', 'name', 'mypassword');
    const createCall = vi.mocked(userRepo.create).mock.calls[0][0];
    expect(createCall.password).not.toBe('mypassword');
    expect(createCall.password).toMatch(/^scrypt\$/);
  });
});

describe('AuthService.forgetPassword', () => {
  let userRepo: UserRepository;
  let tokenRepo: ResetPasswordTokenRepository;
  let service: AuthService;

  beforeEach(() => {
    enqueueSendEmailMock.mockClear();
    enqueueSendEmailMock.mockResolvedValue({ messageId: 'msg-1' });
    userRepo = makeUserRepoStub();
    tokenRepo = makeTokenRepoStub();
    service = new AuthService(userRepo, tokenRepo);
  });

  it('does not store a token or enqueue an email for unknown emails', async () => {
    vi.mocked(userRepo.findByEmail).mockResolvedValue(undefined);
    const result = await service.forgetPassword(
      'nobody@example.com',
      'https://app.example.com',
    );
    expect(result).toBeUndefined();
    expect(tokenRepo.create).not.toHaveBeenCalled();
    expect(enqueueSendEmailMock).not.toHaveBeenCalled();
  });

  it('returns void without writes for an empty email', async () => {
    await service.forgetPassword('   ', 'https://app.example.com');
    expect(userRepo.findByEmail).not.toHaveBeenCalled();
    expect(enqueueSendEmailMock).not.toHaveBeenCalled();
  });

  it('stores a token and enqueues a send-email message (with the request-origin appUrl) for a known user', async () => {
    vi.mocked(userRepo.findByEmail).mockResolvedValue(makeUser({ id: 'user-1' }));
    await service.forgetPassword(
      '  Test@Example.com  ',
      'https://preview-123.vercel.app',
    );

    const createCall = vi.mocked(tokenRepo.create).mock.calls[0][0];
    expect(createCall.user_id).toBe('user-1');
    expect(typeof createCall.token).toBe('string');
    expect((createCall.token as string).length).toBeGreaterThan(20);
    expect(new Date(createCall.valid_until as string).getTime()).toBeGreaterThan(Date.now());

    expect(enqueueSendEmailMock).toHaveBeenCalledTimes(1);
    const payload = enqueueSendEmailMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      kind: 'forgot_password',
      to: 'test@example.com',
      token: createCall.token,
      appUrl: 'https://preview-123.vercel.app',
    });
    expect(payload.ttlMinutes).toBeGreaterThan(0);
  });

  it('swallows enqueue failures so the response stays anti-enumeration', async () => {
    vi.mocked(userRepo.findByEmail).mockResolvedValue(makeUser({ id: 'user-1' }));
    enqueueSendEmailMock.mockRejectedValueOnce(new Error('queue down'));

    // Should not throw to the caller — the API contract is "always ok".
    await expect(
      service.forgetPassword('test@example.com', 'https://app.example.com'),
    ).resolves.toBeUndefined();
    // Token still persisted; user can retry.
    expect(tokenRepo.create).toHaveBeenCalled();
  });
});

describe('AuthService.resetPassword', () => {
  let userRepo: UserRepository;
  let tokenRepo: ResetPasswordTokenRepository;
  let service: AuthService;

  beforeEach(() => {
    userRepo = makeUserRepoStub();
    tokenRepo = makeTokenRepoStub();
    service = new AuthService(userRepo, tokenRepo);
  });

  it('throws when key or password is empty', async () => {
    await expect(service.resetPassword('', 'pw')).rejects.toThrow('required');
    await expect(service.resetPassword('key', '')).rejects.toThrow('required');
  });

  it('throws for an invalid or expired token', async () => {
    vi.mocked(tokenRepo.findValidByToken).mockResolvedValue(undefined);
    await expect(service.resetPassword('bad-token', 'newpw')).rejects.toThrow('Invalid or expired');
  });

  it('updates the password and deletes the token on success', async () => {
    const tokenRow = {
      id: 'tok-1',
      token: 'valid-token',
      user_id: 'user-1',
      valid_until: new Date(Date.now() + 60_000).toISOString(),
      created_at: new Date().toISOString(),
    } as ResetToken;
    vi.mocked(tokenRepo.findValidByToken).mockResolvedValue(tokenRow);

    await service.resetPassword('valid-token', 'newpassword');

    expect(userRepo.update).toHaveBeenCalledWith('user-1', expect.objectContaining({ password: expect.stringMatching(/^scrypt\$/) }));
    expect(tokenRepo.deleteByToken).toHaveBeenCalledWith('valid-token');
  });
});
