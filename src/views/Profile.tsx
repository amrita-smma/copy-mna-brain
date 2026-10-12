'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import {
  Brain,
  Building2,
  ChevronDown,
  ChevronRight,
  FileText,
  Gavel,
  Loader2,
  LogOut,
  ShieldCheck,
  Sparkles,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { countryFlag } from '@/lib/countryFlag';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspaceHref } from '@/hooks/useWorkspaceHref';
import { useIsMobile } from '@/hooks/use-mobile';
import { PageHeader } from '@/components/layout/PageHeader';
import { getProfileItems } from '@/lib/api/profile';
import type {
  ProfileActionItem,
  ProfileCompanyItem,
  ProfileCompanyRole,
  ProfileInsightItem,
  ProfileItems,
} from '@/lib/api/profile';
import {
  MobileWorkspaceDrawer,
  workspaceInitials,
} from '@/components/layout/MobileWorkspaceDrawer';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { usePipelineStages } from '@/hooks/usePipelineStages';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import MemoryTab from '@/components/profile/MemoryTab';
import ProfileDetailsTab from '@/components/profile/ProfileDetailsTab';

/** Cards per section. The page is a jumping-off point, not a full list view. */
const SECTION_LIMIT = 8;

const ROLE_LABELS: Record<ProfileCompanyRole, string> = {
  captain: 'Deal Captain',
  sponsor: 'Deal Sponsor',
  assignee: 'Assignee',
};

/**
 * Tab values in the order they appear, mirrored in the `?tab=` query param so a
 * refresh restores one. The first is what the page opens on.
 */
const PROFILE_TAB_VALUES = ['you', 'items', 'memory'] as const;
export type ProfileTab = (typeof PROFILE_TAB_VALUES)[number];
const DEFAULT_PROFILE_TAB: ProfileTab = 'you';

/**
 * Which tab a `?tab=` value selects.
 *
 * Falls back to the first tab for anything unrecognised, and for `memory` when
 * the Memory tab is not available — a bookmark kept from before memory was
 * switched off, or a link shared with someone whose deployment never had it,
 * should land on a tab that exists rather than on an empty strip.
 */
export function resolveProfileTab(
  value: string | null | undefined,
  showMemoryTab: boolean,
): ProfileTab {
  if (value === 'memory') return showMemoryTab ? 'memory' : DEFAULT_PROFILE_TAB;
  if (value === 'you') return 'you';
  return value === 'items' ? 'items' : DEFAULT_PROFILE_TAB;
}

/**
 * Possessive form of a display name — "Nico's", but "Chris'" for a name that
 * already ends in s, and a neutral fallback when we have no name yet.
 */
export function possessive(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'Your';
  return /s$/i.test(trimmed) ? `${trimmed}'` : `${trimmed}'s`;
}

export function userInitials(name: string, email: string): string {
  const source = name.trim() || email.trim();
  const initials = source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('');
  return initials || '?';
}

/** "3 days ago" / "in 2 hours", or null when there is no timestamp to show. */
function relativeTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatDistanceToNow(date, { addSuffix: true });
}

/**
 * The mobile profile page: who you are, which workspace you are in, and
 * everything in this workspace that is yours — the deals you own, the insights
 * you wrote, and the decisions waiting on you.
 *
 * The workspace switcher is the dropdown under the name here. It used to BE
 * the Profile tab (tapping Profile opened the switcher sheet and nothing
 * else); the tab is now a link to this page.
 *
 * Desktop reaches the same page from the sidebar's `…` account menu, but drops
 * the workspace selector and the log-out button: `WorkspaceSwitcher` in the
 * sidebar header and "Sign Out" in that same account menu already own both, and
 * a second copy here would be a second source of truth for switching workspaces.
 * Gated on `useIsMobile` — the same hook and breakpoint `AppShell` uses to pick
 * a shell, so the page and the chrome around it can never disagree.
 *
 * Every section comes from a single `/api/profile/items` request — one call,
 * not one per card. Do not add a per-row fetch to these cards; batch it into
 * that endpoint instead.
 */
