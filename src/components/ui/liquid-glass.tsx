import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Liquid glass (`.liquid-glass` in globals.css): the translucent material of
 * controls that float over content. `LiquidGlass` is a plain surface (a pill
 * holding a title, a composer); `LiquidGlassButton` is a pressable one.
 */
export const LiquidGlass = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('liquid-glass', className)} {...props} />,
);
LiquidGlass.displayName = 'LiquidGlass';

const liquidGlassButtonVariants = cva(
  'liquid-glass liquid-glass-control inline-flex shrink-0 items-center justify-center gap-2 text-foreground outline-none [&_svg]:shrink-0',
  {
    variants: {
      size: {
        /** A round icon button. */
        icon: 'h-11 w-11 rounded-full [&_svg]:h-5 [&_svg]:w-5',
        /** A pill with a label (and maybe an icon or avatar). */
        pill: 'h-11 rounded-full px-4 text-sm font-medium [&_svg]:h-4 [&_svg]:w-4',
      },
    },
    defaultVariants: { size: 'icon' },
  },
);

export interface LiquidGlassButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof liquidGlassButtonVariants> {
  /** Render the child (a link) with the glass instead of a `<button>`. */
  asChild?: boolean;
  /** Selected: a stronger edge and a faint accent glow. */
  selected?: boolean;
}

export const LiquidGlassButton = React.forwardRef<HTMLButtonElement, LiquidGlassButtonProps>(
  ({ className, size, asChild = false, selected, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : (type ?? 'button')}
        data-selected={selected ? 'true' : undefined}
        className={cn(liquidGlassButtonVariants({ size }), className)}
        {...props}
      />
    );
  },
);
LiquidGlassButton.displayName = 'LiquidGlassButton';
