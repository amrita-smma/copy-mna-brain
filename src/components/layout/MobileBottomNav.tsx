'use client';

import { usePathname } from 'next/navigation';
import { Activity, MessageSquare, Search, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { MobileWorkspaceSwitcher } from '@/components/layout/MobileWorkspaceSwitcher';

interface MobileNavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  /** Match the active tab against the current pathname. */
  isActive: (pathname: string) => boolean;
}

// Instagram-style bottom navigation for the mobile (PWA) experience. Only three
// destinations ship for the mobile MVP: the activity feed (dashboard), the AI
// chat, and company search (master data).
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
      <MobileWorkspaceSwitcher />
    </nav>
  );
}
