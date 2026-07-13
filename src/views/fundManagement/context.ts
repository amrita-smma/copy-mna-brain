'use client';

import { createContext, useContext } from 'react';
import type { Fund, Holding } from './types';

/**
 * `commitHolding` PATCHes the holding's own scalar asset fields (name,
 * legal/fee/classification fields, etc.) — it must NOT be used for ledger
 * (transaction/valuation) mutations, which go straight to their own
 * endpoints and call `refreshHolding` afterward instead, to avoid
 * double-handling the same edit against two different endpoints.
 * `refreshHolding` re-fetches the asset + its full ledger from the server
 * and swaps it into place, so the UI reflects authoritative
 * server-recomputed rollups rather than a client-side guess.
 */
export interface FundDataCtx {
  commitHolding: (fund: Fund, holding: Holding) => void;
  refreshHolding: (fund: Fund, holding: Holding) => void;
  /** Deletes the fund and every holding/transaction/valuation beneath it
   * (cascades at the DB level). Rejects on failure so the caller can stop
   * a spinner; a toast is already shown by the provider. */
  deleteFund: (fund: Fund) => Promise<void>;
  /** Deletes one holding and its ledger. Same failure contract as `deleteFund`. */
  deleteAsset: (fund: Fund, holding: Holding) => Promise<void>;
  funds: Fund[];
  investorOptions: string[];
  sourceOptions: string[];
  /** Managed holding-entity id → name, so edit forms can render the stored
   * UUID foreign key as its human-readable name (the comboboxes are
   * name-based; the ledger stores ids). */
  entityNameById: Map<string, string>;
  /** Managed funding-source id → name — see `entityNameById`. */
  sourceNameById: Map<string, string>;
}

export const FundDataContext = createContext<FundDataCtx>({
  commitHolding: () => {},
  refreshHolding: () => {},
  deleteFund: () => Promise.resolve(),
  deleteAsset: () => Promise.resolve(),
  funds: [],
  investorOptions: [],
  sourceOptions: [],
  entityNameById: new Map(),
  sourceNameById: new Map(),
});

export const useFundData = () => useContext(FundDataContext);
