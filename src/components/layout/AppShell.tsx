'use client';

import { ReactNode, useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { useWorkspacePush } from '@/hooks/useWorkspaceHref';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarProvider,
  SidebarInset,
  SidebarFooter,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import {
  CircleUser,
  LogOut,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  MoreHorizontal,
  PenLine,
  Sun,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ProtectedRoute, type ProtectedRouteUser } from '@/components/auth/ProtectedRoute';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LivingBackground } from '@/components/LivingBackground';
import { BrandMark, BrandWordmark } from '@/components/BrandMark';
import { ChatSidebar } from '@/components/chat/ChatSidebar';
import { useChatContext } from '@/components/chat/ChatProvider';
import { NavigationActionHandler } from '@/components/chat/NavigationActionHandler';
import { AICopilotPane, COPILOT_DEFAULT_WIDTH } from './AICopilotPane';
import { LayoutControlProvider, useLayoutControl } from './LayoutControlContext';
import { MobileShell } from './MobileShell';
import { PageContextProvider } from './PageContextProvider';
import { SidebarPagesNav } from './SidebarPagesNav';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { ChangelogWidget } from './ChangelogWidget';
import { FeedbackDialog } from './FeedbackDialog';
import { useFeatureFlags } from './FeatureFlagsContext';
import { motion, AnimatePresence } from 'framer-motion';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import {
  CONSOLE_TABS,
  findTabByPath,
  toLogicalPath,
  visibleConsoleTabs,
} from '@/lib/navigation/consoleTabs';

/**
 * The chat-first application shell.
 *
 * Rendered ONCE, by `src/app/w/[workspaceSlug]/layout.tsx`, around every
 * workspace route. That placement is load-bearing: because the shell sits above
 * the routed `children`, moving between pages is a Next.js soft navigation that
 * swaps only the center console. The sidebar, the copilot pane, and any
 * in-flight chat stream all stay mounted. (This shell used to live inside each
 * view, which remounted the whole thing on every navigation.)
 *
 * Navigation between pages lives in the sidebar as collapsible sections —
 * "Deal Flow" and "Intelligence" (`SidebarPagesNav`) above "Chat History"
 * (`ChatSidebar`). There is no tab strip over the console, and no
 * History/Pages toggle inside the sidebar: both made pages and chats mutually
 * exclusive.
 *
 * Two states:
 *  - **Landing** (`/w/<slug>`, `/w/<slug>/chat`) — the copilot fills the
 *    console. Collapsing it navigates to the last page the user was on.
 *  - **Page open** (`/w/<slug>/pipeline`, …) — the page fills the console with
 *    the copilot docked to the right. Expanding the copilot keeps the URL, so
 *    collapsing returns to the same page.
 */
