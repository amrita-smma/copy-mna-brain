'use client';

import { usePathname } from 'next/navigation';
import { Activity, CircleUser, MessageSquare, Search, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WorkspaceLink } from '@/components/WorkspaceLink';

interface MobileNavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  /** Match the active tab against the current pathname. */
  isActive: (pathname: string) => boolean;
}

// Instagram-style bottom navigation for the mobile (PWA) experience: the
// activity feed (dashboard), the AI chat, company search (master data), and the
// user's own profile page. Profile is a destination like any other — the
// workspace switcher now lives on that page, under the user's name, rather than
// being what this tab opens.
const navItems: MobileNavItem[] = [
  {
    name: 'Activity',
    href: '/dashboard',
    icon: Activity,
    isActive: (p) => p === '/dashboard' || p.startsWith('/dashboard/'),
  },
  {
    name: 'Chat',
    href: '/chat',
    icon: MessageSquare,
    isActive: (p) => p.startsWith('/chat'),
  },
  {
    name: 'Search',
    href: '/master-data',
    icon: Search,
    isActive: (p) => p.startsWith('/master-data'),
  },
  {
    name: 'Profile',
    href: '/profile',
    icon: CircleUser,
    isActive: (p) => p.startsWith('/profile'),
  },
];

export function MobileBottomNav({ className }: { className?: string }) {
  const pathname = usePathname();
  // Every route this nav appears on lives under /w/<slug>/... — strip that
  // prefix so `isActive` compares against the same bare paths `navItems` uses.
  const logicalPath = pathname.replace(/^\/w\/[^/]+/, '') || '/';

  return (
    <nav
      className={cn(
        'z-20 flex shrink-0 items-stretch border-t border-border bg-background/80 backdrop-blur-xl pb-[env(safe-area-inset-bottom)]',
        className,
      )}
    >
      {navItems.map((item) => {
        const active = item.isActive(logicalPath);
        return (
          <WorkspaceLink
            key={item.name}
            href={item.href}
            aria-label={item.name}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex flex-1 flex-col items-center justify-center gap-1 py-2.5 text-xs font-medium transition-colors',
              active
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <item.icon className={cn('h-5 w-5', active && 'scale-110')} />
            <span>{item.name}</span>
          </WorkspaceLink>
        );
      })}
    </nav>
  );
}
