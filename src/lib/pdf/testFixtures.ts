/**
 * Documents used by the layout regression tests and by the visual check.
 *
 * `kitchenSinkDocument` is deliberately hostile: it is the set of inputs that
 * broke the previous renderer — a verdict label far wider than its column, a
 * gauge label and trend longer than their slots, a 30-row table that must span
 * pages, a 12-point chart whose labels used to collide, a quadrant cell with
 * more items than fit, and text outside Latin-1.
 */
import type { ResearchSummaryPdfInput } from './types';

/** The reported PDF's content, as the agent would emit it today. */
export const gotoDocument: ResearchSummaryPdfInput = {
  title: 'GoTo (IDX: GOTO) — Key Summary',
  subtitle: 'Prepared for rania.rahmundita@star-am.com · 2026-10-07',
  sections: [
    {
      kind: 'kpi_cards',
      cards: [
        { label: 'Price', value: 'IDR 30', hint: 'Mkt cap IDR 32.0T · 52-wk 26–73' },
        {
          label: 'EV / FY26E EBITDA',
          value: '5.5x',
          hint: 'Grab ~10x · Sea ~13x · Meituan ~19x',
        },
        { label: 'Net cash', value: 'IDR 13.7T', hint: '43% of market cap' },
        {
          label: 'Q2 revenue growth',
          value: '+31%',
          hint: 'Two consecutive profitable quarters',
        },
        { label: 'Weighted value', value: 'IDR 37.3', hint: '+24% vs spot' },
        { label: 'Position', value: '1–1.5%', hint: 'Hold under 1% until 29 Oct' },
      ],
    },
    { kind: 'heading', text: 'Position, valuation and financials' },
    {
      kind: 'bullets',
      items: [
        'IDR 30/share on 1,066.09bn shares ex-treasury. EV IDR 18.3T = 5.5x the FY2026E adjusted EBITDA guidance of IDR 3.2–3.4T. P/B 0.99x. No dividend, no payout.',
        'Net cash IDR 13,664bn = 43% of market cap: cash 23,465 less GoPay customer float 2,044 plus time deposits 464 less borrowings and leases 8,221.',
        'Revenue (IDR bn): FY2024 15,894 / FY2025 18,322 / TTM Jun-26 20,757 (+24.2%). EBIT turned positive at +575 from (10,279) in FY2023.',
      ],
    },
    {
      kind: 'chart',
      type: 'bar',
      title: 'Revenue and EBIT',
      unit: 'IDR bn',
      categories: ['FY2023', 'FY2024', 'FY2025', 'TTM Jun-26'],
      series: [
        { name: 'Revenue', values: [14_000, 15_894, 18_322, 20_757] },
        { name: 'EBIT', values: [-10_279, -4_100, 120, 575] },
      ],
    },
    { kind: 'heading', text: 'Peer benchmarks (Q2/H1 2026)' },
    {
      kind: 'scorecard',
      columns: { label: 'Company', verdict: 'Multiple / growth', rationale: 'Note' },
      rows: [
        {
          label: 'GoTo',
          pill: { label: '5.5x / +31%', tone: 'positive' },
          rationale: 'Cheapest and second-fastest in the set; net cash is 43% of market cap.',
        },
        {
          label: 'Grab Holdings',
          pill: { label: '~10x / +22%', tone: 'neutral' },
          rationale:
            'The $235m profit included a one-time $307m Superbank gain; H1 operating cash flow was -$3m.',
        },
        {
          label: 'Sea Limited',
          pill: { label: '~13x / +48%', tone: 'info' },
          rationale:
            '$917m Q2 adjusted EBITDA; Monee NPL90+ stable at 1.0% for five quarters — the credit benchmark.',
        },
        {
          label: 'Meituan',
          pill: { label: '~19x / +14%', tone: 'negative' },
          rationale: 'H1 operating loss of RMB3,779m in the China food-delivery subsidy war.',
        },
      ],
      overallPill: { label: 'CONSTRUCTIVE', tone: 'positive' },
      overallNote:
        'Mechanical de-rating, not an earnings miss — and heavy net buying followed removal of the floor.',
    },
    {
      kind: 'callout',
      tone: 'warning',
      title: 'Data verification note',
      text: 'The FY2026E EBITDA range above is management guidance restated at the Q2 call, not a figure we have independently modelled. Treat the 5.5x as a guidance-implied multiple.',
    },
    { kind: 'heading', text: 'Three dependencies' },
    {
      kind: 'priority_list',
      items: [
        {
          priority: { label: 'P1', tone: 'high' },
          description:
            'Tokopedia fee — IDR 470bn of the IDR 782bn H1 operating profit (60%) at an 85% margin, on a rate agreed with TikTok-controlled TOKO.',
          meta: 'Owner: Coverage · Review: before 29 Oct',
        },
        {
          priority: { label: 'P2', tone: 'medium' },
          description:
            'Credit — lending revenue +65% against impairments +79%; provisions 13.9% of gross receivables.',
        },
        {
          priority: { label: 'P3', tone: 'low' },
          description:
            'Regulation — ojol commission cut from 20% to 8% from 1 July 2026, costing ~IDR 300bn of H2 EBITDA.',
          meta: '~9% of guidance, on a service that is only 7% of group net revenue',
        },
      ],
    },
    { kind: 'heading', level: 'subsection', text: 'Takeaways' },
    {
      kind: 'callout',
      tone: 'takeaway',
      items: [
        'Cheapest multiple in the peer set with the second-fastest growth, and net cash covering 43% of the market cap.',
        'Sixty percent of H1 operating profit rests on one related-party fee agreed with a TikTok-controlled counterparty.',
        'The regulatory cut is real but small — roughly 9% of FY26 EBITDA guidance, on a service that is 7% of group net revenue.',
      ],
    },
  ],
  references: [
    {
      name: 'IDX removes the IDR 50 minimum price floor',
      link: 'https://www.idx.co.id/en/news/press-release',
      date: '2026-09-28',
    },
  ],
};

