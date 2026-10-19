import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { InvalidEntryShapeError } from '@/lib/services';

const {
  authMock,
  findByEmailMock,
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  getEventByIdMock,
  getEntriesByEventIdMock,
  getAllocationsByEntryIdsMock,
  updateEventMock,
  reverseEventMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  findByEmailMock: vi.fn(),
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  getEventByIdMock: vi.fn(),
  getEntriesByEventIdMock: vi.fn(),
  getAllocationsByEntryIdsMock: vi.fn(),
  updateEventMock: vi.fn(),
  reverseEventMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/repositories/userRepository', () => ({
  UserRepository: class {
    findByEmail = findByEmailMock;
  },
}));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { GET, PATCH, DELETE } from './route';

describe('GET, PATCH, DELETE /api/fund-ledger/events/[id]', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { email: 'user@example.com' } });
    findByEmailMock.mockReset().mockResolvedValue({ id: 'user-db-id', email: 'user@example.com' });
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    getEventByIdMock.mockReset();
    getEntriesByEventIdMock.mockReset();
    getAllocationsByEntryIdsMock.mockReset().mockResolvedValue([]);
    updateEventMock.mockReset();
    reverseEventMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flLedgerService: {
        getEventById: getEventByIdMock,
        getEntriesByEventId: getEntriesByEventIdMock,
        getAllocationsByEntryIds: getAllocationsByEntryIdsMock,
        updateEvent: updateEventMock,
        reverseEvent: reverseEventMock,
      },
    });
  });

  describe('GET', () => {
    it('returns event and entries when found', async () => {
      const event = { id: 'be-1', description: 'Capital call' };
      const entries = [{ id: 'le-1', position_id: 'pos-1' }];
      getEventByIdMock.mockResolvedValueOnce(event);
      getEntriesByEventIdMock.mockResolvedValueOnce(entries);

      const req = new NextRequest('http://localhost/api/fund-ledger/events/be-1');
      const res = await GET(req, { params: Promise.resolve({ id: 'be-1' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: { event, entries, allocations: [] } });
      expect(getEventByIdMock).toHaveBeenCalledWith('ws-1', 'be-1');
      expect(getEntriesByEventIdMock).toHaveBeenCalledWith('ws-1', 'be-1');
      expect(getAllocationsByEntryIdsMock).toHaveBeenCalledWith('ws-1', ['le-1']);
    });

    it('returns 404 when event not found', async () => {
      getEventByIdMock.mockResolvedValueOnce(undefined);

      const req = new NextRequest('http://localhost/api/fund-ledger/events/be-999');
      const res = await GET(req, { params: Promise.resolve({ id: 'be-999' }) });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH', () => {
    it('atomically edits event in place, forwarding string deltas unchanged and omitting caller IDs', async () => {
      const updateResult = {
        event: { id: 'be-1' },
        entries: [],
        allocations: [],
      };
      updateEventMock.mockResolvedValueOnce(updateResult);

      const req = new NextRequest('http://localhost/api/fund-ledger/events/be-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'untrusted-id',
          event_date: '2026-08-23',
          description: 'Corrected Event',
          entries: [
            {
              id: 'untrusted-entry-id',
              position_id: 'pos-1',
              entry_type: 'paid_in',
              commitment_delta: '0',
              quantity_delta: '100',
              cash_delta: '-100000',
              currency: 'USD',
            },
          ],
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: 'be-1' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: updateResult });

      expect(updateEventMock).toHaveBeenCalledWith(
        'ws-1',
        'be-1',
        {
          event_date: '2026-08-23',
          description: 'Corrected Event',
          source_record_id: null,
          entries: [
            {
              position_id: 'pos-1',
              entry_type: 'paid_in',
              sub_type: null,
              commitment_delta: '0',
              quantity_delta: '100',
              cash_delta: '-100000',
              currency: 'USD',
              fx_rate: null,
              price_per_unit: null,
              counterparty_position_id: null,
              data_status: 'verified',
              source_record_id: null,
              primary_entry_index: undefined,
              source_entry_index: undefined,
              notes: null,
              allocations: undefined,
            },
          ],
        },
        {
          updated_by: 'user-db-id',
        },
      );
      // Verify internal IDs were omitted
      expect(updateEventMock.mock.calls[0][2]).not.toHaveProperty('id');
      expect(updateEventMock.mock.calls[0][2].entries[0]).not.toHaveProperty('id');
    });

    it("forwards an edited adjustment's valuation delta", async () => {
      updateEventMock.mockResolvedValueOnce({ event: { id: 'be-1' }, entries: [], allocations: [] });

      const req = new NextRequest('http://localhost/api/fund-ledger/events/be-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event_date: '2026-09-11',
          entries: [
            {
              position_id: 'pos-1',
              entry_type: 'adjustment',
              sub_type: 'paid_in_writeoff',
              commitment_delta: '0',
              quantity_delta: '0',
              valuation_delta: '-914781.37',
              cash_delta: '0',
              currency: 'CNY',
            },
          ],
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: 'be-1' }) });
      expect(res.status).toBe(200);
      // Omitting it meant the editor's "Paid-in adjustment Δ" was accepted and
      // then saved back as zero.
      expect(updateEventMock.mock.calls[0][2].entries[0]).toMatchObject({
        valuation_delta: '-914781.37',
      });
    });

    it('proves supplied id, business_event_id, is_reversal, created_by, and workspace_id cannot reach the service at all levels', async () => {
      updateEventMock.mockResolvedValueOnce({
        event: { id: 'be-1' },
        entries: [],
        allocations: [],
      });

      const maliciousPayload = {
        id: 'attacker-event-id',
        business_event_id: 'attacker-be-id',
        workspace_id: 'attacker-ws-id',
        is_reversal: true,
        created_by: 'attacker-user',
        event_date: '2026-08-23',
        description: 'Replacement Event',
        entries: [
          {
            id: 'attacker-entry-id',
            business_event_id: 'attacker-entry-be-id',
            workspace_id: 'attacker-entry-ws-id',
            is_reversal: true,
            created_by: 'attacker-entry-user',
            position_id: 'pos-1',
            entry_type: 'paid_in',
            commitment_delta: '0',
            quantity_delta: '100',
            cash_delta: '-100000',
            currency: 'USD',
            allocations: [
              {
                id: 'attacker-alloc-id',
                ledger_entry_id: 'attacker-le-id',
                workspace_id: 'attacker-alloc-ws-id',
                created_by: 'attacker-alloc-user',
                funding_source_id: 'fs-1',
                amount: '100000',
              },
            ],
          },
        ],
      };

      const req = new NextRequest('http://localhost/api/fund-ledger/events/be-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(maliciousPayload),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: 'be-1' }) });
      expect(res.status).toBe(200);

      const passedInput = updateEventMock.mock.calls[0][2];

      // Top level: replacement event
      expect(passedInput).not.toHaveProperty('id');
      expect(passedInput).not.toHaveProperty('business_event_id');
      expect(passedInput).not.toHaveProperty('workspace_id');
      expect(passedInput).not.toHaveProperty('is_reversal');
      expect(passedInput).not.toHaveProperty('created_by');

      // Entry level
      const passedEntry = passedInput.entries[0];
      expect(passedEntry).not.toHaveProperty('id');
      expect(passedEntry).not.toHaveProperty('business_event_id');
      expect(passedEntry).not.toHaveProperty('workspace_id');
      expect(passedEntry).not.toHaveProperty('is_reversal');
      expect(passedEntry).not.toHaveProperty('created_by');

      // Allocation level
      const passedAlloc = passedEntry.allocations[0];
      expect(passedAlloc).not.toHaveProperty('id');
      expect(passedAlloc).not.toHaveProperty('ledger_entry_id');
      expect(passedAlloc).not.toHaveProperty('workspace_id');
      expect(passedAlloc).not.toHaveProperty('created_by');
      expect(passedAlloc).toEqual({
        funding_source_id: 'fs-1',
        amount: '100000',
      });
    });

    it('forwards numeric money without string coercion, triggering 422 InvalidEntryShapeError', async () => {
      updateEventMock.mockImplementationOnce((_wsId, _id, input) => {
        if (typeof input.entries[0]?.cash_delta !== 'string') {
          throw new InvalidEntryShapeError(
            `cash_delta must be a string, received ${typeof input.entries[0]?.cash_delta}`,
          );
        }
        return Promise.resolve({});
      });

      const req = new NextRequest('http://localhost/api/fund-ledger/events/be-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event_date: '2026-08-23',
          description: 'Corrected Event',
          entries: [
            {
              position_id: 'pos-1',
              entry_type: 'paid_in',
              commitment_delta: 0,
              quantity_delta: 100,
              cash_delta: -100000, // Number instead of string
              currency: 'USD',
            },
          ],
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: 'be-1' }) });
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error_name).toBe('InvalidEntryShapeError');
      expect(updateEventMock.mock.calls[0][2].entries[0].cash_delta).toBe(-100000);
    });

    it('returns 422 with error_name on AllocationSourceMismatchError', async () => {
      const err = new Error('Explicit allocation source does not match position source');
      err.name = 'AllocationSourceMismatchError';
      updateEventMock.mockRejectedValueOnce(err);

      const req = new NextRequest('http://localhost/api/fund-ledger/events/be-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event_date: '2026-08-23',
          description: 'Corrected Event',
          entries: [
            {
              position_id: 'pos-1',
              entry_type: 'paid_in',
              commitment_delta: '0',
              quantity_delta: '100',
              cash_delta: '-100000',
              currency: 'USD',
            },
          ],
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: 'be-1' }) });
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Explicit allocation source does not match position source');
      expect(json.error_name).toBe('AllocationSourceMismatchError');
    });

    it('maps transient pairing field (primary_entry_index/source_entry_index) while stripping caller id and source_ledger_entry_id', async () => {
      updateEventMock.mockResolvedValueOnce({
        event: { id: 'be-1' },
        entries: [],
        allocations: [],
      });

      const req = new NextRequest('http://localhost/api/fund-ledger/events/be-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event_date: '2026-09-03',
          entries: [
            {
              id: 'caller-entry-0',
              position_id: 'pos-fund-1',
              entry_type: 'paid_in',
              cash_delta: '-5000',
              currency: 'USD',
            },
            {
              id: 'caller-entry-1',
              source_ledger_entry_id: 'caller-fake-source-id',
              position_id: 'pos-cash-1',
              entry_type: 'cash_movement',
              cash_delta: '5000',
              currency: 'USD',
              primary_entry_index: 0,
            },
          ],
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: 'be-1' }) });
      expect(res.status).toBe(200);

      const passedInput = updateEventMock.mock.calls[0][2];
      expect(passedInput.entries[0]).not.toHaveProperty('id');
      expect(passedInput.entries[1]).not.toHaveProperty('id');
      expect(passedInput.entries[1]).not.toHaveProperty('source_ledger_entry_id');
      expect(passedInput.entries[1].primary_entry_index).toBe(0);
    });

    it('receives the resolved updated_by in its options argument', async () => {
      const updateResult = {
        event: { id: 'be-1' },
        entries: [],
        allocations: [],
      };
      updateEventMock.mockResolvedValueOnce(updateResult);

      const req = new NextRequest('http://localhost/api/fund-ledger/events/be-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-1',
              entry_type: 'paid_in',
              cash_delta: '-1000',
              currency: 'USD',
            },
          ],
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: 'be-1' }) });
      expect(res.status).toBe(200);
      expect(updateEventMock).toHaveBeenCalledWith(
        'ws-1',
        'be-1',
        expect.any(Object),
        { updated_by: 'user-db-id' },
      );
    });

    it('succeeds with updated_by: null when session has no matching DB user', async () => {
      findByEmailMock.mockResolvedValueOnce(null);
      const updateResult = {
        event: { id: 'be-1' },
        entries: [],
        allocations: [],
      };
      updateEventMock.mockResolvedValueOnce(updateResult);

      const req = new NextRequest('http://localhost/api/fund-ledger/events/be-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-1',
              entry_type: 'paid_in',
              cash_delta: '-1000',
              currency: 'USD',
            },
          ],
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: 'be-1' }) });
      expect(res.status).toBe(200);
      expect(updateEventMock).toHaveBeenCalledWith(
        'ws-1',
        'be-1',
        expect.any(Object),
        { updated_by: null },
      );
    });

    it('succeeds with updated_by: null when there is no active session', async () => {
      authMock.mockResolvedValueOnce(null);
      const updateResult = {
        event: { id: 'be-1' },
        entries: [],
        allocations: [],
      };
      updateEventMock.mockResolvedValueOnce(updateResult);

      const req = new NextRequest('http://localhost/api/fund-ledger/events/be-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-1',
              entry_type: 'paid_in',
              cash_delta: '-1000',
              currency: 'USD',
            },
          ],
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: 'be-1' }) });
      expect(res.status).toBe(200);
      expect(updateEventMock).toHaveBeenCalledWith(
        'ws-1',
        'be-1',
        expect.any(Object),
        { updated_by: null },
      );
    });
  });

  describe('DELETE', () => {
    it('deletes event via DELETE', async () => {
      const deleteResult = {
        event: { id: 'be-1', status: 'posted' },
        entries: [],
        allocations: [],
      };
      reverseEventMock.mockResolvedValueOnce(deleteResult);

      const req = new NextRequest('http://localhost/api/fund-ledger/events/be-1', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          description: 'Voiding duplicate transaction',
        }),
      });

      const res = await DELETE(req, { params: Promise.resolve({ id: 'be-1' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: deleteResult });
      expect(reverseEventMock).toHaveBeenCalledWith('ws-1', 'be-1', {
        description: 'Voiding duplicate transaction',
        event_date: undefined,
      });
    });
  });
});
