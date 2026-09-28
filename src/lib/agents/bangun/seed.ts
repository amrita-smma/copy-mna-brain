/**
 * @bangun seed configuration (MB-541), lifted verbatim from PRD §4.1
 * ("@bangun — Construction and Property Development Agent"), which takes it
 * from the Sector-Specific Benchmarking BRD and the benchmarks prototype.
 * Nothing here is invented at build time — change it only from a sourced
 * BRD/PRD revision, and bump the agent version in sector/registry.ts when you
 * do.
 */
import type { SectorSeedBase } from '@/lib/agents/sector/types';

export interface BenchmarkComponent {
  id: string;
  name: string;
  /** The component's lines or basket items, when the BRD lists them. */
  items?: string[];
}

export interface BangunSeed extends SectorSeedBase {
  key: 'bangun';
  /**
   * Inherited from the benchmarks build alongside the peer metric set (which
   * lives in `metricLayers`): the commercials matrix, capex stack, BoM basket
   * and rates ladder.
   */
  inheritedComponents: BenchmarkComponent[];
}

export const BANGUN_SEED: BangunSeed = {
  key: 'bangun',
  answers:
    'Is this developer building at a normal cost, selling at a normal price, and selling down phases at a normal pace?',
  // @bangun's sources are internal first (PRD §7 sequencing: "its sources are
  // internal"); the BRD names no external source list for it.
  sources: [
    {
      name: 'Internal deal history',
      detail: 'the first source for the phase layer',
      limitId: 'phasing-granularity',
    },
    { name: 'Listed filings', limitId: 'phasing-granularity' },
  ],
  metricLayers: [
    {
      id: 'peer',
      name: 'Peer metric set (inherited from the benchmarks build)',
      metrics: [
        'gross margin on property sales',
        'blended ASP per m2 sold',
        'marketing sales',
        'sell-through in launch year',
        'inventory turn',
        'land bank years',
        'net gearing',
        'EV/EBITDA',
      ],
    },
    {
      id: 'phasing',
      name: 'Phasing layer (new)',
      metrics: [
        'Phase sell-down profile (40/40/20, 60/40, or whatever the scheme actually runs)',
        'Absorption rate per phase',
        'Phase-to-phase price escalation',
        'COGS as a share of recognised revenue, by phase',
        'Average unit size and its drift',
        'BoM pass-through against achieved ASP',
        'Land cost share of ASP',
        'Infrastructure burden carried before first revenue',
      ],
      note: 'Built from internal deal history first; label any phase figure that is modelled rather than observed.',
    },
  ],
  inheritedComponents: [
    { id: 'commercials-matrix', name: 'Commercials matrix by product and location tier' },
    { id: 'capex-stack', name: 'Eight-line capex stack per m2 saleable' },
    {
      id: 'bom-basket',
      name: 'Bill-of-materials basket',
      items: [
        'cement',
        'rebar',
        'ready-mix K-300',
        'lightweight block',
        'ceramic tile',
        'mason and helper day rates',
        'formwork',
      ],
    },
    {
      id: 'rates-ladder',
      name: 'Rates ladder through to a blended cost of capital at a settable debt share',
    },
  ],
  cohort: {
    members: ['PANI', 'BSDE', 'CTRA', 'SMRA', 'PWON', 'ASRI', 'LPKR'],
    extension:
      'extended regionally to Malaysia, Vietnam, the Philippines and Singapore, plus internally held companies',
  },
  dataLimits: [
    {
      id: 'phasing-granularity',
      topic: 'Phase-level data in listed filings',
      statement: 'Phasing data is not in listed filings at the granularity required.',
    },
    {
      id: 'modelled-phase-label',
      topic: 'Modelled versus observed phase figures',
      statement:
        'The phase layer is built from internal deal history first, and the agent must label any phase figure that is modelled rather than observed.',
    },
  ],
  refreshScope:
    'Refreshes the bill-of-materials basket and the rates ladder, recomputes the capex stack and blended cost of capital, and re-runs phase absorption against the latest internal deal history',
};
