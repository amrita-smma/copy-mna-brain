import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InterventionRecipientService } from './interventionRecipientService';

const { findInsightById, findRoutineById, findMembership } = vi.hoisted(() => ({
  findInsightById: vi.fn(),
  findRoutineById: vi.fn(),
  findMembership: vi.fn(),
}));

class MockInsightRepository {
  findById = findInsightById;
}
class MockRoutinesRepository {
  findById = findRoutineById;
}
class MockUserWorkspaceRepository {
  findOne = findMembership;
}

const WS = 'ws-1';

function makeService() {
  return new InterventionRecipientService(
    new MockInsightRepository() as never,
    new MockRoutinesRepository() as never,
    new MockUserWorkspaceRepository() as never,
  );
}

function membersOf(...userIds: string[]) {
  findMembership.mockImplementation(async (userId: string, workspaceId: string) =>
    workspaceId === WS && userIds.includes(userId) ? { user_id: userId } : undefined,
  );
}

const refreshRun = {
  workspace_id: WS,
  triggered_by_user_id: null,
  origin_routine_id: 'rt-1',
};

describe('InterventionRecipientService.resolveRecipient', () => {
  beforeEach(() => {
    findInsightById.mockReset();
    findRoutineById.mockReset();
    findMembership.mockReset();
    findRoutineById.mockResolvedValue({ id: 'rt-1', created_by: 'routine-creator' });
  });

  it('asks the insight owner on a refresh run', async () => {
    findInsightById.mockResolvedValue({ id: 'ins-1', created_by: 'owner' });
    membersOf('owner', 'routine-creator');

    await expect(makeService().resolveRecipient(refreshRun, 'ins-1')).resolves.toBe('owner');
    expect(findInsightById).toHaveBeenCalledWith('ins-1', WS);
    expect(findRoutineById).not.toHaveBeenCalled();
  });

  it.each([
    ['the insight has no owner', null],
    ['the owner left the workspace', 'former-owner'],
  ])('falls back to the routine creator when %s', async (_label, owner) => {
    findInsightById.mockResolvedValue({ id: 'ins-1', created_by: owner });
    membersOf('routine-creator');

    await expect(makeService().resolveRecipient(refreshRun, 'ins-1')).resolves.toBe('routine-creator');
  });

  it('falls back to the triggerer (a manual force-run) when neither owner nor routine creator is a member', async () => {
    findInsightById.mockResolvedValue({ id: 'ins-1', created_by: 'former-owner' });
    membersOf();

    await expect(
      makeService().resolveRecipient({ ...refreshRun, triggered_by_user_id: 'clicker' }, 'ins-1'),
    ).resolves.toBe('clicker');
  });

  it('returns null when nobody on a scheduled refresh can be resolved', async () => {
    findInsightById.mockResolvedValue(undefined);
    findRoutineById.mockResolvedValue(null);
    membersOf();

    await expect(makeService().resolveRecipient(refreshRun, 'ins-1')).resolves.toBeNull();
  });

  it('asks the triggering user on a non-refresh run', async () => {
    await expect(
      makeService().resolveRecipient(
        { workspace_id: WS, triggered_by_user_id: 'requester', origin_routine_id: null },
        null,
      ),
    ).resolves.toBe('requester');
    expect(findInsightById).not.toHaveBeenCalled();
    expect(findMembership).not.toHaveBeenCalled();
  });

  it('asks the routine creator on a non-refresh cron run, which has no triggerer', async () => {
    await expect(
      makeService().resolveRecipient(
        { workspace_id: WS, triggered_by_user_id: null, origin_routine_id: 'rt-1' },
        null,
      ),
    ).resolves.toBe('routine-creator');
  });
});
