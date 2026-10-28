import type { ColumnLayoutState } from '@/lib/table/columnLayout';

/** The financial columns, collapsed into one group in the default layout. */
const DEFAULT_COLLAPSED_COLUMNS = ['revenue', 'ebitda', 'valuation', 'stake', 'deal_type', 'remarks'];
/** Every other column the default layout hides. */
const DEFAULT_HIDDEN_COLUMNS = [
  'source_type',
  'entered_by',
  'banker',
  'advisor',
  'is_live',
  'nbo_date',
  'geo',
  'matched_tracks',
  'status',
  'dropped_reason',
  'last_activity',
];

/**
 * The layout the table opens with until the workspace saves its own (and
 * returns to on Reset): Stage, Pipeline Status, Created At, AI Opinion, the
 * Deal Lead (Deal Sponsor before the captain stages) and Sector open; Revenue,
 * EBITDA, Valuation, % Stake, Deal Type and Additional Remarks in one collapsed
 * group behind a '+'; everything else hidden, one click away in the gear.
 */
export const INBOUND_DEFAULT_LAYOUT: Partial<ColumnLayoutState> = {
  order: [
    'stage',
    'pipeline_status',
    'created',
    'ai_opinion',
    'deal_lead',
    'sector',
    ...DEFAULT_COLLAPSED_COLUMNS,
    ...DEFAULT_HIDDEN_COLUMNS,
  ],
  hidden: DEFAULT_HIDDEN_COLUMNS,
  groups: [{ id: 'group-financials', collapsed: true, columnIds: DEFAULT_COLLAPSED_COLUMNS }],
};
