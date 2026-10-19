import * as fundLedgerApi from '@/lib/api/fundLedger';

export interface ToastOptions {
  title: string;
  description: string;
  variant?: 'default' | 'destructive';
}

export type ToastFn = (opts: ToastOptions) => void;

export interface DeleteActionDependencies {
  deleteInvestorApi?: (id: string) => Promise<void>;
  deleteFundingSourceApi?: (id: string) => Promise<void>;
  reloadAll: () => Promise<void>;
  toast: ToastFn;
}

export async function executeDeleteInvestor(
  investorId: string,
  deps: DeleteActionDependencies,
): Promise<void> {
  const { deleteInvestorApi = fundLedgerApi.deleteInvestor, reloadAll, toast } = deps;
  try {
    await deleteInvestorApi(investorId);
    await reloadAll();
  } catch (err) {
    console.error('Failed to delete investor', err);
    toast({
      title: 'Failed to delete investor',
      description: err instanceof Error ? err.message : 'The investor was not deleted.',
      variant: 'destructive',
    });
    throw err;
  }
}

export async function executeDeleteFundingSource(
  sourceId: string,
  deps: DeleteActionDependencies,
): Promise<void> {
  const { deleteFundingSourceApi = fundLedgerApi.deleteFundingSource, reloadAll, toast } = deps;
  try {
    await deleteFundingSourceApi(sourceId);
    await reloadAll();
  } catch (err) {
    console.error('Failed to delete source of fund', err);
    toast({
      title: 'Failed to delete source of fund',
      description: err instanceof Error ? err.message : 'The source was not deleted.',
      variant: 'destructive',
    });
    throw err;
  }
}

export interface DeleteAssetDependencies {
  closePositionsApi?: typeof fundLedgerApi.closePositions;
  reloadAll: () => Promise<void>;
  toast: ToastFn;
}

export async function executeDeleteAsset(
  fund: { id: string },
  holding: {
    id?: string | null;
    n: string;
    tp: string;
    positionId?: string | null;
    positionIds?: string[];
  },
  deps: DeleteAssetDependencies,
): Promise<void> {
  if (!holding.positionId && (!holding.positionIds || holding.positionIds.length === 0)) return;
  const {
    closePositionsApi = fundLedgerApi.closePositions,
    reloadAll,
    toast,
  } = deps;
  try {
    const explicitIds = holding.positionIds?.length
      ? holding.positionIds
      : holding.positionId
        ? [holding.positionId]
        : [];

    await closePositionsApi(explicitIds);
    await reloadAll();
  } catch (err) {
    console.error('Failed to close holding', err);
    toast({
      title: 'Failed to close holding',
      description: err instanceof Error ? err.message : `"${holding.n}" was not closed.`,
      variant: 'destructive',
    });
    throw err;
  }
}

export interface PositionActionDependencies {
  reopenPositionApi?: typeof fundLedgerApi.reopenPosition;
  reloadAll: () => Promise<void>;
  toast: ToastFn;
}

export async function executeReopenHolding(
  fund: { id: string },
  holding: {
    id?: string | null;
    n: string;
    tp?: string;
    positionId?: string | null;
    positionIds?: string[];
  },
  deps: PositionActionDependencies,
): Promise<void> {
  const explicitIds = holding.positionIds?.length
    ? holding.positionIds
    : holding.positionId
      ? [holding.positionId]
      : [];

  if (explicitIds.length === 0) {
    deps.toast({
      title: 'Failed to reopen holding',
      description: 'No position ID found for this holding.',
      variant: 'destructive',
    });
    return;
  }

  if (explicitIds.length > 1) {
    deps.toast({
      title: 'Cannot reopen holding',
      description: 'Reopening multiple linked positions is disabled because no atomic batch-reopen operation exists.',
      variant: 'destructive',
    });
    return;
  }

  const {
    reopenPositionApi = fundLedgerApi.reopenPosition,
    reloadAll,
    toast,
  } = deps;

  try {
    await reopenPositionApi(explicitIds[0]);
    await reloadAll();
    toast({
      title: 'Holding reopened',
      description: `"${holding.n}" was reopened successfully.`,
    });
  } catch (err) {
    console.error('Failed to reopen holding', err);
    toast({
      title: 'Failed to reopen holding',
      description: err instanceof Error ? err.message : `"${holding.n}" was not reopened.`,
      variant: 'destructive',
    });
    throw err;
  }
}

export interface HardDeleteAssetDependencies {
  deleteAssetApi?: typeof fundLedgerApi.deleteAsset;
  reloadAll: () => Promise<void>;
  toast: ToastFn;
}

/**
 * Permanently deletes an asset and every ledger event that touches it. Unlike
 * `executeDeleteAsset` (which only closes positions), nothing is retained.
 */
export async function executeHardDeleteAsset(
  holding: { id?: string | null; n: string },
  deps: HardDeleteAssetDependencies,
): Promise<void> {
  const { deleteAssetApi = fundLedgerApi.deleteAsset, reloadAll, toast } = deps;
  if (!holding.id) return;
  try {
    const result = await deleteAssetApi(holding.id);
    await reloadAll();
    toast({
      title: 'Asset deleted',
      description: `"${holding.n}" was deleted with ${result.entries} ledger ${
        result.entries === 1 ? 'entry' : 'entries'
      } across ${result.positions} ${result.positions === 1 ? 'position' : 'positions'}.`,
    });
  } catch (err) {
    console.error('Failed to delete asset', err);
    toast({
      title: 'Failed to delete asset',
      description: err instanceof Error ? err.message : `"${holding.n}" was not deleted.`,
      variant: 'destructive',
    });
    throw err;
  }
}

export interface ActionItemsDependencies {
  updateAssetApi?: typeof fundLedgerApi.updateAsset;
  reloadAll: () => Promise<void>;
  toast: ToastFn;
}

/** Saves the free-text Action Items on an asset (blank clears them). */
export async function executeUpdateActionItems(
  holding: { id?: string | null; n: string },
  text: string,
  deps: ActionItemsDependencies,
): Promise<void> {
  const { updateAssetApi = fundLedgerApi.updateAsset, reloadAll, toast } = deps;
  if (!holding.id) return;
  try {
    await updateAssetApi(holding.id, { action_items: text.trim() || null });
    await reloadAll();
  } catch (err) {
    console.error('Failed to save action items', err);
    toast({
      title: 'Failed to save action items',
      description: err instanceof Error ? err.message : `Action items for "${holding.n}" were not saved.`,
      variant: 'destructive',
    });
    throw err;
  }
}

export interface InvestmentTypeDependencies {
  setAssetInvestmentTypeApi?: typeof fundLedgerApi.setAssetInvestmentType;
  reloadAll: () => Promise<void>;
  toast: ToastFn;
}

/** Assigns an asset to an investment type (`null` unassigns it). */
export async function executeSetInvestmentType(
  holding: { id?: string | null; n: string },
  investmentTypeId: string | null,
  deps: InvestmentTypeDependencies,
): Promise<void> {
  const {
    setAssetInvestmentTypeApi = fundLedgerApi.setAssetInvestmentType,
    reloadAll,
    toast,
  } = deps;
  if (!holding.id) return;
  try {
    await setAssetInvestmentTypeApi(holding.id, investmentTypeId);
    await reloadAll();
  } catch (err) {
    console.error('Failed to set investment type', err);
    toast({
      title: 'Failed to set investment type',
      description: err instanceof Error ? err.message : `"${holding.n}" was not updated.`,
      variant: 'destructive',
    });
    throw err;
  }
}
