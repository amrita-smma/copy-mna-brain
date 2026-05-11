import {
  LayoutGrid,
  MessagesSquare,
  Presentation,
  RefreshCw,
  Search,
  Zap,
} from 'lucide-react';

import type {
  DoneTask,
  QueueTask,
  Routine,
  RoutineRun,
  TraceData,
} from './shared';

export const initialQueue: QueueTask[] = [
  { id: 'q1', title: 'Wet processing comps', owner: 'David', initials: 'DK', avatarTone: 'aqua', icon: LayoutGrid },
  { id: 'q2', title: 'Deck — TechSlurry GmbH', owner: 'Maria', initials: 'MR', avatarTone: 'rose', icon: Presentation },
  { id: 'q3', title: 'Korean TIM search', owner: 'James', initials: 'JT', avatarTone: 'slate', icon: Search },
  { id: 'q4', title: 'Refresh Project Oriole', owner: 'You', initials: 'AA', avatarTone: 'indigo', icon: MessagesSquare },
  { id: 'q5', title: 'Deck — NordChem AB', owner: 'Maria', initials: 'MR', avatarTone: 'rose', icon: Presentation },
  { id: 'q6', title: 'EU specialty chemicals comps', owner: 'David', initials: 'DK', avatarTone: 'aqua', icon: LayoutGrid },
  { id: 'q7', title: 'Project Falcon — L1 screening', owner: 'Sarah', initials: 'SC', avatarTone: 'amber', icon: Search },
  { id: 'q8', title: 'Deck — PolymerWorks Ltd', owner: 'James', initials: 'JT', avatarTone: 'slate', icon: Presentation },
  { id: 'q9', title: 'APAC battery materials TIM', owner: 'You', initials: 'AA', avatarTone: 'indigo', icon: MessagesSquare },
  { id: 'q10', title: 'Refresh Project Heron', owner: 'Maria', initials: 'MR', avatarTone: 'rose', icon: MessagesSquare },
  { id: 'q11', title: 'Coatings & adhesives comps', owner: 'David', initials: 'DK', avatarTone: 'aqua', icon: LayoutGrid },
  { id: 'q12', title: 'Deck — Apex Surfactants', owner: 'Sarah', initials: 'SC', avatarTone: 'amber', icon: Presentation },
  { id: 'q13', title: 'Indian fine chemicals search', owner: 'James', initials: 'JT', avatarTone: 'slate', icon: Search },
  { id: 'q14', title: 'Project Cedar — refresh memo', owner: 'You', initials: 'AA', avatarTone: 'indigo', icon: MessagesSquare },
];

export const doneTasks: DoneTask[] = [
  { title: 'Outbound — APAC slurries', owner: 'Sarah', initials: 'SC', avatarTone: 'amber', meta: '2h' },
  { title: 'Deck — Beta Polymers', owner: 'David', initials: 'DK', avatarTone: 'aqua', meta: '4h' },
];

