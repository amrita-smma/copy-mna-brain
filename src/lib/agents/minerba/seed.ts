/**
 * @minerba seed configuration (MB-541), lifted verbatim from PRD §4.1
 * ("@minerba — Mining and Minerals Agent"), which takes it from the
 * Sector-Specific Benchmarking BRD. Nothing here is invented at build time —
 * change it only from a sourced BRD/PRD revision, and bump the agent version
 * in sector/registry.ts when you do.
 */
import type { SectorSeedBase } from '@/lib/agents/sector/types';

export interface RegulatoryWatchItem {
  id: string;
  /** The instrument(s), as the BRD cites them. */
  instrument: string;
  /** What changed, when the BRD says. */
  note?: string;
}

export interface MinerbaSeed extends SectorSeedBase {
  key: 'minerba';
  regulatoryWatchlist: RegulatoryWatchItem[];
  /** The rule the BRD attaches to the known limits. */
  limitsRule: string;
}

export const MINERBA_SEED: MinerbaSeed = {
  key: 'minerba',
  answers:
    'Who holds the licence, the quota and the tonnes behind this asset — and where does its cost position sit against the cohort?',
  sources: [
    { name: 'MODI', limitId: 'restricted-portals' },
    { name: 'MOMS', limitId: 'restricted-portals' },
    { name: 'e-RKAB', limitId: 'restricted-portals' },
    { name: 'SIMBARA' },
    { name: 'EITI Extractive Data Portal' },
    {
      name: 'AHU Kemenkumham',
      detail: 'plus the beneficial-ownership register at bo.ahu.go.id',
    },
    { name: 'IDX filings' },
    {
      name: 'the civil-society trackers',
      detail: 'Auriga / SimonTini, Trend Asia, PWYP Indonesia',
    },
  ],
  metricLayers: [
    {
      id: 'economics',
      name: 'Economics',
      metrics: [
        'Cash cost at gate',
        'realised price',
        'strip ratio',
        'royalty and levies',
        'haul distance',
        'site EBITDA margin',
        'capex per annual tonne',
        'sustaining capex',
        'reserve life',
        'EV/EBITDA',
      ],
    },
    {
      id: 'licence',
      name: 'Licence layer',
      metrics: [
        'concession area and type',
        'tenor remaining',
        'quota utilisation',
        'clean-and-clear and forest-overlap flags',
      ],
    },
    {
      id: 'control',
      name: 'Control layer',
      metrics: ['ownership chain depth', 'related-party offtake share'],
    },
  ],
  regulatoryWatchlist: [
    {
      id: 'uu-2-2025',
      instrument: 'UU 2/2025 and MK decisions 160 and 202/PUU-XXIII/2025',
    },
    { id: 'pp-25-2024', instrument: 'PP 25/2024' },
    { id: 'pp-39-2025', instrument: 'PP 39/2025' },
    {
      id: 'permen-esdm-17-2025',
      instrument: 'Permen ESDM 17/2025',
      note: 'multi-year RKAB rolled back to annual, auto-approval if the ministry misses its five-day window',
    },
    {
      id: 'permen-esdm-6-2026',
      instrument: 'Permen ESDM 6/2026',
      note: 'coal-blending reporting',
    },
    {
      id: 'pp-19-2025',
      instrument: 'PP 19/2025',
      note: 'nickel ore 10% flat to a tiered 14–19% of HMA',
    },
    {
      id: 'may-2026-postponement',
      instrument: 'The May 2026 postponement of the further adjustment',
    },
  ],
  cohort: {
    members: ['ADRO', 'ITMG', 'PTBA', 'INCO', 'MDKA', 'ANTM', 'BUMI', 'HRUM'],
  },
  dataLimits: [
    {
      id: 'rkab-quota',
      topic: 'Company-level approved RKAB quota',
      statement: 'No public per-company approved-quota dataset exists.',
    },
    {
      id: 'iup-beneficial-owner',
      topic: 'IUP-to-beneficial-owner mapping',
      statement: 'No public IUP-to-beneficial-owner mapping.',
    },
    {
      id: 'share-pledge',
      topic: 'Share pledges',
      statement: 'No share-pledge register.',
    },
    {
      id: 'unlisted-deal-price',
      topic: 'Deal prices for unlisted targets',
      statement: 'No deal-price disclosure for unlisted targets.',
    },
    {
      id: 'restricted-portals',
      topic: 'MODI, MOMS, e-RKAB, geoportal and momi.esdm.go.id',
      statement:
        'MODI, MOMS, e-RKAB and geoportal are robots-blocked or login-only, and momi.esdm.go.id does not resolve.',
    },
  ],
  limitsRule: 'The agent must say so rather than fabricate.',
  refreshScope:
    'Re-checks licence expiries and status flags across the concession set, sweeps the regulatory watchlist for changes, re-stamps the royalty basis, and flags any cohort member whose licence or quota position moved',
};
