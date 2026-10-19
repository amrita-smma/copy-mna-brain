'use client';

import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The voting rules, restated for users next to the flow they govern. Kept in
 * lockstep with what `CompanyVoteService` actually enforces — if a rule changes
 * there, change it here too.
 */
const RULES: string[] = [
  'The initiator picks the voters from this workspace and sets the date and time the vote closes.',
  'Everyone selected is emailed an invitation with a deep link, a link to the company card, and the card attached as a PowerPoint deck.',
  'The company’s AI Opinion counts as one more voter. Starting a round generates it first if the company doesn’t have one yet.',
  'The five options are HARD YES, YES, NO, INCONCLUSIVE and HARD NO.',
  'A voter can save and revise their draft as often as they like until the deadline.',
  'Pressing Submit locks the ballot — it cannot be changed afterwards.',
  'While voting is open, voters can see only who has submitted — never anyone else’s vote or rationale.',
  'The initiator is the exception: they watch their own round’s ballots come in live, in the same results view everyone gets at the end.',
  'The initiator can cancel the round, or send submissions back to turn every submitted ballot into a draft again.',
  'The round ends as soon as everyone has submitted, or when the deadline passes.',
  'Anything still in draft at the deadline is submitted automatically — as picked if you chose an option, otherwise as INCONCLUSIVE.',
  'When the round ends, the initiator and every voter get a recap email, and the results — with an AI synthesis — become visible to the whole workspace.',
];

/** A "How voting works" hint whose tooltip lists the rules. */
export default function VotingRules({ className }: { className?: string }) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
          data-testid="voting-rules"
        >
          <Info className="h-3.5 w-3.5" />
          How voting works
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="end"
        className="max-w-md p-4"
        data-testid="voting-rules-content"
      >
        <ul className="list-disc space-y-2 pl-4 text-xs leading-relaxed text-muted-foreground">
          {RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