// Newest-first. Initial render = latest 10; scrolling fetches older steps.
export const traceSteps: TraceData[] = [
  {
    id: 's28',
    status: 'intervention-waiting',
    title: 'Borderline candidate flagged for review',
    description: 'SiC Materials Korea passes L0 but is borderline on the L1 financial criterion.',
    timestamp: 'waiting on input…',
    intervention: {
      state: 'waiting',
      question: 'SiC Materials Korea is borderline on L1 — keep going or drop it?',
      proposal: 'My proposal: keep going and mark as borderline.',
    },
  },
  {
    id: 's27',
    status: 'done',
    title: 'Pulled FY2024 financials',
    description: 'HelixChem shows negative EBITDA — fails L0 threshold #2.',
    timestamp: '14:33:01',
    toolCalls: [
      {
        name: 'capiq.financials',
        args: '(FY2024 × 5)',
        status: '4 pass · 1 fail',
        output: {
          label: 'FY2024 EBITDA',
          rows: [
            { key: 'NovaSpec Materials', value: '$28M positive', tone: 'pass' },
            { key: 'HelixChem Industries', value: '-$4M (fails L0 threshold #2)', tone: 'fail' },
            { key: 'Atlas Coatings KK', value: '$41M positive', tone: 'pass' },
            { key: 'SiC Materials Korea', value: '$19M positive', tone: 'pass' },
            { key: 'PureWafer Solutions', value: '$33M positive', tone: 'pass' },
          ],
        },
      },
    ],
  },
  {
    id: 's26',
    status: 'intervention-resolved',
    title: 'Resolved entity ambiguity for HelixChem',
    description: 'Parent-co ambiguity needed clarification before continuing.',
    timestamp: '14:32:38',
    intervention: {
      state: 'resolved',
      question: 'Which HelixChem did you mean?',
      resolution: {
        actor: 'Sarah Chen',
        actorInitials: 'SC',
        avatarTone: 'amber',
        decision: 'approved',
        text: '"Use HelixChem Industries (the standalone entity, CapIQ ID 12091). The parent group is out of scope."',
        timestamp: '14:32:38',
      },
    },
  },
  {
    id: 's25',
    status: 'done',
    title: 'Resolved company identities',
    description: '5/5 matched in CapIQ. Flagged 1 entity with parent-co ambiguity.',
    timestamp: '14:32:24',
    toolCalls: [
      {
        name: 'capiq.search',
        args: '(company_name × 5)',
        status: '5 matches',
        output: {
          label: 'Matched entities',
          rows: [
            { value: 'NovaSpec Materials · CapIQ ID 8842 · high confidence' },
            { value: 'HelixChem Industries · CapIQ ID 12091 · parent-co ambiguity flagged', tone: 'warn' },
            { value: 'Atlas Coatings KK · CapIQ ID 5571 · high confidence' },
            { value: 'SiC Materials Korea · CapIQ ID 9914 · high confidence' },
            { value: 'PureWafer Solutions · CapIQ ID 7203 · high confidence' },
          ],
        },
      },
    ],
  },
  {
    id: 's24',
    status: 'done',
    title: 'Ingested 3 source documents',
    description: 'Banker teaser, supplemental memo, supplier list. Extracted 5 candidate companies.',
    timestamp: '14:32:08',
    toolCalls: [
      {
        name: 'file_dump.read',
        args: '(teaser.pdf, memo.docx, suppliers.xlsx)',
        status: '3 files · 124 pages',
        output: {
          label: 'Output',
          rows: [
            { key: 'teaser.pdf', value: '12 pages, extracted 5 candidate companies' },
            { key: 'memo.docx', value: '8 pages, sector context + risk factors' },
            { key: 'suppliers.xlsx', value: '104 rows, supplier ecosystem map' },
          ],
        },
      },
    ],
  },
  { id: 's23', status: 'done', title: 'Loaded thesis spec for Project Maple', description: 'EU + APAC specialty chemicals, EBITDA €15m+.', timestamp: '14:31:52' },
  { id: 's22', status: 'done', title: 'Initialized screening workspace', description: 'Created scratch dir + task graph for 5 candidates.', timestamp: '14:31:40' },
  { id: 's21', status: 'done', title: 'Verified user is on Project Maple', description: 'Sarah Chen, partner, has access to the deal folder.', timestamp: '14:31:32' },
  { id: 's20', status: 'done', title: 'Parsed instruction prompt', description: 'Run L0 + L1 screening on inbound targets, flag borderline.', timestamp: '14:31:24' },
  { id: 's19', status: 'done', title: 'Routed task from CoPilot', description: 'Spawned by Sarah from CoPilot conversation.', timestamp: '14:31:12' },
  { id: 's18', status: 'done', title: 'Task accepted by AI Workforce', description: 'Initial intake and routing to screening agent.', timestamp: '14:31:00' },
  { id: 's17', status: 'done', title: 'Drew peer set for L1 comparison', description: 'Selected 8 listed peers across EU and APAC.', timestamp: '14:30:50' },
  { id: 's16', status: 'done', title: 'Pulled financial statements for 5 candidates', description: 'FY22–FY24 income statement and balance sheet.', timestamp: '14:30:31' },
  { id: 's15', status: 'done', title: 'Detected revenue gap in Korean disclosure', description: 'FY23 segment revenue not disclosed; flagged for review.', timestamp: '14:30:14' },
  { id: 's14', status: 'done', title: 'Translated Korean filings to English', description: 'Q4 disclosure + management discussion.', timestamp: '14:29:58' },
  { id: 's13', status: 'done', title: 'Pulled DART filings for Korean candidate', description: 'Latest annual report + most recent quarterly.', timestamp: '14:29:44' },
  { id: 's12', status: 'done', title: 'Tagged 4 candidates as in-thesis', description: 'Passed L0 sector + geo gate.', timestamp: '14:29:25' },
  { id: 's11', status: 'done', title: 'Rejected Beta Polymers (out-of-geography)', description: 'Operations primarily in LATAM; thesis is EU/APAC.', timestamp: '14:29:08' },
  { id: 's10', status: 'done', title: 'Confirmed sector fit for 4 candidates', description: 'All map to specialty chemicals / advanced materials.', timestamp: '14:28:51' },
  { id: 's09', status: 'done', title: 'Validated facility list against satellite imagery', description: 'Both German sites confirmed, Italian site decommissioned.', timestamp: '14:28:30' },
  { id: 's08', status: 'done', title: 'Pulled patent portfolio for TechSlurry', description: '14 active filings, 9 in EU, 3 in US, 2 in JP.', timestamp: '14:28:12' },
  { id: 's07', status: 'done', title: 'Extracted org chart from teaser', description: 'CEO, CFO, COO + 2 commercial leads.', timestamp: '14:27:54' },
  { id: 's06', status: 'done', title: 'Cross-referenced shipping records', description: 'Bill-of-lading data confirms 3 named EU customers.', timestamp: '14:27:38' },
  { id: 's05', status: 'done', title: 'Computed customer concentration', description: 'Top-2 / top-5 / top-10 share, 3-year average.', timestamp: '14:27:15' },
  { id: 's04', status: 'done', title: 'Flagged supplier concentration risk', description: 'TechSlurry: top 2 customers = 61% of revenue.', timestamp: '14:26:58' },
  { id: 's03', status: 'done', title: 'Mapped NordChem to industry taxonomy', description: 'Specialty chemicals → coatings additives. Confidence 0.92.', timestamp: '14:26:32' },
  { id: 's02', status: 'done', title: 'Estimated revenue band for NordChem AB', description: 'Triangulated from filings + import records. Mid €120m–€150m.', timestamp: '14:26:10' },
  { id: 's01', status: 'done', title: 'Pulled CapIQ profile for NordChem', description: 'Latest filings, ownership graph, recent press.', timestamp: '14:25:48' },
];

