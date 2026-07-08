'use client';

import { ReactNode, useEffect, useState } from 'react';
import { usePathname, useParams, useRouter } from 'next/navigation';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { useWorkspaceHref } from '@/hooks/useWorkspaceHref';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
  SidebarInset,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarFooter,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import {
  Brain,
  LayoutDashboard,
  GitBranch,
  Database,
  LogOut,
  Users,
  FileStack,
  Maximize2,
  Minimize2,
  Network,
  Presentation,
  Handshake,
  ArrowLeft,
  ChevronsUpDown,
  Check,
} from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { LivingBackground } from '@/components/LivingBackground';
import { AICopilotPane, COPILOT_DEFAULT_WIDTH } from './AICopilotPane';
import { LayoutControlProvider } from './LayoutControlContext';
import { MobileBottomNav } from './MobileBottomNav';
import { motion, AnimatePresence } from 'framer-motion';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useIsMobile } from '@/hooks/use-mobile';
import { useVisualViewport } from '@/hooks/use-visual-viewport';


interface DashboardLayoutProps {
  children: ReactNode;
  showCompanyGraph?: boolean;
}

const baseNavigation = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, color: 'default' as const },
  { name: 'Pipeline', href: '/pipeline', icon: GitBranch, color: 'default' as const },
  { name: 'Master Data', href: '/master-data', icon: Database, color: 'default' as const },
  { name: 'CRM', href: '/crm', icon: Users, color: 'indigo' as const },
  { name: 'Banker Companies', href: '/banker-related-companies', icon: Handshake, color: 'indigo' as const },
  { name: 'AI File Dump', href: '/ai-file-dump', icon: FileStack, color: 'teal' as const },
  { name: 'Presentation', href: '/presentation', icon: Presentation, color: 'default' as const },
  { name: 'AI Workforce', href: '/ai-workforce', icon: Users, color: 'orange' as const },
  { name: 'Company Graph', href: '/graph', icon: Network, color: 'cyan' as const },
];

