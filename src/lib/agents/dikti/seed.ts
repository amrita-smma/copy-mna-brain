/**
 * @dikti seed configuration (MB-541), lifted verbatim from PRD §4.1
 * ("@dikti — Education Agent"), which takes it from the Sector-Specific
 * Benchmarking BRD. The observed-signal types come from US-04 (MB-543).
 * Nothing here is invented at build time — change it only from a sourced
 * BRD/PRD revision, and bump the agent version in sector/registry.ts when you
 * do.
 */
import type { SectorSeedBase } from '@/lib/agents/sector/types';

export interface WorkedCase {
  name: string;
  /** The control history, in order. */
  timeline: string[];
  corroboration: string;
  notes: string[];
}

export interface DiktiSeed extends SectorSeedBase {
  key: 'dikti';
  /** How yayasan control works and changes hands. */
  mechanismModel: string[];
  /**
   * The only signals that count as observed (US-04 AC2). Anything else is an
   * inference and must name the observed signals it was built from.
   */
  observedSignalTypes: string[];
  workedCase: WorkedCase;
}

export const DIKTI_SEED: DiktiSeed = {
  key: 'dikti',
  answers: 'Who is quietly buying Indonesian campuses, and what did they effectively pay?',
  mechanismModel: [
    'Yayasan control sits with the Pembina (UU 16/2001 as amended by UU 28/2004) — control changes by changing its composition, not by transferring anything.',
    'Permendikbud 7/2020 Art. 17 enumerates the reportable events: transfer of management to a new Badan Penyelenggara, penggabungan, penyatuan, change of form, name, location.',
    'Approved by decree from Kemdiktisaintek, numbered E/O by year.',
  ],
  // The seven signal sources.
  sources: [
    {
      name: 'PDDikti',
      detail: 'diffing the badan penyelenggara field across a watchlist',
      limitId: 'pddikti-api',
    },
    {
      name: 'LLDIKTI announcement pages and the SILAT service lines',
      detail: 'Alih Kelola, Perubahan Badan Penyelenggara, Penggabungan, Penyatuan',
    },
    { name: 'The decree series' },
    { name: 'AHU yayasan filings', limitId: 'ahu-yayasan-coverage' },
    {
      name: 'The statutory newspaper announcement',
      detail: 'required within 30 days of a penggabungan',
    },
    { name: 'BAN-PT and LAM', detail: 'including historical accreditation' },
    {
      name: 'Disclosed business relationships',
      detail: "overlapping directors, shared addresses, a foreign operator's own school list",
    },
  ],
  metricLayers: [
    {
      id: 'operating',
      name: 'Metric set',
      metrics: [
        'Enrolment headcount and intake YoY',
        'tuition per student per year',
        'student-to-lecturer ratio',
        'campus utilisation against designed capacity',
        'applicant-to-enrolled yield',
        'retention',
        'dropout',
        'revenue per student',
        'EBITDA margin',
        'capex per seat',
        'accreditation grade and trajectory',
      ],
    },
  ],
  cohort: {
    members: [
      'PHINMA Corporation (PSE: PHN)',
      'PHINMA Education',
      'SISB PCL (SET: SISB)',
    ],
    extension: 'Philippine listed education names as the extension set.',
    note: 'No IDX-listed pure-play education issuer could be verified — the cohort is regional plus internal holdings by necessity.',
  },
  workedCase: {
    name: 'Kalbis',
    timeline: [
      'STIE Kalbe (1992)',
      'ITB Kalbe with BINUS (2009)',
      'BINUS exits (2020)',
      'university via Kepmendikbudristek 18/E/O/2024',
      'control to Yayasan Triputra Persada Horizon Education (2025) — a Triputra Group / Persada Capital vehicle with PHINMA Education',
    ],
    corroboration:
      "Corroborated by PHINMA's own school list and the Feb 2019 JV (IDR 74.45bn into PT Ind Phil Managemen, PHINMA 66% and Tripersada Global Manajemen 34%).",
    notes: [
      'No price disclosed.',
      'Kalbe Farma had no disclosure obligation because the asset sat in a foundation.',
    ],
  },
  observedSignalTypes: [
    'a ministerial decree',
    'a PDDikti badan penyelenggara field change',
    'a statutory newspaper announcement',
    'an AHU filing',
  ],
  dataLimits: [
    {
      id: 'pddikti-api',
      topic: 'PDDikti API access',
      statement: 'The PDDikti API returns 401 — credentials or a rendered scrape required.',
    },
    {
      id: 'ahu-yayasan-coverage',
      topic: 'Pembina and Pengurus identity (AHU yayasan coverage)',
      statement:
        'AHU yayasan coverage is thinner than for PT, and Pembina and Pengurus names normally need a notarial extract.',
    },
    {
      id: 'observed-vs-inferred',
      topic: 'Observed signals versus inferred conclusions',
      statement:
        'Every output must separate observed signals (decree, PDDikti field change, newspaper announcement) from inferred conclusions, and must never present an inference as a disclosed transaction.',
    },
  ],
  refreshScope:
    'Diffs the badan penyelenggara field across the watchlist in PDDikti, scans LLDIKTI announcements and the decree series for alih kelola, penggabungan and penyatuan events, checks accreditation trajectories, and raises candidates with an observed-vs-inferred split',
};
