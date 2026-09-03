'use client';

import { Info } from 'lucide-react';

/**
 * The voting rules, restated for users next to the flow they govern. Kept in
 * lockstep with what `CompanyVoteService` actually enforces — if a rule changes
 * there, change it here too.
 */
const RULES: string[] = [
  'The initiator picks the voters from this workspace and sets how long the vote stays open.',
  'Everyone selected is emailed an invitation with a deep link, a link to the company card, and the card attached as a PowerPoint deck.',
  'The company’s AI Opinion counts as one more voter. Starting a round generates it first if the company doesn’t have one yet.',
  'The five options are HARD YES, YES, NO, INCONCLUSIVE and HARD NO.',
  'A voter can save and revise their draft as often as they like until the deadline.',
  'Pressing Submit locks the ballot — it cannot be changed afterwards.',
  'While voting is open, nobody can see anyone else’s vote or rationale — only who has submitted.',
  'The initiator can cancel the round, or send submissions back to turn every submitted ballot into a draft again.',
  'The round ends as soon as everyone has submitted, or when the deadline passes.',
  'Anything still in draft at the deadline is submitted automatically — as picked if you chose an option, otherwise as INCONCLUSIVE.',
  'When the round ends, the initiator and every voter get a recap email, and the results — with an AI synthesis — become visible to the whole workspace.',
];

export default function VotingRules({ className }: { className?: string }) {
  return (
    <div
      className={`rounded-lg border bg-card p-4 ${className ?? ''}`}
      data-testid="voting-rules"
    >
      <div className="flex items-center gap-2 mb-3">
        <Info className="h-4 w-4 text-muted-foreground" />
        <h4 className="text-sm font-semibold">How voting works</h4>
      </div>
      <ul className="space-y-2 text-xs leading-relaxed text-muted-foreground list-disc pl-4">
        {RULES.map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>
    </div>
  );
}
