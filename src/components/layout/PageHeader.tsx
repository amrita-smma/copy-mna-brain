'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The page header band — one title treatment for every console page.
 *
 * This is the Pipeline header (MB-648's SQE Suite prototype) extracted so the
 * other pages wear it too, rather than each view inventing its own. Before
 * this, headings ranged over `text-xl`/`text-2xl`/`text-3xl` and
 * `font-semibold`/`font-bold`, and half the pages prefixed the title with a
 * decorative gradient icon tile. The band is deliberately full-bleed: a page
 * puts its padding on the content below the header, not on a wrapper around
 * both.
 *
 * Slots exist for content that carries meaning — a status badge, the page's
 * controls, a breadcrumb — and not for decoration. If you reach for `leading`
 * to reintroduce an icon tile, don't: it is there for identity content such as
 * the Profile avatar.
 */
interface PageHeaderProps {
  title: ReactNode;
  /** One line under the title saying what the page is for. */
  subtitle?: ReactNode;
  /** Inline after the title: a badge, a count, an edit affordance. */
  titleAdornment?: ReactNode;
  /** Top-aligned on the right: the page's primary controls. */
  actions?: ReactNode;
  /** Above the title: a breadcrumb or a back link. */
  eyebrow?: ReactNode;
  /** Left of the title block, for identity content (the Profile avatar). */
  leading?: ReactNode;
  /** On the band itself — for layout (`shrink-0`), not for looks. */
  className?: string;
  /**
   * On the band's inner row, so a page whose body is width-constrained can
   * align its title with its content while the gradient stays full-bleed.
   */
  innerClassName?: string;
  titleTestId?: string;
  subtitleTestId?: string;
}

export function PageHeader({
  title,
  subtitle,
  titleAdornment,
  actions,
  eyebrow,
  leading,
  className,
  innerClassName,
  titleTestId,
  subtitleTestId,
}: PageHeaderProps) {
  return (
    <div className={cn('page-hero px-6 pb-7 pt-6', className)}>
      <div
        className={cn(
          'flex items-start justify-between gap-4',
          innerClassName,
        )}
      >
        <div className="flex min-w-0 items-start gap-4">
          {leading}
          <div className="min-w-0">
            {eyebrow && (
              <div className="mb-2 text-xs text-muted-foreground">{eyebrow}</div>
            )}
            <div className="flex items-center gap-2">
              <h1
                data-testid={titleTestId}
                className="text-3xl font-bold tracking-tight"
              >
                {title}
              </h1>
              {titleAdornment}
            </div>
            {subtitle && (
              <p data-testid={subtitleTestId} className="text-muted-foreground">
                {subtitle}
              </p>
            )}
          </div>
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </div>
    </div>
  );
}
