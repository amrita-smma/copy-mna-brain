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
