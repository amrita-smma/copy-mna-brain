import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AllocationMismatchError,
  EntryPositionKindMismatchError,
  InvalidCurrencyError,
  InvalidEntryShapeError,
  PositionClosedError,
  UnbalancedTransferError,
  WorkspaceMismatchError,
} from '@/lib/services';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  postEventMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  postEventMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services')>();
  return {
    ...actual,
    createContainer: createContainerMock,
  };
});

import { POST } from './route';

function makePostRequest(body: unknown): Request {
  return new Request('http://localhost/api/fund-ledger/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/fund-ledger/events', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    postEventMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flLedgerService: {
        postEvent: postEventMock,
      },
    });
  });

  it('posts event successfully, forwards string money unchanged, and omits internal IDs', async () => {
    const result = {
      event: { id: 'evt-1', event_date: '2026-01-01', status: 'posted' },
      entries: [{ id: 'ent-1', position_id: 'pos-1', cash_delta: '-50000000.00000000' }],
      allocations: [{ id: 'alc-1', funding_source_id: 'fs-1', amount: '50000000.00000000' }],
    };
    postEventMock.mockResolvedValueOnce(result);

    const res = await POST(
      makePostRequest({
        business_event_id: 'caller-supplied-evt-id',
        id: 'caller-supplied-id',
        workspace_id: 'caller-supplied-ws-id',
        created_by: 'caller-supplied-user',
        updated_by: 'caller-supplied-user',
        is_reversal: true,
        event_date: '2026-01-01',
        description: 'Capital call contribution',
        entries: [
          {
            id: 'caller-supplied-entry-id',
            business_event_id: 'caller-supplied-nested-evt-id',
            workspace_id: 'caller-supplied-nested-ws-id',
            created_by: 'caller-supplied-nested-user',
            is_reversal: true,
            position_id: 'pos-1',
            entry_date: '2026-01-01',
            entry_type: 'paid_in',
            commitment_delta: '0.00000000',
            quantity_delta: '0.00000000',
            cash_delta: '-50000000.00000000',
            currency: 'USD',
            allocations: [
              {
                id: 'caller-supplied-alloc-id',
                created_by: 'caller-supplied-alloc-user',
                funding_source_id: 'fs-1',
                amount: '50000000.00000000',
              },
            ],
          },
        ],
        allocations: [
          {
            entry_index: 0,
            funding_source_id: 'fs-1',
            amount: '50000000.00000000',
            created_by: 'caller-supplied-top-alloc-user',
          },
        ],
      }) as never,
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ data: result });
    expect(createDbMock).toHaveBeenCalled();
    expect(createContainerMock).toHaveBeenCalledWith({ sentinel: 'db' }, 'ws-1');

    expect(postEventMock).toHaveBeenCalledWith('ws-1', {
      event_date: '2026-01-01',
      description: 'Capital call contribution',
      source_record_id: null,
      entries: [
        {
          position_id: 'pos-1',
          entry_date: '2026-01-01',
          entry_type: 'paid_in',
          sub_type: null,
          commitment_delta: '0.00000000',
          quantity_delta: '0.00000000',
          cash_delta: '-50000000.00000000',
          currency: 'USD',
          fx_rate: null,
          price_per_unit: null,
          counterparty_position_id: null,
          data_status: undefined,
          source_record_id: null,
          primary_entry_index: undefined,
          source_entry_index: undefined,
          notes: null,
          allocations: [
            {
              funding_source_id: 'fs-1',
              amount: '50000000.00000000',
            },
          ],
        },
      ],
      allocations: [
        {
          entry_index: 0,
          funding_source_id: 'fs-1',
          amount: '50000000.00000000',
        },
      ],
    });

    const passedInput = postEventMock.mock.calls[0][1];
    expect(passedInput).not.toHaveProperty('business_event_id');
    expect(passedInput).not.toHaveProperty('id');
    expect(passedInput).not.toHaveProperty('workspace_id');
    expect(passedInput).not.toHaveProperty('created_by');
    expect(passedInput).not.toHaveProperty('updated_by');
    expect(passedInput).not.toHaveProperty('is_reversal');

    expect(passedInput.entries[0]).not.toHaveProperty('id');
    expect(passedInput.entries[0]).not.toHaveProperty('business_event_id');
    expect(passedInput.entries[0]).not.toHaveProperty('workspace_id');
    expect(passedInput.entries[0]).not.toHaveProperty('created_by');
    expect(passedInput.entries[0]).not.toHaveProperty('is_reversal');

    expect(passedInput.entries[0].allocations[0]).not.toHaveProperty('id');
    expect(passedInput.entries[0].allocations[0]).not.toHaveProperty('created_by');

    expect(passedInput.allocations[0]).not.toHaveProperty('id');
    expect(passedInput.allocations[0]).not.toHaveProperty('created_by');

    expect(typeof passedInput.entries[0].cash_delta).toBe('string');
  });

  it("forwards an adjustment's valuation delta, which carries its whole amount", async () => {
    postEventMock.mockResolvedValueOnce({ event: { id: 'evt-1' }, entries: [], allocations: [] });

    const res = await POST(
      makePostRequest({
        event_date: '2026-09-11',
        description: 'Paid-in write-off',
        entries: [
          {
            position_id: 'pos-1',
            entry_date: '2026-09-11',
            entry_type: 'adjustment',
            sub_type: 'paid_in_writeoff',
            commitment_delta: '0.00000000',
            quantity_delta: '0.00000000',
            valuation_delta: '-914781.37000000',
            cash_delta: '0.00000000',
            currency: 'CNY',
          },
        ],
      }) as never,
    );

    expect(res.status).toBe(200);
    // Dropping this field posted a zero-amount adjustment that passed every
    // other check: the entry shape is valid, it just means nothing.
    expect(postEventMock.mock.calls[0][1].entries[0]).toMatchObject({
      entry_type: 'adjustment',
      sub_type: 'paid_in_writeoff',
      valuation_delta: '-914781.37000000',
    });
  });

  it('forwards numeric money without string coercion, triggering 422 InvalidEntryShapeError', async () => {
    postEventMock.mockImplementationOnce((_wsId, input) => {
      const entry = input.entries[0];
      if (typeof entry.cash_delta !== 'string' && entry.cash_delta !== undefined) {
        throw new InvalidEntryShapeError(
          `cash_delta must be a string, received ${typeof entry.cash_delta}`,
        );
      }
      return Promise.resolve({ event: {}, entries: [], allocations: [] });
    });

    const res = await POST(
      makePostRequest({
        event_date: '2026-01-01',
        entries: [
          {
            position_id: 'pos-1',
            entry_type: 'paid_in',
            cash_delta: -50000000, // Imprecise number in JSON
            currency: 'USD',
          },
        ],
      }) as never,
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe('cash_delta must be a string, received number');
    expect(json.error_name).toBe('InvalidEntryShapeError');
    expect(postEventMock.mock.calls[0][1].entries[0].cash_delta).toBe(-50000000);
  });

  it('returns 422 with error_name on InvalidEntryShapeError', async () => {
    postEventMock.mockRejectedValueOnce(
      new InvalidEntryShapeError('commitment requires commitment_delta <> 0'),
    );

    const res = await POST(
      makePostRequest({
        event_date: '2026-01-01',
        entries: [{ position_id: 'pos-1', entry_type: 'commitment', currency: 'USD' }],
      }) as never,
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain('commitment requires commitment_delta <> 0');
    expect(json.error_name).toBe('InvalidEntryShapeError');
  });

  it('returns 422 with error_name on EntryPositionKindMismatchError', async () => {
    postEventMock.mockRejectedValueOnce(
      new EntryPositionKindMismatchError('Entry type "buy" requires an asset position'),
    );

    const res = await POST(
      makePostRequest({
        event_date: '2026-01-01',
        entries: [{ position_id: 'pos-1', entry_type: 'buy', currency: 'USD' }],
      }) as never,
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain('requires an asset position');
    expect(json.error_name).toBe('EntryPositionKindMismatchError');
  });

  it('returns 422 with error_name on PositionClosedError', async () => {
    postEventMock.mockRejectedValueOnce(
      new PositionClosedError('Position pos-1 is closed'),
    );

    const res = await POST(
      makePostRequest({
        event_date: '2026-01-01',
        entries: [{ position_id: 'pos-1', entry_type: 'paid_in', currency: 'USD' }],
      }) as never,
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain('Position pos-1 is closed');
    expect(json.error_name).toBe('PositionClosedError');
  });

  it('returns 422 with error_name on UnbalancedTransferError', async () => {
    postEventMock.mockRejectedValueOnce(
      new UnbalancedTransferError('Transfer legs do not net to zero'),
    );

    const res = await POST(
      makePostRequest({
        event_date: '2026-01-01',
        entries: [{ position_id: 'pos-1', entry_type: 'commitment_transfer', currency: 'USD' }],
      }) as never,
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain('Transfer legs do not net to zero');
    expect(json.error_name).toBe('UnbalancedTransferError');
  });

  it('returns 422 with error_name on AllocationMismatchError', async () => {
    postEventMock.mockRejectedValueOnce(
      new AllocationMismatchError('Allocation sum does not match |cash_delta|'),
    );

    const res = await POST(
      makePostRequest({
        event_date: '2026-01-01',
        entries: [{ position_id: 'pos-1', entry_type: 'paid_in', currency: 'USD' }],
      }) as never,
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain('Allocation sum does not match |cash_delta|');
    expect(json.error_name).toBe('AllocationMismatchError');
  });

  it('returns 422 with error_name on WorkspaceMismatchError', async () => {
    postEventMock.mockRejectedValueOnce(
      new WorkspaceMismatchError('One or more positions do not exist in workspace'),
    );

    const res = await POST(
      makePostRequest({
        event_date: '2026-01-01',
        entries: [{ position_id: 'pos-foreign', entry_type: 'paid_in', currency: 'USD' }],
      }) as never,
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain('One or more positions do not exist in workspace');
    expect(json.error_name).toBe('WorkspaceMismatchError');
  });

  it('returns 422 with error_name on InvalidCurrencyError', async () => {
    postEventMock.mockRejectedValueOnce(
      new InvalidCurrencyError('Invalid currency: FOO'),
    );

    const res = await POST(
      makePostRequest({
        event_date: '2026-01-01',
        entries: [{ position_id: 'pos-1', entry_type: 'paid_in', currency: 'FOO' }],
      }) as never,
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain('Invalid currency: FOO');
    expect(json.error_name).toBe('InvalidCurrencyError');
  });

  it('returns 422 with error_name on AllocationSourceMismatchError', async () => {
    const err = new Error('Explicit allocation source does not match position source');
    err.name = 'AllocationSourceMismatchError';
    postEventMock.mockRejectedValueOnce(err);

    const res = await POST(
      makePostRequest({
        event_date: '2026-01-01',
        entries: [{ position_id: 'pos-1', entry_type: 'paid_in', currency: 'USD' }],
      }) as never,
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain('Explicit allocation source does not match position source');
    expect(json.error_name).toBe('AllocationSourceMismatchError');
  });

  it('returns 500 on unexpected service throw', async () => {
    postEventMock.mockRejectedValueOnce(new Error('Fatal Postgres connection crash'));

    const res = await POST(
      makePostRequest({
        event_date: '2026-01-01',
        entries: [{ position_id: 'pos-1', entry_type: 'paid_in', currency: 'USD' }],
      }) as never,
    );

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('Fatal Postgres connection crash');
  });

  it('maps transient pairing field (primary_entry_index/source_entry_index) while stripping caller id and source_ledger_entry_id', async () => {
    postEventMock.mockResolvedValueOnce({
      event: { id: 'evt-1' },
      entries: [],
      allocations: [],
    });

    const res = await POST(
      makePostRequest({
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
      }) as never,
    );

    expect(res.status).toBe(200);
    const passedInput = postEventMock.mock.calls[0][1];
    expect(passedInput.entries[0]).not.toHaveProperty('id');
    expect(passedInput.entries[1]).not.toHaveProperty('id');
    expect(passedInput.entries[1]).not.toHaveProperty('source_ledger_entry_id');
    expect(passedInput.entries[1].primary_entry_index).toBe(0);
  });
});
