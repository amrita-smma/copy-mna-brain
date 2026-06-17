'use client';

import { CSSProperties, ReactNode, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
} from 'lucide-react';
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
  showCrm?: boolean;
  showAiWorkforce?: boolean;
}

const baseNavigation = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, color: 'default' as const },
  { name: 'Pipeline', href: '/pipeline', icon: GitBranch, color: 'default' as const },
  { name: 'Master Data', href: '/master-data', icon: Database, color: 'default' as const },
  { name: 'CRM', href: '/crm', icon: Users, color: 'indigo' as const },
  { name: 'AI File Dump', href: '/ai-file-dump', icon: FileStack, color: 'teal' as const },
  { name: 'AI Workforce', href: '/ai-workforce', icon: Users, color: 'orange' as const },
];

export default function DashboardLayout({ children, showCrm = false, showAiWorkforce = false }: DashboardLayoutProps) {
  const pathname = usePathname();
  const { user, signOut } = useAuth();
  const isMobile = useIsMobile();
  const [isSidebarOpen, setIsSidebarOpen] = useLocalStorage('layout:sidebar-open', false);
  const [isMainExpanded, setIsMainExpanded] = useLocalStorage('layout:main-expanded', false);
  const [isCopilotExpanded, setIsCopilotExpanded] = useLocalStorage('layout:copilot-expanded', false);
  const [copilotWidth, setCopilotWidth] = useLocalStorage('layout:copilot-width', COPILOT_DEFAULT_WIDTH);

  const isOnAiWorkforce = pathname.startsWith('/ai-workforce');
  const showCopilotPane = !isOnAiWorkforce;
  const isChatRoute = pathname.startsWith('/chat');

  // On desktop, landing on the dedicated /chat route opens the copilot in its
  // expanded (full-screen) view. We react only to entering the route, so a
  // user who manually collapses the pane while staying on /chat is respected.
  useEffect(() => {
    if (isChatRoute && !isMobile) {
      setIsCopilotExpanded(true);
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
    if (item.href === '/crm') return showCrm;
    if (item.href === '/ai-workforce') return showAiWorkforce;
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
                <Link href="/dashboard" className="flex items-center gap-3 group">
                  <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 via-violet-500 to-indigo-600 shadow-lg shadow-purple-500/25 transition-all duration-300 group-hover:shadow-purple-500/40 group-hover:scale-105 shrink-0">
                    <Brain className="h-5 w-5 text-white" />
                    <div className="absolute inset-0 rounded-xl bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  <div className="flex flex-col group-data-[state=collapsed]:hidden">
                    <span className="text-sm font-bold bg-gradient-to-r from-purple-400 via-violet-400 to-indigo-400 bg-clip-text text-transparent">Brain 2.0</span>
                    <span className="text-xs text-sidebar-foreground/50 font-medium">M&A Intelligence</span>
                  </div>
                </Link>
                <SidebarTrigger className="h-8 w-8 shrink-0" />
              </div>
            </SidebarHeader>

            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupLabel className="text-sidebar-foreground/50">Navigation</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {filteredNavigation.map((item) => {
                      const isActive = pathname === item.href ||
                        (item.href !== '/dashboard' && item.href !== '#' && pathname.startsWith(item.href));
                      const isColored = item.color !== 'default';
                      const isTeal = item.color === 'teal';
                      const isIndigo = item.color === 'indigo';
                      const isOrange = item.color === 'orange';
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
                              isActive && !isColored && 'bg-sidebar-accent text-sidebar-accent-foreground',
                              isActive && isTeal && 'bg-teal-500/20 text-teal-300',
                              isActive && isIndigo && 'bg-indigo-500/20 text-indigo-300',
                              isActive && isOrange && 'bg-orange-500/20 text-orange-300'
                            )}
                          >
                            {isDisabled ? (
                              <div className="flex items-center gap-2">
                                <item.icon className={cn(
                                  'h-4 w-4',
                                  isTeal && 'text-teal-400',
                                  isIndigo && 'text-indigo-400',
                                  isOrange && 'text-orange-400'
                                )} />
                                <span>{item.name}</span>
                              </div>
                            ) : (
                              <Link href={item.href}>
                                <item.icon className={cn(
                                  'h-4 w-4',
                                  isTeal && 'text-teal-400',
                                  isIndigo && 'text-indigo-400',
                                  isOrange && 'text-orange-400'
                                )} />
                                <span>{item.name}</span>
                              </Link>
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
                            onClick={() => setIsMainExpanded(!isMainExpanded)}
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
                      'h-full',
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
                      onToggleExpand={() => setIsCopilotExpanded(!isCopilotExpanded)}
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

/**
 * Full-bleed mobile (PWA) shell. The header pins to the top and the chat input
 * floats just above the on-screen keyboard, while the bottom nav stays at the
 * true viewport bottom.
 *
 * The trick is the visual viewport: when the keyboard opens it shrinks the
 * *visual* viewport but not the `100dvh` layout viewport, so the browser would
 * otherwise scroll the whole page up (dragging the header off-screen and
 * lifting the nav). We instead size the shell to the visual viewport height so
 * everything inside it — header, messages, input — stays in the visible area,
 * and render the bottom nav as a separate `fixed` element pinned to the true
 * bottom so the keyboard simply covers it rather than raising it.
 */
function MobileShell({
  isChatRoute,
  children,
}: {
  isChatRoute: boolean;
  children: ReactNode;
}) {
  const { height, offsetTop, keyboardInset } = useVisualViewport();
  const navRef = useRef<HTMLDivElement>(null);
  const [navHeight, setNavHeight] = useState(0);

  // Measure the bottom nav (its height varies with the safe-area inset) so the
  // shell can reserve exactly that much space below the input when the keyboard
  // is closed.
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const measure = () => setNavHeight(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The keyboard is "open" once it covers meaningfully more than the bottom nav.
  const keyboardOpen = keyboardInset > navHeight + 40;

  const shellStyle: CSSProperties =
    height != null
      ? {
          height: `${height}px`,
          transform: `translateY(${offsetTop}px)`,
          // While the keyboard is up the nav is hidden behind it, so we don't
          // reserve room for it — the input sits flush against the keyboard.
          paddingBottom: keyboardOpen ? 0 : navHeight,
        }
      : { paddingBottom: navHeight };

  return (
    <>
      {/* Flat, full-bleed shell: no decorative floating background or card
          chrome — the mobile PWA reads as a single solid surface. */}
      <div
        className="fixed inset-x-0 top-0 z-10 flex h-[100dvh] w-full flex-col overflow-hidden bg-background"
        style={shellStyle}
      >
        <main
          className={cn(
            'flex-1 min-w-0 overscroll-x-none',
            isChatRoute ? 'overflow-hidden' : 'overflow-auto',
          )}
        >
          {children}
        </main>
      </div>
      <div ref={navRef} className="fixed inset-x-0 bottom-0 z-20">
        <MobileBottomNav />
      </div>
    </>
  );
}
