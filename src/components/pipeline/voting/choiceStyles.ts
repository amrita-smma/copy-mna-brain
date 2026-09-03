import { VOTE_CHOICE_LABELS, type VoteChoice } from '@/lib/voting/tally';

/**
 * Colour treatment per vote choice, shared by the ballot picker, the results
 * badges and the reviewer columns so one choice always reads the same way.
 */
export const CHOICE_STYLES: Record<
  VoteChoice,
  { label: string; badge: string; button: string }
> = {
  hard_yes: {
    label: VOTE_CHOICE_LABELS.hard_yes,
    badge: 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800',
    button: 'data-[selected=true]:bg-emerald-600 data-[selected=true]:text-white data-[selected=true]:border-emerald-600',
  },
  yes: {
    label: VOTE_CHOICE_LABELS.yes,
    badge: 'bg-green-50 text-green-700 border-green-300 dark:bg-green-950 dark:text-green-300 dark:border-green-800',
    button: 'data-[selected=true]:bg-green-600 data-[selected=true]:text-white data-[selected=true]:border-green-600',
  },
  inconclusive: {
    label: VOTE_CHOICE_LABELS.inconclusive,
    badge: 'bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800',
    button: 'data-[selected=true]:bg-amber-500 data-[selected=true]:text-white data-[selected=true]:border-amber-500',
  },
  no: {
    label: VOTE_CHOICE_LABELS.no,
    badge: 'bg-red-50 text-red-700 border-red-300 dark:bg-red-950 dark:text-red-300 dark:border-red-800',
    button: 'data-[selected=true]:bg-red-600 data-[selected=true]:text-white data-[selected=true]:border-red-600',
  },
  hard_no: {
    label: VOTE_CHOICE_LABELS.hard_no,
    badge: 'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800',
    button: 'data-[selected=true]:bg-rose-700 data-[selected=true]:text-white data-[selected=true]:border-rose-700',
  },
};

/** Left-to-right order the ballot offers, strongest FOR first. */
export const CHOICE_ORDER: VoteChoice[] = [
  'hard_yes',
  'yes',
  'inconclusive',
  'no',
  'hard_no',
];

/**
 * Style lookup that tolerates an unexpected value from the wire. A choice
 * always comes from the DB enum, but an untyped `string` reaching this without
 * a guard would otherwise crash the whole results card.
 */
export function choiceStyle(choice: string): (typeof CHOICE_STYLES)[VoteChoice] {
  return (
    CHOICE_STYLES[choice as VoteChoice] ?? {
      label: choice.replace(/_/g, ' ').toUpperCase(),
      badge: 'bg-muted text-muted-foreground border-border',
      button: '',
    }
  );
}