export default function DashboardLayout({ children, showCompanyGraph = false }: DashboardLayoutProps) {
  const pathname = usePathname();
  const { user, signOut } = useAuth();
  const isMobile = useIsMobile();
  const [isSidebarOpen, setIsSidebarOpen] = useLocalStorage('layout:sidebar-open', false);
  const [isMainExpanded, setIsMainExpanded] = useLocalStorage('layout:main-expanded', false);
  const [isCopilotExpanded, setIsCopilotExpanded] = useLocalStorage('layout:copilot-expanded', false);
  const [copilotWidth, setCopilotWidth] = useLocalStorage('layout:copilot-width', COPILOT_DEFAULT_WIDTH);

  // Every route this layout wraps lives under /w/<slug>/... — strip that
  // prefix once so route-matching below (`isActive`, `isChatRoute`, etc.)
  // compares against the same bare paths `baseNavigation` uses.
  const logicalPath = pathname.replace(/^\/w\/[^/]+/, '') || '/';
  const isOnAiWorkforce = logicalPath.startsWith('/ai-workforce');
  const showCopilotPane = !isOnAiWorkforce;
  const isChatRoute = logicalPath.startsWith('/chat');

  // On desktop, landing on the dedicated /chat route opens the copilot in its
  // expanded (full-screen) view. We react only to entering the route, so a
  // user who manually collapses the pane while staying on /chat is respected.
  useEffect(() => {
    if (isChatRoute && !isMobile) {
      setIsCopilotExpanded(true);
      setIsMainExpanded(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isChatRoute, isMobile]);

  // Mobile (PWA) experience: drop the desktop sidebar/chrome in favour of an
  // Instagram-style bottom nav with three destinations — the activity feed
  // (dashboard), the AI chat, and company search (master data). The Chat tab
  // renders the full-screen AI CoPilot (with chat history in a slide-in
  // drawer); every other tab renders its page content above the bottom nav.
  if (isMobile) {
    return (
      <ProtectedRoute>
        <MobileShell isChatRoute={isChatRoute}>
          {isChatRoute ? (
            <AICopilotPane
              isExpanded
              onToggleExpand={() => {}}
              hideExpandToggle
              showHistoryButton
              className="border-l-0"
            />
          ) : (
            children
          )}
        </MobileShell>
      </ProtectedRoute>
    );
  }

  const filteredNavigation = baseNavigation.filter((item) => {
    if (item.href === '/graph') return showCompanyGraph;
    return true;
  });

  const handleSignOut = async () => {
    await signOut();
  };

  return (
    <ProtectedRoute>
      <LivingBackground variant="default" />
      <SidebarProvider open={isSidebarOpen} onOpenChange={setIsSidebarOpen}>
        <div className="relative z-10 flex min-h-screen w-full">
          <Sidebar collapsible="icon" className="border-r border-sidebar-border bg-white/70 dark:bg-[hsl(220,20%,8%)]/70 backdrop-blur-xl">
            <SidebarHeader className="border-b border-sidebar-border p-2 group-data-[state=expanded]:p-4">
              <div className="flex items-center justify-between group-data-[state=collapsed]:flex-col group-data-[state=collapsed]:gap-2">
                <div className="flex items-center gap-3">
                  <WorkspaceLink href="/dashboard" aria-label="Go to dashboard" className="group shrink-0">
                    <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 via-violet-500 to-indigo-600 shadow-lg shadow-purple-500/25 transition-all duration-300 group-hover:shadow-purple-500/40 group-hover:scale-105">
                      <Brain className="h-5 w-5 text-white" />
                      <div className="absolute inset-0 rounded-xl bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </WorkspaceLink>
                  <div className="flex flex-col group-data-[state=collapsed]:hidden">
                    <span className="text-sm font-bold bg-gradient-to-r from-purple-400 via-violet-400 to-indigo-400 bg-clip-text text-transparent">Brain 2.0</span>
                    <WorkspaceSwitcher />
                  </div>
                </div>
                <SidebarTrigger className="h-8 w-8 shrink-0" />
              </div>
            </SidebarHeader>

            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupLabel className="text-sidebar-foreground/50">Navigation</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {filteredNavigation.map((item) => {
                      const isActive = logicalPath === item.href ||
                        (item.href !== '/dashboard' && item.href !== '#' && logicalPath.startsWith(item.href));
                      const isColored = item.color !== 'default';
                      const isTeal = item.color === 'teal';
                      const isIndigo = item.color === 'indigo';
                      const isOrange = item.color === 'orange';
                      const isCyan = item.color === 'cyan';
                      const isDisabled = 'disabled' in item && item.disabled;

                      return (
                        <SidebarMenuItem key={item.name}>
                          <SidebarMenuButton
                            asChild={!isDisabled}
                            isActive={isActive}
                            className={cn(
                              'transition-colors',
                              isDisabled && 'opacity-50 cursor-not-allowed',
                              isTeal && !isDisabled && 'text-teal-400 hover:text-teal-300 hover:bg-teal-500/10',
                              isIndigo && !isDisabled && 'text-indigo-400 hover:text-indigo-300 hover:bg-indigo-500/10',
                              isOrange && !isDisabled && 'text-orange-400 hover:text-orange-300 hover:bg-orange-500/10',
                              isCyan && !isDisabled && 'text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10',
                              isActive && !isColored && 'bg-sidebar-accent text-sidebar-accent-foreground',
                              isActive && isTeal && 'bg-teal-500/20 text-teal-300',
                              isActive && isIndigo && 'bg-indigo-500/20 text-indigo-300',
                              isActive && isOrange && 'bg-orange-500/20 text-orange-300',
                              isActive && isCyan && 'bg-cyan-500/20 text-cyan-300'
                            )}
                          >
                            {isDisabled ? (
                              <div className="flex items-center gap-2">
                                <item.icon className={cn(
                                  'h-4 w-4',
                                  isTeal && 'text-teal-400',
                                  isIndigo && 'text-indigo-400',
                                  isOrange && 'text-orange-400',
                                  isCyan && 'text-cyan-400'
                                )} />
                                <span>{item.name}</span>
                              </div>
                            ) : (
                              <WorkspaceLink href={item.href} onClick={() => setIsCopilotExpanded(false)}>
                                <item.icon className={cn(
                                  'h-4 w-4',
                                  isTeal && 'text-teal-400',
                                  isIndigo && 'text-indigo-400',
                                  isOrange && 'text-orange-400',
                                  isCyan && 'text-cyan-400'
                                )} />
                                <span>{item.name}</span>
                              </WorkspaceLink>
                            )}
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>



            <SidebarFooter className="border-t border-sidebar-border p-2 group-data-[state=expanded]:p-4">
              <div className="flex flex-col gap-4">
                {/* Admin Portal is intentionally NOT linked from inside a
                    workspace. It is only reachable from the /workspace picker
                    (the root level), so superadmins enter it before selecting a
                    workspace rather than from within one. */}
                {/* User info - hidden when collapsed */}
                <div className="flex items-center justify-between group-data-[state=collapsed]:hidden">
                  {user && (
                    <div className="flex flex-col min-w-0">
                      <p className="truncate text-sm font-medium text-sidebar-foreground">
                        {user.name}
                      </p>
                      <p className="truncate text-xs text-sidebar-foreground/60">
                        {user.email}
                      </p>
                    </div>
                  )}
                  <ThemeToggle />
                </div>
                {/* Sign out button */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleSignOut}
                  className="justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground group-data-[state=collapsed]:justify-center group-data-[state=collapsed]:p-2"
                >
                  <LogOut className="h-4 w-4 group-data-[state=expanded]:mr-2" />
                  <span className="group-data-[state=collapsed]:hidden">Sign Out</span>
                </Button>
              </div>
            </SidebarFooter>
          </Sidebar>

          <SidebarInset className="flex flex-1 min-w-0 h-screen overflow-hidden">
            {/* ChatProvider lives at the app root (providers.tsx) so the
                copilot conversation persists across page navigation. Do not
                re-wrap it here — a nested provider remounts per page and
                resets the chat. */}
            <div className="flex flex-1 min-w-0 h-full">
                <motion.div
                  className="flex flex-col min-w-0 h-full overflow-hidden"
                  initial={false}
                  animate={{
                    width: isCopilotExpanded && showCopilotPane ? 0 : isMainExpanded ? '100%' : 'auto',
                    flex: isCopilotExpanded && showCopilotPane ? 0 : 1,
                    opacity: isCopilotExpanded && showCopilotPane ? 0 : 1,
                  }}
                  transition={{
                    duration: 0.3,
                    ease: [0.4, 0, 0.2, 1],
                  }}
                >
                  <AnimatePresence>
                    {!isCopilotExpanded && showCopilotPane && (
                      <motion.div
                        className="flex items-center justify-end p-2 border-b bg-background/80 backdrop-blur-xl shrink-0 sticky top-0 z-10"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        <motion.div
                          whileHover={{ scale: 1.02 }}
                          whileTap={{ scale: 0.98 }}
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => { setIsMainExpanded(!isMainExpanded); if (!isMainExpanded) setIsCopilotExpanded(false); }}
                            className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                          >
                            <AnimatePresence mode="wait" initial={false}>
                              <motion.span
                                key={isMainExpanded ? 'collapse' : 'expand'}
                                className="flex items-center gap-1.5"
                                initial={{ opacity: 0, y: -10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: 10 }}
                                transition={{ duration: 0.15 }}
                              >
                                {isMainExpanded ? (
                                  <>
                                    <Minimize2 className="h-3.5 w-3.5" />
                                    Exit Full Screen
                                  </>
                                ) : (
                                  <>
                                    <Maximize2 className="h-3.5 w-3.5" />
                                    Expand
                                  </>
                                )}
                              </motion.span>
                            </AnimatePresence>
                          </Button>
                        </motion.div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <main className="flex-1 overflow-auto min-w-0 w-full">
                    <LayoutControlProvider revealCopilot={() => setIsMainExpanded(false)}>
                      {children}
                    </LayoutControlProvider>
                  </main>
                </motion.div>
                {showCopilotPane && !isMainExpanded && (
                  <motion.div
                    className={cn(
                      // min-w-0 lets the pane shrink below its content's intrinsic
                      // width; without it, long/unbreakable chat content forces the
                      // flex item wider than the viewport in full-screen mode, which
                      // pushes the header's collapse icon off-screen (clipped by the
                      // parent's overflow-hidden).
                      'h-full min-w-0',
                      isCopilotExpanded ? 'flex-1' : ''
                    )}
                    initial={{ opacity: 0, x: 50 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{
                      duration: 0.3,
                      ease: [0.4, 0, 0.2, 1],
                    }}
                  >
                    <AICopilotPane
                      isExpanded={isCopilotExpanded}
                      onToggleExpand={() => { setIsCopilotExpanded(!isCopilotExpanded); if (!isCopilotExpanded) setIsMainExpanded(false); }}
                      width={copilotWidth}
                      onResize={setCopilotWidth}
                    />
                  </motion.div>
                )}
              </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </ProtectedRoute>
  );
}

interface Membership {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
}

function initialsFor(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('') || '?';
}

/**
 * Sidebar brand subtitle: the current workspace name, clickable to switch
 * when the user belongs to more than one. Lives under the "Brain 2.0" title
 * in the sidebar header, matching the original workspace-picker placement.
 *
 * The current value comes from the URL's own `workspaceSlug` param, not the
 * session's globally-active `workspaceId` — two tabs on two different
 * workspaces must each show their own selection, not a shared one. Switching
 * hard-navigates to the same page under the new slug (not `router.push`,
 * matching this file's existing hard-reload convention) so every
 * client-fetched view remounts scoped to the new workspace; `switchWorkspace`
 * is still called first to keep the session cookie in sync for any
 * not-yet-migrated flat-route reads.
 */
function WorkspaceSwitcher() {
  const pathname = usePathname();
  const router = useRouter();
  const params = useParams<{ workspaceSlug?: string }>();
  const { switchWorkspace } = useAuth();
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/workspaces');
        if (!res.ok) return;
        const { data } = await res.json();
        if (!cancelled) setMemberships(data ?? []);
      } catch {
        if (!cancelled) setMemberships([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const currentSlug = params.workspaceSlug;
  const current = memberships?.find((m) => m.workspaceSlug === currentSlug) ?? memberships?.[0];

  // Loading, or a single-membership user — nothing to switch to, so render
  // the name (if known yet) as inert text instead of the dropdown trigger.
  if (!memberships || memberships.length <= 1) {
    return (
      <span className="max-w-[150px] truncate text-xs font-medium text-sidebar-foreground/50">
        {current?.workspaceName ?? ' '}
      </span>
    );
  }

  const handleSelect = async (slug: string) => {
    setOpen(false);
    if (slug === currentSlug) return;
    const target = memberships.find((m) => m.workspaceSlug === slug);
    if (!target) return;
    try {
      await switchWorkspace(target.workspaceId);
      window.location.assign(pathname.replace(/^\/w\/[^/]+/, `/w/${slug}`));
    } catch {
      // Popover is already closed and switchWorkspace's session update never
      // landed — without this the user is left on the old workspace with no
      // sign anything went wrong.
      toast.error('Could not switch workspace — please try again');
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Switch workspace"
          className="flex max-w-[150px] items-center gap-1 rounded text-xs font-medium text-sidebar-foreground/50 transition-colors hover:text-sidebar-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <span className="truncate">{current?.workspaceName}</span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-sidebar-foreground/40" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search workspaces…" />
          <CommandList>
            <CommandEmpty>No workspaces found.</CommandEmpty>
            <CommandGroup>
              {memberships.map((m) => (
                <CommandItem
                  key={m.workspaceId}
                  value={m.workspaceName}
                  onSelect={() => handleSelect(m.workspaceSlug)}
                  className="gap-2"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-violet-500 to-purple-600 text-[10px] font-bold text-white">
                    {initialsFor(m.workspaceName)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {m.workspaceName}
                  </span>
                  <Check
                    className={cn(
                      'h-4 w-4 shrink-0',
                      m.workspaceSlug === current?.workspaceSlug ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        <div className="border-t p-1">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              router.push('/workspace');
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus:outline-none"
          >
            <ArrowLeft className="h-4 w-4 shrink-0" />
            Back to Workspaces
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Full-bleed mobile (PWA) shell with ChatGPT-like keyboard behavior.
 *
 * When the keyboard is closed:
 * - Content fills the screen above the bottom nav
 * - Bottom nav is visible at the bottom
 *
 * When a chat textbox is focused:
 * - Entire mobile frame snaps to the visual viewport (space above keyboard)
 * - Bottom nav remains pinned at the bottom of that visible frame
 * - Chat input remains in the main area, directly above the nav
 * - Only chat content scrolls
 */
function MobileShell({
  isChatRoute,
  children,
}: {
  isChatRoute: boolean;
  children: ReactNode;
}) {
  const { viewportHeight, offsetTop, isKeyboardOpen } = useVisualViewport();
  const isKeyboardMode = isChatRoute && isKeyboardOpen;

  // Bare-bones mobile frame: lock page scrolling and let only in-app regions
  // scroll. For chat, that means the message list is the only scroll container.
  useEffect(() => {
    const htmlOverflow = document.documentElement.style.overflow;
    const bodyOverflow = document.body.style.overflow;
    const bodyOverscrollBehavior = document.body.style.overscrollBehavior;

    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';

    return () => {
      document.documentElement.style.overflow = htmlOverflow;
      document.body.style.overflow = bodyOverflow;
      document.body.style.overscrollBehavior = bodyOverscrollBehavior;
    };
  }, []);

  // Keyboard mode: use the visual viewport frame (smaller visible screen above
  // keyboard). Non-keyboard mode: use the normal full dynamic viewport.
  const shellTop = isKeyboardMode ? offsetTop : 0;
  const shellHeight =
    isKeyboardMode && viewportHeight != null ? `${viewportHeight}px` : '100dvh';

  return (
    <div
      className="fixed inset-x-0 z-10 grid min-h-0 bg-background"
      style={{
        top: shellTop,
        height: shellHeight,
        // In keyboard mode the bottom nav is hidden, so the main area takes the
        // entire visible frame above the keyboard.
        gridTemplateRows: isKeyboardMode ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) auto',
      }}
    >
      <main
        className={cn(
          'min-h-0 min-w-0 flex flex-col',
          isChatRoute ? 'overflow-hidden' : 'overflow-auto',
        )}
      >
        {children}
      </main>
      {!isKeyboardMode && (
        <div className="shrink-0">
          <MobileBottomNav />
        </div>
      )}
    </div>
  );
}