export interface ProfileProps {
  /**
   * `COPILOT_MEMORY_ENABLED`, resolved server-side in the page file. With it
   * off there is nothing to show under Memory, so the tab strip is not
   * rendered at all and the page looks exactly as it did before.
   */
  showMemoryTab?: boolean;
}

export default function Profile({ showMemoryTab = false }: ProfileProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();
  const { user, loading: authLoading, signOut } = useAuth();
  const [data, setData] = useState<ProfileItems | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // The open tab lives in the URL (`?tab=`) so a refresh — or a shared link —
  // reopens the one you were on. Local state mirrors it so the switch renders
  // immediately instead of waiting on the navigation, matching the `?tab=`
  // handling in CompanyDetail.
  const tabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<ProfileTab>(() =>
    resolveProfileTab(tabParam, showMemoryTab),
  );

  // Back/forward, an external link, or the flag resolving late changes the
  // param rather than the state.
  useEffect(() => {
    setActiveTab(resolveProfileTab(tabParam, showMemoryTab));
  }, [tabParam, showMemoryTab]);

  const profileHref = useWorkspaceHref('/profile');
  const pipelineHref = useWorkspaceHref('/pipeline');
  const insightHref = useWorkspaceHref('/insight');
  const workforceHref = useWorkspaceHref('/ai-workforce');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(false);
      try {
        const items = await getProfileItems({ limit: SECTION_LIMIT });
        if (!cancelled) setData(items);
      } catch (err) {
        console.error('Failed to load profile items', err);
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // `push`, not `replace`: a tab switch is a place you can go Back from, which
  // is the choice CompanyDetail's `?tab=` and Pipeline's `?stage=` already make.
  const handleTabChange = useCallback(
    (value: string) => {
      const next = resolveProfileTab(value, showMemoryTab);
      setActiveTab(next);
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', next);
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams, showMemoryTab],
  );

  const handleLogout = useCallback(async () => {
    try {
      await signOut();
    } catch {
      toast.error('Could not log out — please try again');
    }
  }, [signOut]);

  // Company and vote cards both open the company, which on mobile is the
  // full-screen deal page; `from` brings Back here instead of to the pipeline.
  const openCompany = useCallback(
    (companyId: string, tab?: string) => {
      const query = new URLSearchParams();
      if (tab) query.set('tab', tab);
      query.set('from', profileHref);
      router.push(`${pipelineHref}/${companyId}?${query.toString()}`);
    },
    [router, pipelineHref, profileHref],
  );

  const openActionItem = useCallback(
    (item: ProfileActionItem) => {
      if (item.kind === 'vote' && item.companyId) {
        openCompany(item.companyId, 'voting');
        return;
      }
      if (item.taskId) {
        router.push(`${workforceHref}/tasks/${item.taskId}`);
      }
    },
    [openCompany, router, workforceHref],
  );

  const displayName = user?.name?.trim() || user?.email?.trim() || '';

  // Rendered under the Items tab, or on its own when the Memory tab is off.
  // Hoisted so both branches below share one definition rather than a copy.
  const itemsSection = (
    <>
      {loading ? (
        <ProfileSkeleton />
      ) : error ? (
        <div className="rounded-xl border bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Could not load your items.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <SectionGroup
            title="Needs your attention"
            icon={ShieldCheck}
            count={data?.actionItems.total ?? 0}
            shown={data?.actionItems.items.length ?? 0}
            emptyLabel="Nothing is waiting on you right now."
          >
            {(data?.actionItems.items ?? []).map((item) => (
              <ActionItemCard
                key={`${item.kind}-${item.id}`}
                item={item}
                onOpen={() => openActionItem(item)}
              />
            ))}
          </SectionGroup>

          <SectionGroup
            title="Your companies"
            icon={Building2}
            count={data?.companies.total ?? 0}
            shown={data?.companies.items.length ?? 0}
            emptyLabel="No deals are assigned to you yet."
          >
            {(data?.companies.items ?? []).map((company) => (
              <CompanyCard
                key={company.id}
                company={company}
                onOpen={() => openCompany(company.id)}
              />
            ))}
          </SectionGroup>

          <SectionGroup
            title="Your insights"
            icon={FileText}
            count={data?.insights.total ?? 0}
            shown={data?.insights.items.length ?? 0}
            emptyLabel="You haven't created an insight yet."
          >
            {(data?.insights.items ?? []).map((insight) => (
              <InsightCard
                key={insight.id}
                insight={insight}
                onOpen={() => router.push(`${insightHref}/${insight.id}`)}
              />
            ))}
          </SectionGroup>
        </div>
      )}
    </>
  );

  return (
    <div className="flex min-h-full flex-col">
      <ProfileHeader
        name={displayName}
        email={user?.email ?? ''}
        loading={authLoading && !user}
        showWorkspaceSelector={isMobile}
      />

      <div className="flex flex-col gap-6 px-4 pb-10 pt-6">
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="flex flex-col gap-3"
      >
        <TabsList className="w-full justify-start">
          <TabsTrigger value="you" className="gap-1.5" data-testid="profile-tab-you">
            <UserRound className="h-3.5 w-3.5" />
            Your Profile
          </TabsTrigger>
          <TabsTrigger value="items" data-testid="profile-tab-items">
            {possessive(displayName)} items
          </TabsTrigger>
          {showMemoryTab && (
            <TabsTrigger
              value="memory"
              className="gap-1.5"
              data-testid="profile-tab-memory"
            >
              <Brain className="h-3.5 w-3.5" />
              Memory
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="you" className="mt-1">
          <ProfileDetailsTab />
        </TabsContent>

        <TabsContent value="items" className="mt-1">
          {itemsSection}
        </TabsContent>

        {/* Radix unmounts an inactive tab, so a visit that never opens one of
            these never issues its request. */}
        {showMemoryTab && (
          <TabsContent value="memory" className="mt-1">
            <MemoryTab />
          </TabsContent>
        )}
      </Tabs>

      {isMobile && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button
              type="button"
              data-testid="profile-logout"
              className="flex w-full items-center justify-center gap-2 rounded-xl border bg-card px-3 py-3 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 focus:outline-none"
            >
              <LogOut className="h-4 w-4 shrink-0" />
              Log out
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Log out?</AlertDialogTitle>
              <AlertDialogDescription>
                You&apos;ll be signed out of your account and returned to the login
                screen.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleLogout}
                className="bg-red-600 hover:bg-red-700 focus-visible:ring-red-600"
              >
                Log out
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      </div>
    </div>
  );
}

function ProfileHeader({
  name,
  email,
  loading,
  showWorkspaceSelector,
}: {
  name: string;
  email: string;
  loading: boolean;
  /** Mobile only — desktop switches workspaces from the sidebar header. */
  showWorkspaceSelector: boolean;
}) {
  return (
    <>
      {/* The avatar earns the `leading` slot: on a profile it is identity, not
          the decorative icon tile the other pages dropped. */}
      <PageHeader
        title={name || 'Your profile'}
        titleTestId="profile-name"
        subtitle={email || undefined}
        leading={
          <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 text-xl font-bold text-white">
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              userInitials(name, email)
            )}
          </span>
        }
      />

      {/* The workspace selector: a dropdown-looking control that opens the
          mobile workspace sheet this page replaced as the Profile tab. It sits
          below the band, so it carries the page padding itself. */}
      {showWorkspaceSelector && (
        <div className="px-4 pt-4">
        <MobileWorkspaceDrawer
          renderTrigger={({ current, loading: workspacesLoading }) => (
            <button
              type="button"
              data-testid="profile-workspace-selector"
              aria-label="Switch workspace"
              className="flex w-full items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 text-xs font-bold text-white">
                {current ? workspaceInitials(current.workspaceName) : '—'}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Workspace
                </span>
                <span className="truncate text-sm font-medium">
                  {current?.workspaceName ??
                    (workspacesLoading ? 'Loading…' : 'Select a workspace')}
                </span>
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          )}
        />
        </div>
      )}
    </>
  );
}

function SectionGroup({
  title,
  icon: Icon,
  count,
  shown,
  emptyLabel,
  children,
}: {
  title: string;
  icon: LucideIcon;
  count: number;
  /** How many cards are rendered; drives the "+N more" tail. Defaults to `count`. */
  shown?: number;
  emptyLabel: string;
  children: React.ReactNode;
}) {
  const rendered = shown ?? count;
  const remaining = Math.max(count - rendered, 0);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {count > 0 && (
          <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
            {count}
          </Badge>
        )}
      </div>
      {rendered === 0 ? (
        <div className="rounded-xl border bg-muted p-5 text-center">
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3">{children}</div>
          {remaining > 0 && (
            <p className="px-1 text-xs text-muted-foreground">
              +{remaining} more
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The shared shape of every card on the page: a large, tappable surface. */
function ItemCard({
  onOpen,
  testId,
  children,
}: {
  onOpen: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={testId}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer rounded-xl border bg-card p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </div>
  );
}

function ActionItemCard({
  item,
  onOpen,
}: {
  item: ProfileActionItem;
  onOpen: () => void;
}) {
  const Icon = item.kind === 'vote' ? Gavel : ShieldCheck;
  const due = relativeTime(item.dueAt);
  const created = relativeTime(item.createdAt);
  return (
    <ItemCard onOpen={onOpen} testId={`profile-action-${item.kind}-${item.id}`}>
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            item.kind === 'vote'
              ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
              : 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400',
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-base font-semibold leading-snug">{item.title}</p>
          {item.subtitle && (
            <p className="text-sm text-muted-foreground">{item.subtitle}</p>
          )}
          {(due || created) && (
            <p className="text-xs text-muted-foreground">
              {due ? `Closes ${due}` : `Raised ${created}`}
            </p>
          )}
        </div>
        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
    </ItemCard>
  );
}

function CompanyCard({
  company,
  onOpen,
}: {
  company: ProfileCompanyItem;
  onOpen: () => void;
}) {
  const { displayLabel } = usePipelineStages();
  const activity = relativeTime(company.lastActivityAt);
  return (
    <ItemCard onOpen={onOpen} testId={`profile-company-${company.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="truncate text-base font-semibold leading-snug">
            {company.name}
          </p>
          {company.projectName && company.projectName !== company.name && (
            <p className="truncate text-xs text-muted-foreground">
              {company.projectName}
            </p>
          )}
        </div>
        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">
          {displayLabel(company.stage)}
        </Badge>
        {company.roles.map((role) => (
          <Badge key={role} variant="secondary">
            {ROLE_LABELS[role]}
          </Badge>
        ))}
        {company.geography && (
          <span className="text-xs text-muted-foreground">
            {countryFlag(company.geography)} {company.geography}
          </span>
        )}
      </div>
      {activity && (
        <p className="mt-2 text-xs text-muted-foreground">
          Last activity {activity}
        </p>
      )}
    </ItemCard>
  );
}

function InsightCard({
  insight,
  onOpen,
}: {
  insight: ProfileInsightItem;
  onOpen: () => void;
}) {
  const updated = relativeTime(insight.updatedAt);
  return (
    <ItemCard onOpen={onOpen} testId={`profile-insight-${insight.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="flex items-center gap-1.5 text-base font-semibold leading-snug">
            {insight.isFeatured && (
              <Sparkles className="h-4 w-4 shrink-0 text-amber-500" />
            )}
            <span className="truncate">{insight.name}</span>
          </p>
          {insight.description && (
            <p className="line-clamp-2 text-sm text-muted-foreground">
              {insight.description}
            </p>
          )}
        </div>
        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
      {updated && (
        <p className="mt-2 text-xs text-muted-foreground">Updated {updated}</p>
      )}
    </ItemCard>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-xl border bg-card p-4">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="mt-2 h-4 w-1/2" />
          <Skeleton className="mt-3 h-4 w-1/3" />
        </div>
      ))}
    </div>
  );
}
