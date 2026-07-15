import { cn } from '@/lib/utils';

/**
 * Investment Brain logomark — the SQE "BRAIN" identity: the letter 'A' as a
 * neural sigmoid wave in the azure → midnight gradient. Wave-only mark, used
 * for the favicon and the collapsed sidebar. Size it with `className`.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/logo-brain-mark.svg" alt="Investment Brain" className={className} />
  );
}

/**
 * Full "BRAIN" wordmark logotype (Plus Jakarta Sans letters + the sigmoid-wave
 * 'A'). Theme-aware: black letters on light, white letters on dark. Size it
 * with `className` (set a height; width auto-scales to the ~5.6:1 aspect).
 */
export function BrandWordmark({ className }: { className?: string }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo-brain-light.svg"
        alt="Investment Brain"
        className={cn('block dark:hidden', className)}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo-brain-dark.svg"
        alt="Investment Brain"
        className={cn('hidden dark:block', className)}
      />
    </>
  );
}
