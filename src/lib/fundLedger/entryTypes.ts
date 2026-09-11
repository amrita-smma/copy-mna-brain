/**
 * The entry-type matrix — what each `fl_entry_type` is allowed to do to the
 * three delta columns.
 *
 * This is a *mirror* of the CHECK-style validation in
 * `FlLedgerService.validateEntryDeltas`, expressed as data so the UI can grey
 * out fields the type can never touch, preview the row it is about to write,
 * and explain the rule to the user — without the form and the service drifting
 * apart. The service remains the authority: anything this module lets through
 * is still validated on the way in.
 *
 * Deliberately free of UI imports so the Ledger view, the copilot's
 * `query_ledger_entries` tool, and the services can all share it.
 */

export type FlEntryType =
  | 'commitment'
  | 'commitment_transfer'
  | 'paid_in'
  | 'distribution'
  | 'redemption'
  | 'unit_transfer'
  | 'buy'
  | 'sell'
  | 'income'
  | 'expense'
  | 'adjustment'
  | 'cash_movement';

/**
 * The constraint on one delta column for one entry type.
 *
 * `nonzero` and `free` differ in whether the field is *required*: a commitment
 * with no amount is rejected, an adjustment with no quantity is not.
 */
export type DeltaRule =
  | 'zero'
  | 'nonzero'
  | 'positive'
  | 'negative'
  | 'non_negative'
  | 'non_positive'
  | 'free';

/** Which way money moves, from the holder's point of view. */
export type FlowDirection = 'out' | 'in' | 'move' | 'flat';

/** Which kind of position an entry type may sit on. */
export type PositionKind = 'fund' | 'asset' | 'any';

export interface EntryTypeSpec {
  /** Full human label, e.g. "Paid-in capital". */
  label: string;
  /** Abbreviated label for narrow table cells. Falls back to `label`. */
  shortLabel?: string;
  /** Fund participation, asset holding, or either. */
  on: PositionKind;
  commitment: DeltaRule;
  quantity: DeltaRule;
  cash: DeltaRule;
  direction: FlowDirection;
  /** True for the two-legged transfer types, which post two mirrored rows. */
  twoLegged?: boolean;
  /** One sentence explaining the type in plain English. */
  blurb: string;
}

/**
 * Every entry type, in the order the posting form offers them.
 *
 * Note on the four inflow types (distribution, redemption, sell, income): every
 * sign here is read from the *holder*, so all four put money into the holder's
 * pocket and carry `cash_delta > 0`. `validateEntryDeltas` enforces exactly
 * that, which is also what lets DPI and IRR be produced by summing `cash_delta`.
 */
export const ENTRY_TYPES: Record<FlEntryType, EntryTypeSpec> = {
  commitment: {
    label: 'Commitment',
    on: 'fund',
    commitment: 'nonzero',
    quantity: 'zero',
    cash: 'zero',
    direction: 'flat',
    blurb: 'Pledge more (or less) to a fund. No money moves.',
  },
  commitment_transfer: {
    label: 'Commitment transfer',
    shortLabel: 'Commit. transfer',
    on: 'fund',
    commitment: 'nonzero',
    quantity: 'zero',
    cash: 'free',
    direction: 'move',
    twoLegged: true,
    blurb: 'One holder hands their pledge to another. Two rows that cancel.',
  },
  paid_in: {
    label: 'Paid-in capital',
    shortLabel: 'Paid-in',
    on: 'fund',
    commitment: 'zero',
    quantity: 'non_negative',
    cash: 'negative',
    direction: 'out',
    blurb: 'A capital call actually paid. Cash and the units it bought, one row.',
  },
  distribution: {
    label: 'Distribution',
    on: 'fund',
    commitment: 'zero',
    quantity: 'zero',
    cash: 'positive',
    direction: 'in',
    blurb: 'Cash paid back out of a fund to its holders.',
  },
  redemption: {
    label: 'Redemption',
    on: 'fund',
    commitment: 'zero',
    quantity: 'negative',
    cash: 'positive',
    direction: 'in',
    blurb: "The fund cancels a holder's units.",
  },
  unit_transfer: {
    label: 'Unit transfer',
    on: 'fund',
    commitment: 'zero',
    quantity: 'nonzero',
    cash: 'free',
    direction: 'move',
    twoLegged: true,
    blurb: 'Secondary sale of units between two holders.',
  },
  buy: {
    label: 'Buy',
    on: 'asset',
    commitment: 'zero',
    quantity: 'non_negative',
    cash: 'negative',
    direction: 'out',
    blurb: 'Money out, shares in. Initial cheque or follow-on.',
  },
  sell: {
    label: 'Sell',
    on: 'asset',
    commitment: 'zero',
    quantity: 'non_positive',
    cash: 'positive',
    direction: 'in',
    blurb: 'Exit or partial divestment.',
  },
  income: {
    label: 'Income',
    on: 'any',
    commitment: 'zero',
    quantity: 'zero',
    cash: 'positive',
    direction: 'in',
    blurb: 'Interest, dividends, proceeds that are not a disposal.',
  },
  expense: {
    label: 'Expense',
    on: 'any',
    commitment: 'zero',
    quantity: 'zero',
    cash: 'negative',
    direction: 'out',
    blurb: 'Fees, taxes, costs charged against the position.',
  },
  adjustment: {
    label: 'Adjustment',
    on: 'any',
    commitment: 'free',
    quantity: 'free',
    cash: 'zero',
    direction: 'flat',
    blurb: 'Write-off or correction that never touches cash.',
  },
  cash_movement: {
    label: 'Cash movement',
    on: 'asset',
    commitment: 'zero',
    quantity: 'zero',
    cash: 'nonzero',
    direction: 'move',
    blurb: 'Internal cash transfer or mirrored cash leg.',
  },
};

