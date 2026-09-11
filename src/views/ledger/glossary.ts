import type { GlossaryEntry } from '@/components/common/GlossaryTerm';

/**
 * The Ledger page's vocabulary, in plain English.
 *
 * Kept separate from the fund-management glossary on purpose: the same words
 * mean subtly different things here. "Commitment" on the portfolio page is a
 * fund-level total; here it is the signed delta on one row.
 */
export const LEDGER_GLOSSARY: Record<string, GlossaryEntry> = {
  dotted: {
    t: 'How definitions work',
    d: 'Any term with a dotted underline has a plain-English explanation. Hover it to read what it means.',
  },
  position: {
    t: 'Position',
    d: 'The account: one holder, one thing held, one source of fund. Every ledger row hangs off exactly one position.',
    e: 'Schema: fl_positions',
  },
  event: {
    t: 'Event',
    d: 'One real-world action. It groups the rows it caused — a transfer is one event with two rows that cancel out.',
    e: 'Schema: fl_business_events',
  },
  entry: {
    t: 'Ledger entry',
    d: 'One signed movement on one position. Its meaning comes from the three delta columns, not the type label alone.',
    e: 'Schema: fl_ledger_entries',
  },
  holder: {
    t: 'Holder',
    d: 'Who economically owns the position — either an investor entity or one of our funds.',
  },
  instrument: {
    t: 'What is held',
    d: 'Either a fund participation or an asset holding. Never both.',
  },
  sourceoffund: {
    t: 'Source of fund',
    d: 'The capital pool the money came from. Attribution only — it never owns anything.',
    e: 'Schema: fl_funding_sources',
  },
  commitdelta: {
    t: 'Commitment Δ',
    d: 'Change in the amount pledged to a fund. A pledge is not cash — no money moves when this changes.',
  },
  qtydelta: {
    t: 'Quantity Δ',
    d: 'Units or shares gained (+) or given up (−) on this position.',
  },
  valuationdelta: {
    t: 'Value Δ',
    d: 'Change in what the position is carried at, without any money moving. An adjustment writing off paid-in capital records its whole amount here — read it with the sub-type beside it.',
  },
  cashdelta: {
    t: 'Cash Δ',
    d: "Money that actually moved, from the holder's point of view. Negative means they paid; positive means they received.",
  },
  perspective: {
    t: "Holder's point of view",
    d: "Every sign is read from the position holder. An investor's capital call is negative cash for them; the fund's side is the same number with the sign flipped.",
  },
  reversal: {
    t: 'Reversal',
    d: 'A row flagged as the correcting half of an earlier posting. Imported data carries this flag; the app does not set it — deleting an event here removes it outright, and editing one re-posts it in place.',
  },
  needsverif: {
    t: 'Needs checking',
    d: 'Imported from a spreadsheet where the source disagreed with itself, or a field was missing. Reports either exclude these or footnote them.',
  },
  asof: {
    t: 'As of',
    d: 'Every number on this page counts only rows dated on or before this date. Move it back to see what the books said then.',
  },
  allocation: {
    t: 'Funding split',
    d: 'When one investment is paid for out of several pools, the cash is split across them. The splits always add up to the cash that moved.',
  },
  counterparty: {
    t: 'Other leg',
    d: 'The matching row on the other side of a transfer. The two always cancel to zero.',
  },
  subtype: {
    t: 'Sub-type',
    d: 'The finer label carried straight through from the source spreadsheet — follow-on, mgmt fee, return of capital, and so on.',
  },
  fx: {
    t: 'FX rate',
    d: 'The rate to the reporting currency, captured at the moment the entry was posted, not looked up later.',
  },
  pps: {
    t: 'Price per unit',
    d: 'The price this movement actually happened at. Where the source recorded none it is derived as cash ÷ units.',
  },
  provenance: {
    t: 'Source row',
    d: 'The spreadsheet file, sheet and row this entry was imported from. Re-importing the same row does nothing.',
    e: 'Schema: fl_source_records',
  },
  netzero: {
    t: 'Nets to zero',
    d: "A transfer moves value between two holders. The fund's totals do not change, so the two rows must cancel exactly.",
  },
  paidin: {
    t: 'Paid-in capital',
    d: 'Cash an investor has actually put into a fund so far, as opposed to what they pledged.',
  },
  opencommit: {
    t: 'Undrawn commitment',
    d: 'Pledged but not yet called. Commitment minus paid-in capital.',
  },
  blended: {
    t: 'Blended price',
    d: 'What every unit still held cost on average — total paid divided by total units acquired, across all the acquisitions.',
  },
  units: {
    t: 'Units',
    d: 'Units or shares currently held on this position — everything acquired minus everything given up.',
  },
  invested: {
    t: 'Invested',
    d: 'Everything paid into this position: capital calls plus purchase cheques. Fees and other expenses are not included.',
  },
};
