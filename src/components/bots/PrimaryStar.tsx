import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The amber star on Brain Bot's avatar: it marks the primary bot in every
 * bot list. Place it inside the avatar's `relative` wrapper and size it with
 * `className` (it defaults to the bottom-right corner).
 */
export function PrimaryStar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      data-testid="bot-primary-star"
      className={cn(
        'pointer-events-none absolute -bottom-0.5 -right-0.5 z-[1] flex h-3 w-3 items-center justify-center rounded-full bg-amber-500 text-white ring-2 ring-background',
        className,
      )}
    >
      <Star className="h-[60%] w-[60%] fill-current" strokeWidth={2.5} />
    </span>
  );
}