/** Every entry type, in display order. */
export const ENTRY_TYPE_KEYS = Object.keys(ENTRY_TYPES) as FlEntryType[];

/** Human-readable label for a flow direction, used in the posting form. */
export const DIRECTION_LABELS: Record<FlowDirection, string> = {
  out: 'Money out',
  in: 'Money in',
  move: 'Moves between holders',
  flat: 'No cash',
};

/** True when the type posts two mirrored rows that must cancel. */
export function isTwoLegged(type: FlEntryType): boolean {
  return ENTRY_TYPES[type]?.twoLegged === true;
}

/** The spec for a type, or `undefined` for a value that isn't one. */
export function entryTypeSpec(type: string): EntryTypeSpec | undefined {
  return ENTRY_TYPES[type as FlEntryType];
}

/** The type's label, falling back to the raw value for unknown types. */
export function entryTypeLabel(type: string): string {
  return entryTypeSpec(type)?.label ?? type;
}

/** The type's short label for narrow cells, falling back to the full label. */
export function entryTypeShortLabel(type: string): string {
  const spec = entryTypeSpec(type);
  return spec?.shortLabel ?? spec?.label ?? type;
}

/**
 * The matrix glyph for a rule — how the Entry rules table renders it.
 *
 * `nonzero` and `free` both show as ±: the distinction between them is
 * "required" vs "optional", which the form expresses by disabling the field,
 * not something the matrix column can carry.
 */
export function ruleGlyph(rule: DeltaRule): string {
  switch (rule) {
    case 'zero':
      return '0';
    case 'positive':
    case 'non_negative':
      return '+';
    case 'negative':
    case 'non_positive':
      return '−';
    default:
      return '±';
  }
}

/** True when a rule forbids any value but zero — the field is never editable. */
export function ruleIsFixedZero(rule: DeltaRule): boolean {
  return rule === 'zero';
}

/**
 * Invert a delta rule for mirrored reversal rows.
 * Reversal rows mirror economic effects by negating deltas.
 */
export function mirrorRuleForReversal(rule: DeltaRule): DeltaRule {
  switch (rule) {
    case 'positive':
      return 'negative';
    case 'negative':
      return 'positive';
    case 'non_negative':
      return 'non_positive';
    case 'non_positive':
      return 'non_negative';
    default:
      return rule;
  }
}

/**
 * Whether a signed value satisfies a rule. Mirrors the service's checks so the
 * form can disable its submit button rather than posting a row that will be
 * rejected with a 422.
 * When `isReversal` is true, rules with fixed signs are inverted to reflect
 * mirrored negation.
 */
export function satisfiesRule(
  rule: DeltaRule,
  value: number,
  isReversal = false,
): boolean {
  const effectiveRule = isReversal ? mirrorRuleForReversal(rule) : rule;
  switch (effectiveRule) {
    case 'zero':
      return value === 0;
    case 'nonzero':
      return value !== 0;
    case 'positive':
      return value > 0;
    case 'negative':
      return value < 0;
    case 'non_negative':
      return value >= 0;
    case 'non_positive':
      return value <= 0;
    case 'free':
      return true;
    default:
      return false;
  }
}

/**
 * Apply a type's sign convention to a magnitude the user typed.
 *
 * The posting form only ever asks for a positive amount — "how much" — and the
 * signs come from the type, never from the keyboard. A rule that forbids a
 * value returns 0 regardless of what was entered.
 *
 * `decrease` only bites on the rules that allow either sign (`free`,
 * `nonzero`): reducing a pledge, or writing units off with an adjustment. On a
 * rule with a fixed sign it is ignored, because the type has already decided.
 */
export function signedForRule(rule: DeltaRule, magnitude: number, decrease = false): number {
  const size = Math.abs(magnitude);
  switch (rule) {
    case 'zero':
      return 0;
    case 'negative':
    case 'non_positive':
      return -size;
    case 'positive':
    case 'non_negative':
      return size;
    default:
      return decrease ? -size : size;
  }
}

/** True when a rule lets the user choose the sign — the form offers a toggle. */
export function ruleAllowsEitherSign(rule: DeltaRule): boolean {
  return rule === 'free' || rule === 'nonzero';
}

/** True when the type can sit on a position holding this kind of instrument. */
export function allowsPositionKind(
  type: FlEntryType,
  kind: 'fund' | 'asset' | 'unknown',
): boolean {
  if (kind === 'unknown') return true;
  const on = ENTRY_TYPES[type]?.on;
  return on === 'any' || on === kind;
}