export function AppShell({
  children,
  initialUser,
}: {
  children: ReactNode;
  /** The session user the workspace layout already authenticated server-side.
   *  Forwarded to `ProtectedRoute` so the gate doesn't flash a spinner while
   *  the client session resolves. */
  initialUser?: ProtectedRouteUser | null;
}) {
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const { focusComposer } = useChatContext();

  const logicalPath = toLogicalPath(pathname);
  // The chat landing: no page in the console, so the copilot owns it. `/chat`
  // is kept alongside the workspace root because the mobile bottom nav and old
  // deeplinks both point at it.
  const isLandingRoute = logicalPath === '/' || logicalPath.startsWith('/chat');
  const activeTab = findTabByPath(logicalPath);

  // Chat history is the whole point of the sidebar now, so it starts open. New
  // key rather than reusing `layout:sidebar-open`, whose stored `false` was a
  // sensible default for a strip of nav icons and a bad one for a chat list.
  const [isSidebarOpen, setIsSidebarOpen] = useLocalStorage('layout:sidebar-open-v2', true);
  const [isMainExpanded, setIsMainExpanded] = useLocalStorage('layout:main-expanded', false);
  const [isCopilotExpanded, setIsCopilotExpanded] = useLocalStorage(
    'layout:copilot-expanded',
    false,
  );
  const [copilotWidth, setCopilotWidth] = useLocalStorage(
    'layout:copilot-width',
    COPILOT_DEFAULT_WIDTH,
  );
  const [lastTabPath, setLastTabPath] = useLocalStorage(
    'layout:last-tab',
    CONSOLE_TABS[0]!.path,
  );

  // Where collapsing the copilot on the landing should take the user. The
  // stored path can be stale — a workspace can turn a section off after
  // someone last visited it — so fall back to the first tab actually in their
  // strip rather than opening a page they can't navigate back to.
  const featureFlags = useFeatureFlags();
  const enabledTabs = visibleConsoleTabs(featureFlags);
  const storedTab = findTabByPath(lastTabPath);
  const collapseTarget =
    storedTab && enabledTabs.includes(storedTab)
      ? storedTab.path
      : (enabledTabs[0] ?? CONSOLE_TABS[0]!).path;

  // Derived rather than written into storage: the landing route has no console
  // content to show, so the copilot is expanded there by definition. Forcing
  // the stored flag instead would leak that state onto the next tab route.
  const copilotExpanded = isLandingRoute ? true : isCopilotExpanded;
  const mainExpanded = isLandingRoute ? false : isMainExpanded;
  // Is the center console on screen at all? An expanded copilot covers it.
  // Every route now carries the copilot pane — the AI Workspace used to be
  // excluded because it had its own in-page CoPilot tab, and dropping that tab
  // would otherwise have left one page with no copilot at all.
  const consoleVisible = !copilotExpanded;

  const pushWorkspace = useWorkspacePush();

  // Remember where to come back to when the user collapses the copilot on the
  // landing. Sub-routes (a deal detail) record their parent tab.
  useEffect(() => {
    if (activeTab) setLastTabPath(activeTab.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.path]);

  // The chat landing is a composer and nothing else, so arriving there — on
  // first load or by navigating in — should leave the caret in it. Deliberately
  // NOT done for tab routes: there the copilot is a docked side pane, and
  // focusing it would pull the caret away from the page the user opened.
  useEffect(() => {
    if (isLandingRoute) focusComposer();
  }, [isLandingRoute, focusComposer]);

  // `setIsCopilotExpanded` / `setIsMainExpanded` are `useLocalStorage` setters,
  // stable across renders, so listing them costs nothing.
  const handleToggleCopilot = useCallback(() => {
    if (copilotExpanded) {
      setIsCopilotExpanded(false);
      // Nothing to reveal on the landing — collapsing there means "show me the
      // console", so open the page the user last had.
      if (isLandingRoute) pushWorkspace(collapseTarget);
      return;
    }
    setIsCopilotExpanded(true);
    setIsMainExpanded(false);
  }, [
    copilotExpanded,
    isLandingRoute,
    collapseTarget,
    pushWorkspace,
    setIsCopilotExpanded,
    setIsMainExpanded,
  ]);

  // Uncover the center console. Both navigation paths out of the chat need
  // this: the agent calling navigate_page, and the user clicking the "Opened X"
  // chip it left behind. Without it the console would swap pages behind an
  // expanded copilot and the click would look like it did nothing.
  // Deliberately does NOT touch `isMainExpanded`: that flag means the user
  // explicitly closed the copilot pane, and a tab navigation should leave it
  // closed (or open) exactly as they left it rather than forcing it back open.
  const handleRevealConsole = useCallback(() => {
    setIsCopilotExpanded(false);
  }, [setIsCopilotExpanded]);

  // Put the copilot full-screen. Starting a new chat should land the user in
  // the conversation rather than in a cramped docked pane. On the landing route
  // `copilotExpanded` is already derived true, so this is a no-op there.
  const handleExpandCopilot = useCallback(() => {
    setIsCopilotExpanded(true);
    setIsMainExpanded(false);
  }, [setIsCopilotExpanded, setIsMainExpanded]);

  // The copilot navigated us somewhere (navigate_page): dock the pane so the
  // page it just opened is actually visible, then soft-navigate.
  const handleAgentNavigate = useCallback(
    (path: string) => {
      handleRevealConsole();
      pushWorkspace(path);
    },
    [handleRevealConsole, pushWorkspace],
  );

  // Mobile (PWA) experience: drop the desktop sidebar/chrome in favour of an
  // Instagram-style bottom nav with three destinations — the activity feed
  // (dashboard), the AI chat, and company search (master data). The Chat tab
  // renders the full-screen AI CoPilot (with chat history in a slide-in
  // drawer); every other tab renders its page content above the bottom nav.
  if (isMobile) {
    return (
      <ProtectedRoute initialUser={initialUser}>
        <PageContextProvider>
          {/* Mobile has no docked pane to uncover — the destination route just
              replaces the chat screen — but navigate_page must still work here,
              so the handler is mounted on both shells. */}
          <NavigationActionHandler onNavigate={pushWorkspace} />
          <MobileShell isChatRoute={isLandingRoute}>
            {isLandingRoute ? (
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
        </PageContextProvider>
      </ProtectedRoute>
    );
  }

  return (
    <ProtectedRoute initialUser={initialUser}>
      <LivingBackground variant="default" />
      <PageContextProvider>
        <SidebarProvider open={isSidebarOpen} onOpenChange={setIsSidebarOpen}>
          <NavigationActionHandler onNavigate={handleAgentNavigate} />
          {/* Wraps the WHOLE shell, not just the panes: the console's pages
              reach for `focusCopilot`, the chat inside the copilot pane reaches
              for `revealConsole`, and the sidebar's "New chat" buttons — which
              live outside SidebarInset — reach for `expandCopilot`. */}
          <LayoutControlProvider
            revealCopilot={() => setIsMainExpanded(false)}
            revealConsole={handleRevealConsole}
            expandCopilot={handleExpandCopilot}
          >
          <div className="relative z-10 flex min-h-screen w-full">
            <Sidebar
              collapsible="icon"
              className="border-r border-sidebar-border bg-white/70 dark:bg-[hsl(240,14%,4%)]/70 backdrop-blur-xl"
            >
              <SidebarHeader className="border-b border-sidebar-border p-2 group-data-[state=expanded]:p-4">
                {/* Brand logo on top; the workspace name + nav trigger stack
                    directly beneath it (expanded). Collapsed keeps the compact
                    mark + trigger centered. */}
                <div className="flex w-full flex-col gap-3 group-data-[state=collapsed]:items-center group-data-[state=collapsed]:gap-2">
                  <div className="flex items-start gap-1 group-data-[state=collapsed]:flex-col group-data-[state=collapsed]:items-center">
                    <WorkspaceLink
                      href="/"
                      aria-label="Go to chat"
                      className="group shrink-0 group-data-[state=expanded]:hidden"
                    >
                      <div className="relative flex h-10 w-10 items-center justify-center transition-transform duration-300 group-hover:scale-105">
                        <BrandMark className="h-9 w-9" />
                      </div>
                    </WorkspaceLink>
                    <WorkspaceLink
                      href="/"
                      aria-label="Go to chat"
                      className="group group-data-[state=collapsed]:hidden"
                    >
                      <BrandWordmark className="h-6 w-auto transition-transform duration-300 group-hover:scale-[1.02]" />
                    </WorkspaceLink>
                    <SidebarTrigger className="hidden absolute right-3 h-6 w-6 shrink-0 text-muted-foreground hover:bg-muted hover:text-muted-foreground [&_svg]:size-3.5 group-data-[state=expanded]:flex" />
                    <SidebarTrigger className="h-8 w-8 shrink-0 group-data-[state=expanded]:hidden" />
                  </div>
                  <div className="relative flex w-full min-w-0 group-data-[state=collapsed]:hidden">
                    <WorkspaceSwitcher />
                  </div>
                </div>
              </SidebarHeader>

              {/* overflow-hidden overrides SidebarContent's own overflow-auto:
                  the chat list has its own ScrollArea, and two nested scroll
                  containers give the sidebar a second, half-broken scrollbar. */}
              <SidebarContent className="min-h-0 overflow-hidden">
                {/* A list of chat titles has nothing to render at icon width,
                    so the collapsed rail offers "new chat" plus the pages as a
                    flat strip of icons. The pages matter: the grouped, labelled
                    sections live inside the expanded sidebar, so without this
                    the collapsed rail would leave no way to reach a page. */}
                <CollapsedNewChatButton />
                <SidebarPagesNav
                  iconOnly
                  className="hidden group-data-[state=collapsed]:block"
                />
                <ChatSidebar className="w-full flex-1 border-r-0 bg-transparent group-data-[state=collapsed]:hidden" />
              </SidebarContent>

              <SidebarFooter className="border-t border-sidebar-border p-2 group-data-[state=expanded]:p-4">
                {/* One row: the user's name, the "what's new" bell, and an
                    overflow menu holding feedback / theme / sign out.
                    Admin Portal is intentionally NOT linked from inside a
                    workspace. It is only reachable from the /workspace picker
                    (the root level), so superadmins enter it before selecting a
                    workspace rather than from within one. */}
                <SidebarUserFooter />
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
                    width: !consoleVisible ? 0 : mainExpanded ? '100%' : 'auto',
                    flex: !consoleVisible ? 0 : 1,
                    opacity: !consoleVisible ? 0 : 1,
                  }}
                  transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                >
                  <AnimatePresence>
                    {consoleVisible && (
                      // Page navigation lives in the sidebar's "Pages" tab, so
                      // all this bar carries is the full-screen toggle for the
                      // page under it.
                      <motion.div
                        className="flex items-center justify-end gap-2 border-b bg-background/80 p-2 backdrop-blur-xl shrink-0 sticky top-0 z-10"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setIsMainExpanded(!isMainExpanded);
                                if (!isMainExpanded) setIsCopilotExpanded(false);
                              }}
                              className="h-7 shrink-0 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
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
                  <main className="flex-1 overflow-auto min-w-0 w-full">{children}</main>
                </motion.div>
                {!mainExpanded && (
                  <motion.div
                    className={cn(
                      // min-w-0 lets the pane shrink below its content's intrinsic
                      // width; without it, long/unbreakable chat content forces the
                      // flex item wider than the viewport in full-screen mode, which
                      // pushes the header's collapse icon off-screen (clipped by the
                      // parent's overflow-hidden).
                      'h-full min-w-0',
                      copilotExpanded ? 'flex-1' : '',
                    )}
                    initial={{ opacity: 0, x: 50 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                  >
                    <AICopilotPane
                      isExpanded={copilotExpanded}
                      onToggleExpand={handleToggleCopilot}
                      width={copilotWidth}
                      onResize={setCopilotWidth}
                    />
                  </motion.div>
                )}
              </div>
            </SidebarInset>
          </div>
          </LayoutControlProvider>
        </SidebarProvider>
      </PageContextProvider>
    </ProtectedRoute>
  );
}

/** The icon-rail stand-in for the chat list: start a new conversation. */
function CollapsedNewChatButton() {
  const { newChat } = useChatContext();
  const { expandCopilot } = useLayoutControl();
  return (
    <div className="hidden justify-center p-2 group-data-[state=collapsed]:flex">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              newChat();
              expandCopilot();
            }}
            className="h-8 w-8 p-0"
          >
            <PenLine className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>New chat</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * The sidebar's bottom row, consolidated: the signed-in user's name, the
 * "what's new" bell, and a `…` overflow menu. Everything that used to be its
 * own stacked row down here — the email line, the theme toggle, "Send
 * Feedback", "Sign Out" — now lives inside that menu, so the footer is one line
 * tall. At icon width the name drops out and the bell + `…` stack vertically.
 *
 * "Profile" here is the only way into `/profile` on desktop (the page is
 * reached from the bottom nav on mobile). That page hides its own workspace
 * selector and log-out button on desktop, because the sidebar header and this
 * very menu already own both.
 */
function SidebarUserFooter() {
  const { user, signOut } = useAuth();
  const { setTheme } = useTheme();
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  return (
    <>
      <div className="flex items-center gap-1 group-data-[state=collapsed]:flex-col group-data-[state=collapsed]:gap-0.5">
        {user && (
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground group-data-[state=collapsed]:hidden">
            {user.name}
          </p>
        )}
        {/* "What's new" changelog — recent releases grouped by day. */}
        <ChangelogWidget />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Account menu"
              className="h-8 w-8 shrink-0 p-0 text-sidebar-foreground/70 hover:text-sidebar-foreground"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="w-56">
            {user && (
              <>
                <DropdownMenuLabel className="flex flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">{user.name}</span>
                  <span className="truncate text-xs font-normal text-muted-foreground">
                    {user.email}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
              </>
            )}
            {/* A real link, not an onSelect push, so the destination is
                middle-clickable and prefetched like every other nav entry. */}
            <DropdownMenuItem asChild>
              <WorkspaceLink href="/profile" className="cursor-pointer">
                <CircleUser className="mr-2 h-4 w-4" />
                Profile
              </WorkspaceLink>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setFeedbackOpen(true)}>
              <MessageSquarePlus className="mr-2 h-4 w-4" />
              Send Feedback
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Sun className="mr-2 h-4 w-4" />
                Theme
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={() => setTheme('light')}>Light</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setTheme('dark')}>Dark</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut()}>
              <LogOut className="mr-2 h-4 w-4" />
              Sign Out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/* Rendered outside the menu: a dialog inside a DropdownMenuItem would
          unmount with the menu the moment the item is selected. */}
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </>
  );
}