export const routines: Routine[] = [
  {
    id: 'r1',
    name: 'CMP & Lithography APAC Scan',
    scheduleSummary: 'Daily · last ran today',
    scheduleDetailed: 'Daily at 06:00 ICT',
    nextRun: 'tomorrow 06:00',
    createdBy: 'You',
    createdAgo: '12 days ago',
    instruction:
      'Each run, scan Inven.AI and SEMI directory for new companies in CMP slurry, lithography ancillaries, and advanced packaging materials across APAC (Korea, Japan, Taiwan). Apply L0 criteria. Surface qualifying candidates to Discoveries.',
    runCount: 12,
    icon: Search,
  },
  {
    id: 'r2',
    name: 'L2+ Pipeline Refresh',
    scheduleSummary: 'Mon 09:00 · last ran 2d ago',
    scheduleDetailed: 'Mondays at 09:00 ICT',
    nextRun: 'in 5 days',
    createdBy: 'Sarah Chen',
    createdAgo: '3 weeks ago',
    instruction:
      'Refresh financials, ownership graph, and material news for every company in the pipeline at L2 or higher. Flag any company whose thesis fit has degraded.',
    runCount: 8,
    icon: RefreshCw,
  },
  {
    id: 'r3',
    name: 'Intent-Signal Scan',
    scheduleSummary: 'Fri 14:00 · last ran 6d ago',
    scheduleDetailed: 'Fridays at 14:00 ICT',
    nextRun: 'tomorrow 14:00',
    createdBy: 'James Tan',
    createdAgo: '6 weeks ago',
    instruction:
      'Scan PR feeds, hiring signals, and investor activity for any of our priority sectors. Surface candidates that hit 2+ intent signals in the past 7 days.',
    runCount: 6,
    icon: Zap,
  },
];