/** Every block kind, each pushed past the width it is given. */
export const kitchenSinkDocument: ResearchSummaryPdfInput = {
  title:
    'Kitchen sink — a deliberately over-long document title that has to wrap across more than one line without leaving the page box',
  subtitle: 'Prepared for layout.regression@example.com · 2026-10-08',
  sections: [
    { kind: 'heading', text: 'Headings that are far too long to sit on a single line of an A4 page and must wrap' },
    {
      kind: 'paragraph',
      text: 'Accented and non-Latin-1 text: café, Łódź, Ångström, ≥ 95%, ±3pp, 12 × 4, €1.2bn, ₹450cr, →, “quoted”, ‘single’, an em—dash and an ellipsis…',
    },
    { kind: 'heading', level: 'subsection', text: 'KPI cards with values that do not fit on one line' },
    {
      kind: 'kpi_cards',
      cards: [
        {
          label: 'A label long enough to wrap inside its own card',
          value: 'IDR 13,664,000,000,000',
          hint: 'A hint that is comfortably longer than the card is wide and therefore has to wrap onto several lines.',
        },
        { label: 'Short', value: '5.5x' },
        { label: 'Another', value: '+31%', hint: 'Two consecutive profitable quarters' },
        // Four cards against a three-wide grid, so the last row is short and
        // its two empty cells must still carry the tint and the rules out to
        // the frame's right edge. This one also carries a tone, which is the
        // pill branch rather than the headline-number one.
        {
          label: 'Fourth card, a status rather than a quantity',
          value: 'DROPPED FROM THE PIPELINE',
          tone: 'negative',
          hint: 'wraps to a second row',
        },
      ],
    },
    {
      kind: 'chart',
      type: 'bar',
      title: 'Twelve points, the case whose labels used to collide',
      unit: 'IDR bn',
      categories: [
        'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','December 2026',
      ],
      series: [
        { name: 'Net revenue', values: [-10_279, -8_140, -5_900, -3_120, -840, 120, 575, 1_240, 1_980, 2_410, 2_990, 3_400] },
      ],
    },
    {
      kind: 'chart',
      type: 'stacked_bar',
      title: 'Revenue mix',
      unit: 'IDR bn',
      categories: ['FY2024', 'FY2025', 'TTM Jun-26'],
      series: [
        { name: 'On-demand services', values: [6_200, 6_900, 7_400] },
        { name: 'Fintech', values: [4_100, 5_600, 6_900] },
        { name: 'Logistics', values: [3_100, 3_400, 3_800] },
        { name: 'Other', values: [2_494, 2_422, 2_657] },
      ],
    },
    {
      kind: 'chart',
      type: 'line',
      title: 'Adjusted EBITDA margin',
      unit: '%',
      categories: ['Q1-25', 'Q2-25', 'Q3-25', 'Q4-25', 'Q1-26', 'Q2-26'],
      series: [
        { name: 'GoTo', values: [-4.2, -2.1, -0.4, 1.2, 2.8, 4.1] },
        { name: 'Peer median', values: [1.1, 1.4, 1.9, 2.2, 2.6, 3.0] },
      ],
    },
    {
      kind: 'chart',
      type: 'pie',
      title: 'Where the net cash sits',
      unit: 'IDR bn',
      categories: ['Cash and equivalents', 'Time deposits', 'GoPay customer float (contra)'],
      series: [{ name: 'Balance', values: [23_465, 464, 2_044] }],
    },
    { kind: 'heading', text: 'Gauges with labels and trends wider than their slots' },
    {
      kind: 'gauges',
      gauges: [
        {
          label: 'Provisions as a share of gross receivables, measured at period end',
          valuePct: 13.9,
          tone: 'negative',
          trendLabel: 'up from 11.2% a year ago',
        },
        { label: 'Take rate', valuePct: 100, tone: 'positive', trendLabel: 'vs Q4: +3pp' },
        { label: 'Utilisation', valuePct: 47 },
      ],
    },
    { kind: 'heading', text: 'A thirty-row table that has to span pages' },
    {
      kind: 'scorecard',
      columns: { label: 'Criterion', verdict: 'Assessment', rationale: 'Why' },
      rows: Array.from({ length: 30 }, (_, i) => ({
        label: `Criterion ${i + 1} with a name long enough to wrap inside the label column`,
        pill: {
          // Row number first: a long verdict wraps, and only the first line is
          // guaranteed to carry it.
          label:
            i % 3 === 0
              ? `${i + 1} CONDITIONALLY ACCEPTABLE`
              : i % 3 === 1
                ? `${i + 1} PASS`
                : `${i + 1} NEEDS WORK`,
          tone: (['warning', 'positive', 'negative'] as const)[i % 3],
        },
        // Each cell is stamped with its row number so a test can tell whether
        // every part of one row landed on the same page. Identical text across
        // rows would make a split row indistinguishable from an intact one.
        rationale:
          i % 4 === 0
            ? `Row ${i + 1}: a single short note.`
            : `Row ${i + 1}: a rationale long enough to wrap onto three or four lines inside the notes column, which is exactly the shape of row that used to run off the bottom of the page or print on top of the row beneath it.`,
      })),
      overallPill: { label: 'PROCEED WITH CONDITIONS', tone: 'warning' },
      overallNote:
        'An overall note that is itself long enough to need wrapping, which the previous renderer drew at a fixed x with no wrapping at all and therefore pushed straight off the right edge of the page.',
    },
    { kind: 'heading', text: 'Quadrants with more items than the cell used to hold' },
    {
      kind: 'quadrants',
      quadrants: {
        xLabelLow: 'Low execution risk',
        xLabelHigh: 'High execution risk',
        yLabelHigh: 'High impact',
        yLabelLow: 'Low impact',
        topLeft: [
          'Tokopedia fee renegotiation',
          'Credit provisioning policy',
          'Ojol commission cap',
          'Index re-inclusion',
          'Buyback authorisation',
          'A sixth item, added to push this cell past the fixed height the old renderer clipped against',
        ],
        topRight: ['Superbank consolidation', 'Cross-border logistics'],
        bottomLeft: ['Merchant tooling'],
        bottomRight: [],
      },
    },
    { kind: 'heading', text: 'Legacy bar_chart block' },
    {
      kind: 'bar_chart',
      title: 'Revenue by fiscal year',
      unit: 'IDR bn',
      accent: 'secondary',
      data: [
        { year: 'FY2023', value: 14_000 },
        { year: 'FY2024', value: 15_894 },
        { year: 'FY2025', value: 18_322 },
      ],
    },
    {
      kind: 'callout',
      tone: 'warning',
      title: 'A callout eyebrow long enough that it has to wrap onto a second line of small caps',
      text: 'An amber callout whose body is comfortably longer than the box is wide, so it must wrap, and which is then followed by a bullet list in the same box to check that both halves can coexist.',
      items: [
        'A bullet inside a callout, long enough to wrap onto a second line so the dot stays beside the first line rather than centring itself against the block.',
        'A short one.',
      ],
    },
    {
      kind: 'callout',
      tone: 'takeaway',
      title: 'Takeaways',
      items: Array.from(
        { length: 8 },
        (_, i) =>
          `Takeaway ${i + 1}: an inverted panel item long enough to wrap, repeated often enough that the panel has to break across a page and keep its fill on the continuation.`,
      ),
    },
    // Neither text nor items: renders nothing rather than an empty box.
    { kind: 'callout', tone: 'info', title: 'Dropped' },
    { kind: 'bullets', items: [] },
    { kind: 'priority_list', items: [
      {
        priority: { label: 'IMMEDIATE ACTION REQUIRED', tone: 'high' },
        description: 'A priority tag long enough that it used to be drawn straight through the description beside it.',
        meta: 'Owner: Workforce · Due: this week',
      },
    ] },
  ],
  references: Array.from({ length: 3 }, (_, i) => ({
    name: `Source ${i + 1} with a title long enough to wrap onto a second line in the reference list`,
    link: 'https://www.example.com/a/very/long/path/that/has/no/spaces/in/it/at/all/and/must/still/stay/inside/the/page',
    date: '2026-10-08',
  })),
};
