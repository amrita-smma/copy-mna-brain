import { cn } from '@/lib/utils';

/** A bot has a reply the user has not seen (e.g. it answered another bot). */
export function UnreadDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      data-testid="bot-unread-dot"
      className={cn(
        'pointer-events-none absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-blue-500 ring-2 ring-background',
        className,
      )}
    />
  );
}