export const routineRuns: Record<string, RoutineRun[]> = {
  r1: [
    {
      id: 'r1-run-1',
      routineId: 'r1',
      status: 'done',
      startedAt: 'Today · 06:00:00 ICT',
      endedAt: 'Today · 06:01:31 ICT',
      trace: [
        { id: 'r1-1-3', status: 'done', title: 'Surfaced findings to Discoveries', description: "3 cards added to the team's Discoveries feed.", timestamp: '06:01:31' },
        { id: 'r1-1-2', status: 'done', title: 'Applied L0 criteria', description: '2 passed all thresholds. 1 had missing EV data — flagged for review.', timestamp: '06:01:24' },
        { id: 'r1-1-1', status: 'done', title: 'Filtered by priority segments', description: '5 candidates matched. Cross-referenced against existing pipeline to dedupe.', timestamp: '06:00:38' },
        { id: 'r1-1-0', status: 'done', title: 'Pulled Inven.AI candidate set', description: '96 new companies added since previous run.', timestamp: '06:00:11' },
      ],
    },
    {
      id: 'r1-run-2',
      routineId: 'r1',
      status: 'done',
      startedAt: 'Yesterday · 06:00:00 ICT',
      endedAt: 'Yesterday · 06:00:48 ICT',
      trace: [
        { id: 'r1-2-1', status: 'done', title: 'Filtered and applied L0', description: '1 candidate matched but failed L0 financial threshold.', timestamp: '06:00:48' },
        { id: 'r1-2-0', status: 'done', title: 'Pulled Inven.AI candidate set', description: '42 new companies since previous run.', timestamp: '06:00:09' },
      ],
    },
    {
      id: 'r1-run-3',
      routineId: 'r1',
      status: 'done',
      startedAt: '2 days ago · 06:00:00 ICT',
      endedAt: '2 days ago · 06:02:14 ICT',
      trace: [
        { id: 'r1-3-1', status: 'done', title: 'Applied L0 and surfaced findings', description: '5 candidates passed all thresholds. 1 promoted to pipeline at L0.', timestamp: '06:02:14' },
        { id: 'r1-3-0', status: 'done', title: 'Scanned and filtered Inven.AI', description: '7 candidates matched priority segments.', timestamp: '06:00:31' },
      ],
    },
    {
      id: 'r1-run-4',
      routineId: 'r1',
      status: 'done',
      startedAt: '3 days ago · 06:00:00 ICT',
      endedAt: '3 days ago · 06:01:02 ICT',
      trace: [
        { id: 'r1-4-1', status: 'done', title: 'Applied L0 and surfaced findings', description: '1 candidate passed L0. Surfaced to Discoveries.', timestamp: '06:01:02' },
        { id: 'r1-4-0', status: 'done', title: 'Scanned and filtered Inven.AI', description: '2 candidates matched priority segments.', timestamp: '06:00:24' },
      ],
    },
    {
      id: 'r1-run-5',
      routineId: 'r1',
      status: 'done',
      startedAt: '4 days ago · 06:00:00 ICT',
      endedAt: '4 days ago · 06:00:22 ICT',
      trace: [
        { id: 'r1-5-0', status: 'done', title: 'Scanned Inven.AI', description: 'No new candidates matching priority segments since previous run.', timestamp: '06:00:22' },
      ],
    },
  ],
  r2: [
    {
      id: 'r2-run-1',
      routineId: 'r2',
      status: 'done',
      startedAt: '2 days ago · 09:00:00 ICT',
      endedAt: '2 days ago · 09:08:42 ICT',
      trace: [
        { id: 'r2-1-2', status: 'done', title: 'Flagged 2 companies with degraded thesis fit', description: 'Lambda Coatings and Beta Polymers no longer meet growth criteria.', timestamp: '09:08:42' },
        { id: 'r2-1-1', status: 'done', title: 'Refreshed financials and ownership', description: '34 companies updated. 2 ownership changes detected.', timestamp: '09:05:18' },
        { id: 'r2-1-0', status: 'done', title: 'Pulled L2+ pipeline list', description: '34 companies in scope.', timestamp: '09:00:12' },
      ],
    },
    {
      id: 'r2-run-2',
      routineId: 'r2',
      status: 'done',
      startedAt: '9 days ago · 09:00:00 ICT',
      endedAt: '9 days ago · 09:06:53 ICT',
      trace: [
        { id: 'r2-2-1', status: 'done', title: 'Refresh complete', description: 'No degradations. 1 material news event surfaced.', timestamp: '09:06:53' },
        { id: 'r2-2-0', status: 'done', title: 'Pulled L2+ pipeline list', description: '32 companies in scope.', timestamp: '09:00:09' },
      ],
    },
    {
      id: 'r2-run-3',
      routineId: 'r2',
      status: 'done',
      startedAt: '16 days ago · 09:00:00 ICT',
      endedAt: '16 days ago · 09:11:24 ICT',
      trace: [
        { id: 'r2-3-0', status: 'done', title: 'Refresh complete', description: '4 material news events surfaced; 1 ownership change.', timestamp: '09:11:24' },
      ],
    },
  ],
  r3: [
    {
      id: 'r3-run-1',
      routineId: 'r3',
      status: 'done',
      startedAt: '6 days ago · 14:00:00 ICT',
      endedAt: '6 days ago · 14:04:18 ICT',
      trace: [
        { id: 'r3-1-1', status: 'done', title: 'Surfaced 3 candidates with 2+ intent signals', description: 'Two PR + hiring matches; one investor activity match.', timestamp: '14:04:18' },
        { id: 'r3-1-0', status: 'done', title: 'Scanned PR feeds, hiring boards, investor data', description: '218 events processed across priority sectors.', timestamp: '14:00:42' },
      ],
    },
    {
      id: 'r3-run-2',
      routineId: 'r3',
      status: 'done',
      startedAt: '13 days ago · 14:00:00 ICT',
      endedAt: '13 days ago · 14:03:55 ICT',
      trace: [
        { id: 'r3-2-0', status: 'done', title: 'Surfaced 1 candidate', description: 'Hiring + investor activity match — flagged for L0.', timestamp: '14:03:55' },
      ],
    },
  ],
};
