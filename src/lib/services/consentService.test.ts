import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConsentService, CURRENT_POLICY_VERSION } from './consentService';

function makeDeps() {
  const consentRepo = { findByUserId: vi.fn(), upsertConsent: vi.fn() };
  const userRepo = { findById: vi.fn() };
  const emailService = { sendConsentRecordedEmail: vi.fn() };
  return { consentRepo, userRepo, emailService };
}

const ROW = {
  id: 'c1',
  user_id: 'u1',
  policy_version: CURRENT_POLICY_VERSION,
  consented_at: '2026-08-27T10:00:00.000Z',
  created_at: '2026-08-27T10:00:00.000Z',
};

describe('ConsentService.hasConsented', () => {
  let deps: ReturnType<typeof makeDeps>;
  let service: ConsentService;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeDeps();
    service = new ConsentService(deps.consentRepo as never, deps.userRepo as never, deps.emailService as never);
  });

  it('returns true when a consent row exists', async () => {
    deps.consentRepo.findByUserId.mockResolvedValue(ROW);
    await expect(service.hasConsented('u1')).resolves.toBe(true);
  });

  it('returns false when no consent row exists', async () => {
    deps.consentRepo.findByUserId.mockResolvedValue(null);
    await expect(service.hasConsented('u2')).resolves.toBe(false);
  });
});

describe('ConsentService.recordConsent', () => {
  let deps: ReturnType<typeof makeDeps>;
  let service: ConsentService;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeDeps();
    deps.consentRepo.upsertConsent.mockResolvedValue(ROW);
    deps.userRepo.findById.mockResolvedValue({ id: 'u1', name: 'Jane Doe', email: 'jane@sqe.co.id' });
    service = new ConsentService(deps.consentRepo as never, deps.userRepo as never, deps.emailService as never);
  });

  it('upserts consent at the current policy version', async () => {
    const result = await service.recordConsent('u1');

    expect(deps.consentRepo.upsertConsent).toHaveBeenCalledWith('u1', CURRENT_POLICY_VERSION);
    expect(result).toEqual(ROW);
  });

  it('emails nico.alimin@smma.id with the consenting user details', async () => {
    await service.recordConsent('u1');

    expect(deps.emailService.sendConsentRecordedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'nico.alimin@smma.id',
        userName: 'Jane Doe',
        userEmail: 'jane@sqe.co.id',
        policyVersion: CURRENT_POLICY_VERSION,
      }),
    );
  });

  it('falls back to placeholder user details when the user lookup misses', async () => {
    deps.userRepo.findById.mockResolvedValue(null);

    await service.recordConsent('u1');

    expect(deps.emailService.sendConsentRecordedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ userName: 'Unknown user', userEmail: 'unknown' }),
    );
  });

  it('still returns the recorded consent row when the notification email fails', async () => {
    deps.emailService.sendConsentRecordedEmail.mockRejectedValue(new Error('SES is down'));

    const result = await service.recordConsent('u1');

    expect(result).toEqual(ROW);
  });

  it('still returns the recorded consent row when the user lookup throws', async () => {
    deps.userRepo.findById.mockRejectedValue(new Error('db down'));

    const result = await service.recordConsent('u1');

    expect(result).toEqual(ROW);
  });
});
