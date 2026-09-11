import { describe, it, expect } from 'vitest';
import {
  EVENT_TYPE_LABELS,
  formatCommitmentCounterparty,
} from './CommitmentHistoryTable';
import type { CommitmentEventType } from '@/lib/api/fundLedger';

describe('Commitment events display logic', () => {
  describe('EVENT_TYPE_LABELS', () => {
    it('provides human-readable labels for all 5 event types', () => {
      const types: CommitmentEventType[] = [
        'initial_commitment',
        'additional_commitment',
        'reduction',
        'transfer_in',
        'transfer_out',
      ];

      for (const t of types) {
        expect(EVENT_TYPE_LABELS[t]).toBeDefined();
        expect(typeof EVENT_TYPE_LABELS[t]).toBe('string');
        expect(EVENT_TYPE_LABELS[t].length).toBeGreaterThan(0);
      }

      expect(EVENT_TYPE_LABELS.initial_commitment).toBe('Initial Commitment');
      expect(EVENT_TYPE_LABELS.additional_commitment).toBe('Additional Commitment');
      expect(EVENT_TYPE_LABELS.reduction).toBe('Reduction');
      expect(EVENT_TYPE_LABELS.transfer_in).toBe('Transfer In');
      expect(EVENT_TYPE_LABELS.transfer_out).toBe('Transfer Out');
    });
  });

  describe('formatCommitmentCounterparty', () => {
    const nameMap = new Map<string, string>([
      ['e1', 'Startech Growth Fund 1'],
      ['e2', 'Meranti Global Investment Ltd'],
    ]);

    it('returns a dash when no counterparty ID is provided', () => {
      expect(formatCommitmentCounterparty('initial_commitment', null, nameMap)).toBe('—');
      expect(formatCommitmentCounterparty('additional_commitment', undefined, nameMap)).toBe('—');
      expect(formatCommitmentCounterparty('transfer_out', '', nameMap)).toBe('—');
    });

    it('formats transfer_out as "To: <Name>"', () => {
      const result = formatCommitmentCounterparty('transfer_out', 'e2', nameMap);
      expect(result).toBe('To: Meranti Global Investment Ltd');
    });

    it('formats transfer_in as "From: <Name>"', () => {
      const result = formatCommitmentCounterparty('transfer_in', 'e1', nameMap);
      expect(result).toBe('From: Startech Growth Fund 1');
    });

    it('falls back to raw ID when entity name is not in Map', () => {
      const result = formatCommitmentCounterparty('transfer_out', 'unknown-id', nameMap);
      expect(result).toBe('To: unknown-id');
    });

    it('works with a plain Record<string, string> map', () => {
      const recordMap: Record<string, string> = {
        e1: 'Startech Growth Fund 1',
      };
      expect(formatCommitmentCounterparty('transfer_out', 'e1', recordMap)).toBe('To: Startech Growth Fund 1');
      expect(formatCommitmentCounterparty('transfer_in', 'e1', recordMap)).toBe('From: Startech Growth Fund 1');
    });
  });
});
