import { resolveWorkspaceFeatureFlags } from './overrides';

export const FUND_VEHICLES_FEATURE_KEY = 'FUND_VEHICLE_VIEW_ENABLED';

/**
 * Whether this workspace manages fund vehicles.
 *
 * The flag is primarily a view flag (it gates the Fund portfolio tab and
 * fund-type grouping), but it also decides where an ingested fund-of-funds
 * holding is persisted:
 *
 * - **on** — a FoF holding becomes an `fl_funds` row (`managed: false`) and the
 *   position targets that fund, so the holding can be opened as a vehicle.
 * - **off** — the workspace has no fund vehicles to open, so the same holding
 *   becomes an `fl_assets` row and the position targets the asset. Ledger
 *   semantics still follow `assetType`, so its entries stay
 *   `paid_in`/`distribution`/`redemption` rather than `buy`/`sell`.
 *
 * Managed funds are unaffected: an investor's commitment to a managed vehicle
 * (the Nanjing fund ledger model) has no asset counterpart, so those rows are
 * still created regardless of the flag.
 *
 * Resolution is workspace-explicit rather than request-scoped so ingestion can
 * resolve it from a background job.
 */
export async function resolveFundVehiclesEnabled(workspaceId: string): Promise<boolean> {
  const flags = await resolveWorkspaceFeatureFlags(workspaceId, { strict: true });
  return flags[FUND_VEHICLES_FEATURE_KEY] !== false;
}

/** Where an ingested holding's target row lives. */
export type FundUpdateTargetKind = 'fund' | 'asset';

/**
 * The table a proposed holding's target belongs in. Only a fund-of-funds
 * holding targets a fund when vehicles are enabled or the target is managed.
 */
export function resolveTargetKind(
  assetType: string | null | undefined,
  fundVehiclesEnabled: boolean,
  isManagedFund = false,
): FundUpdateTargetKind {
  return assetType === 'fund_of_funds' && (fundVehiclesEnabled || isManagedFund) ? 'fund' : 'asset';
}
