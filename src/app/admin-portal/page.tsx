'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
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
import { cn } from '@/lib/utils';
import { LivingBackground } from '@/components/LivingBackground';
import {
  Loader2,
  ArrowLeft,
  Plus,
  Minus,
  Settings,
  Check,
  ChevronsUpDown,
  Mail,
  X,
} from 'lucide-react';

function initialsFor(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('') || '?';
}

/**
 * Superadmin-only workspace configuration: create/rename workspaces, and
 * add/remove members with a per-workspace role. Backed by
 * `WorkspaceService` (workspaces/roles/user_workspaces) — no local mock state.
 */

/** A row in the `users` table, as returned by `GET /api/users`. */
interface DbUser {
  id: string;
  name: string;
  email: string | null;
}

interface Workspace {
  id: string;
  name: string;
  slug: string;
  /** Which AI Copilot flavor the workspace's chat uses. */
  copilot_agent?: string;
  /** Workspace-wide display currency (USD | IDR | CNY). */
  default_currency?: string;
}

/** The AI Copilot flavors, mirrored from the server's COPILOT_AGENTS. */
const COPILOT_AGENT_OPTIONS: { value: string; label: string }[] = [
  { value: 'mna', label: 'M&A / Acquisitions' },
  { value: 'investment', label: 'Funds & Investing' },
  { value: 'combined', label: 'Combined (M&A + Investment)' },
  { value: 'vc', label: 'VC / Growth Equity' },
];

/** The display currencies, mirrored from the server's WORKSPACE_CURRENCIES. */
const CURRENCY_OPTIONS: { value: string; label: string }[] = [
  { value: 'USD', label: 'USD ($)' },
  { value: 'IDR', label: 'IDR (Rp)' },
  { value: 'CNY', label: 'CNY (RMB)' },
];

/** Active tab: primary (blue) background with white text. */
const ACTIVE_TAB_CLASS =
  'data-[state=active]:bg-blue-700 data-[state=active]:text-white data-[state=active]:shadow-sm';

interface Role {
  id: string;
  name: string;
}

interface Member {
  userId: string;
  userName: string;
  userEmail: string | null;
  roleId: string;
  roleName: string;
  isEmailSynced: boolean;
}

/** An "Add user" row that hasn't picked a person yet — no server call until it does. */
interface DraftRow {
  draftId: string;
}

/** One app feature and its effective on/off state, from `GET /api/workspaces/{id}/features`. */
interface FeatureFlagState {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  isOverridden: boolean;
  /** True when the feature is a sidebar section; false when it's not on the navbar. */
  navItem: boolean;
  /** Which settings tab surfaces this toggle — 'general' (Features) or 'funds'. */
  category: 'general' | 'funds';
}

function slugify(name: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `${base || 'workspace'}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Normalizes a user-typed slug (e.g. "@kenhua") into a URL-safe value
 *  ("kenhua") — strips a leading "@" handle marker and collapses anything
 *  that isn't lowercase alphanumeric into hyphens. */
function normalizeSlug(raw: string) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export default function AdminPortalPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  const [dbUsers, setDbUsers] = useState<DbUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [draftRows, setDraftRows] = useState<DraftRow[]>([]);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [editingSlug, setEditingSlug] = useState(false);
  const [slugDraft, setSlugDraft] = useState('');
  const [features, setFeatures] = useState<FeatureFlagState[]>([]);
  const [featuresLoading, setFeaturesLoading] = useState(true);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    if (!user.isSuperadmin) {
      router.replace('/workspace');
    }
  }, [user, loading, router]);

  const isAuthorized = !loading && Boolean(user?.isSuperadmin);

  // Users directory (for the member picker).
  useEffect(() => {
    if (!isAuthorized) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/users');
        if (res.status === 401) {
          router.replace('/login');
          return;
        }
        if (!res.ok) throw new Error('Failed to load users');
        const body = await res.json();
        if (!cancelled) setDbUsers(body?.data ?? []);
      } catch {
        if (!cancelled) toast.error('Could not load users');
      } finally {
        if (!cancelled) setUsersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthorized, router]);

  // Every workspace (superadmin listing, not just the caller's own memberships).
  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    try {
      const res = await fetch('/api/workspaces?all=true');
      if (!res.ok) throw new Error('Failed to load workspaces');
      const body = await res.json();
      const rows: Workspace[] = body?.data ?? [];
      setWorkspaces(rows);
      setSelectedId((prev) => prev ?? rows[0]?.id ?? null);
    } catch {
      toast.error('Could not load workspaces');
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAuthorized) return;
    loadWorkspaces();
  }, [isAuthorized, loadWorkspaces]);

  // Roles (seeded admin/editor/viewer).
  useEffect(() => {
    if (!isAuthorized) return;
    (async () => {
      try {
        const res = await fetch('/api/roles');
        if (!res.ok) throw new Error('Failed to load roles');
        const body = await res.json();
        setRoles(body?.data ?? []);
      } catch {
        toast.error('Could not load roles');
      }
    })();
  }, [isAuthorized]);

  // Per-workspace feature flags for the selected workspace.
  const loadFeatures = useCallback(async (workspaceId: string) => {
    setFeaturesLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/features`);
      if (!res.ok) throw new Error('Failed to load features');
      const body = await res.json();
      setFeatures(body?.data?.features ?? []);
    } catch {
      toast.error('Could not load features');
    } finally {
      setFeaturesLoading(false);
    }
  }, []);

  const toggleFeature = async (key: string, enabled: boolean) => {
    if (!selectedId) return;
    const label = features.find((f) => f.key === key)?.label ?? key;
    const workspaceName = selected?.name ?? 'this workspace';
    const previous = features;
    setFeatures((prev) =>
      prev.map((f) => (f.key === key ? { ...f, enabled, isOverridden: true } : f)),
    );
    try {
      const res = await fetch(`/api/workspaces/${selectedId}/features`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, enabled }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? 'Failed to update feature');
      const body = await res.json();
      setFeatures(body?.data?.features ?? previous);
      toast.success(
        `${label} is now ${enabled ? 'available' : 'unavailable'} for ${workspaceName}`,
      );
    } catch (err) {
      setFeatures(previous);
      toast.error(
        err instanceof Error
          ? err.message
          : `Could not ${enabled ? 'enable' : 'disable'} ${label} for ${workspaceName}`,
      );
    }
  };

  // Members of the selected workspace.
  const loadMembers = useCallback(async (workspaceId: string) => {
    setMembersLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/members`);
      if (!res.ok) throw new Error('Failed to load members');
      const body = await res.json();
      setMembers(body?.data ?? []);
    } catch {
      toast.error('Could not load members');
    } finally {
      setMembersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setDraftRows([]);
    loadMembers(selectedId);
    loadFeatures(selectedId);
  }, [selectedId, loadMembers, loadFeatures]);

  const usersById = useMemo(() => {
    const map = new Map<string, DbUser>();
    for (const u of dbUsers) map.set(u.id, u);
    return map;
  }, [dbUsers]);

  const selected = workspaces.find((w) => w.id === selectedId) ?? null;
  const defaultRoleName = roles.find((r) => r.name === 'editor')?.name ?? roles[0]?.name;

  // Split features across the settings tabs. The Funds tab owns its own
  // category; the Features tab shows everything else, sub-split into sidebar
  // sections vs. everything that isn't on the navbar (in-page/background flags).
  const generalFeatures = useMemo(
    () => features.filter((f) => f.category !== 'funds'),
    [features],
  );
  const navFeatures = useMemo(() => generalFeatures.filter((f) => f.navItem), [generalFeatures]);
  const nonNavFeatures = useMemo(
    () => generalFeatures.filter((f) => !f.navItem),
    [generalFeatures],
  );
  const fundFeatures = useMemo(
    () => features.filter((f) => f.category === 'funds'),
    [features],
  );

  const selectWorkspace = (id: string) => {
    setEditingName(false);
    setEditingSlug(false);
    setSelectedId(id);
  };

  const handleAddWorkspace = async () => {
    const index = workspaces.length + 1;
    const name = `Workspace ${index}`;
    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, slug: slugify(name) }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? 'Failed to create workspace');
      const { data } = await res.json();
      setWorkspaces((prev) => [...prev, data]);
      selectWorkspace(data.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create workspace');
    }
  };

  const startEditName = () => {
    if (!selected) return;
    setNameDraft(selected.name);
    setEditingSlug(false);
    setEditingName(true);
  };

  const saveName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed || !selected) {
      setEditingName(false);
      return;
    }
    try {
      const res = await fetch(`/api/workspaces/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error('Failed to rename workspace');
      setWorkspaces((prev) => prev.map((w) => (w.id === selected.id ? { ...w, name: trimmed } : w)));
    } catch {
      toast.error('Could not rename workspace');
    } finally {
      setEditingName(false);
    }
  };

  const cancelName = () => setEditingName(false);

  const startEditSlug = () => {
    if (!selected) return;
    setSlugDraft(selected.slug);
    setEditingName(false);
    setEditingSlug(true);
  };

  const saveSlug = async () => {
    const cleaned = normalizeSlug(slugDraft);
    if (!cleaned || !selected) {
      setEditingSlug(false);
      return;
    }
    try {
      const res = await fetch(`/api/workspaces/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: cleaned }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? 'Failed to update slug');
      setWorkspaces((prev) => prev.map((w) => (w.id === selected.id ? { ...w, slug: cleaned } : w)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update slug');
    } finally {
      setEditingSlug(false);
    }
  };

  const cancelSlug = () => setEditingSlug(false);

  const saveCopilotAgent = async (agent: string) => {
    if (!selected || agent === (selected.copilot_agent ?? 'mna')) return;
    const previous = workspaces;
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === selected.id ? { ...w, copilot_agent: agent } : w)),
    );
    const agentLabel = COPILOT_AGENT_OPTIONS.find((o) => o.value === agent)?.label ?? agent;
    try {
      const res = await fetch(`/api/workspaces/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ copilot_agent: agent }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? 'Failed to update Copilot');
      toast.success(`AI Copilot set to ${agentLabel} for ${selected.name}`);
    } catch (err) {
      setWorkspaces(previous);
      toast.error(
        err instanceof Error ? err.message : `Could not update AI Copilot for ${selected.name}`,
      );
    }
  };

  const saveDefaultCurrency = async (currency: string) => {
    if (!selected || currency === (selected.default_currency ?? 'USD')) return;
    const previous = workspaces;
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === selected.id ? { ...w, default_currency: currency } : w)),
    );
    const currencyLabel = CURRENCY_OPTIONS.find((o) => o.value === currency)?.label ?? currency;
    try {
      const res = await fetch(`/api/workspaces/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_currency: currency }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? 'Failed to update currency');
      toast.success(`Display currency set to ${currencyLabel} for ${selected.name}`);
    } catch (err) {
      setWorkspaces(previous);
      toast.error(
        err instanceof Error ? err.message : `Could not update currency for ${selected.name}`,
      );
    }
  };

  const assignedUserIds = useMemo(() => new Set(members.map((m) => m.userId)), [members]);
  const hasEmptyDraft = draftRows.length > 0;
  const allAssigned = dbUsers.length > 0 && assignedUserIds.size >= dbUsers.length;

  const handleAddUserRow = () => {
    setDraftRows((prev) => [...prev, { draftId: crypto.randomUUID() }]);
  };

  const removeDraftRow = (draftId: string) => {
    setDraftRows((prev) => prev.filter((r) => r.draftId !== draftId));
  };

  const selectUserForDraft = async (draftId: string, userId: string) => {
    if (!selected || !defaultRoleName) return;
    const userName = usersById.get(userId)?.name ?? 'User';
    try {
      const res = await fetch(`/api/workspaces/${selected.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, roleName: defaultRoleName }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? 'Failed to add member');
      removeDraftRow(draftId);
      await loadMembers(selected.id);
      toast.success(`${userName} added to ${selected.name}`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Could not add ${userName} to ${selected.name}`,
      );
    }
  };

  const updateMemberRole = async (userId: string, roleName: string) => {
    if (!selected) return;
    const previous = members;
    const memberName = members.find((m) => m.userId === userId)?.userName ?? 'User';
    setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, roleName } : m)));
    try {
      const res = await fetch(`/api/workspaces/${selected.id}/members/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleName }),
      });
      if (!res.ok) throw new Error('Failed to update role');
      toast.success(`${memberName} is now ${roleName} in ${selected.name}`);
    } catch {
      setMembers(previous);
      toast.error(`Could not update ${memberName}'s role in ${selected.name}`);
    }
  };

  const updateMemberEmailSync = async (userId: string, isEmailSynced: boolean) => {
    if (!selected) return;
    const previous = members;
    const memberName = members.find((m) => m.userId === userId)?.userName ?? 'User';
    setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, isEmailSynced } : m)));
    try {
      const res = await fetch(`/api/workspaces/${selected.id}/members/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isEmailSynced }),
      });
      if (!res.ok) throw new Error('Failed to update email sync');
      toast.success(
        `Email sync ${isEmailSynced ? 'enabled' : 'disabled'} for ${memberName} in ${selected.name}`,
      );
    } catch {
      setMembers(previous);
      toast.error(`Could not update email sync for ${memberName}`);
    }
  };

  const removeMember = async (userId: string) => {
    if (!selected) return;
    const previous = members;
    const memberName = members.find((m) => m.userId === userId)?.userName ?? 'User';
    setMembers((prev) => prev.filter((m) => m.userId !== userId));
    try {
      const res = await fetch(`/api/workspaces/${selected.id}/members/${userId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to remove member');
      toast.success(`${memberName} removed from ${selected.name}`);
    } catch {
      setMembers(previous);
      toast.error(`Could not remove ${memberName} from ${selected.name}`);
    }
  };

  if (loading || !user || !user.isSuperadmin) {
    return (
      <div className="relative flex min-h-screen items-center justify-center">
        <LivingBackground variant="default" />
        <Loader2 className="relative z-10 h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="relative flex h-screen flex-col text-foreground">
      <LivingBackground variant="default" />
      <header className="relative z-10 border-b border-border/60 bg-background/70 px-6 py-4 backdrop-blur-xl sm:px-8">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push('/workspace')}
            aria-label="Back to workspaces"
            className="shrink-0 text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-blue-200 to-blue-300 dark:from-blue-900 dark:to-blue-700">
            <Settings className="h-4 w-4 text-blue-700 dark:text-blue-200" />
          </div>
          <div>
            <h1 className="text-base font-extrabold tracking-tight">Workspace Configuration</h1>
            <p className="text-xs text-muted-foreground">
              Manage workspaces and member access.
            </p>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col overflow-hidden px-6 py-6 sm:px-8">
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
          {/* Workspace list */}
          <aside className="flex min-h-0 flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Workspaces
              </h2>
              <Button type="button" size="sm" variant="outline" onClick={handleAddWorkspace}>
                <Plus className="h-4 w-4" />
                Add new
              </Button>
            </div>
            {workspacesLoading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : (
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                {workspaces.map((workspace) => {
                  const isActive = workspace.id === selectedId;
                  return (
                    <button
                      key={workspace.id}
                      type="button"
                      onClick={() => selectWorkspace(workspace.id)}
                      className={cn(
                        'flex w-full items-start gap-3 rounded-xl border bg-card/80 p-3 text-left backdrop-blur-xl transition hover:border-primary/40 hover:bg-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isActive && 'border-primary/60 ring-1 ring-primary/30 border-blue-400 border-2',
                      )}
                    >
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 text-sm font-bold text-white shadow-sm">
                        {initialsFor(workspace.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold text-primary">
                          {workspace.name}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {workspace.slug}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </aside>

          {/* Configuration panel */}
          <section className="flex min-h-0 flex-col rounded-2xl border bg-card/80 shadow-sm backdrop-blur-xl">
            {selected && (
              <div className="flex min-h-0 flex-1 flex-col gap-8 p-6">
                {editingName ? (
                  <div className="space-y-1">
                    <Input
                      autoFocus
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveName();
                        if (e.key === 'Escape') cancelName();
                      }}
                      placeholder="Workspace name"
                      className="h-10 w-64 max-w-full text-xl font-bold"
                    />
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={saveName}
                        disabled={!nameDraft.trim()}
                        aria-label="Save name"
                        className="h-7 w-7 text-emerald-600 hover:text-emerald-700"
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={cancelName}
                        aria-label="Cancel"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={startEditName}
                    title="Click to rename"
                    className="w-fit border-b-2 border-border pb-1 text-left text-xl font-bold tracking-tight transition hover:border-primary/60"
                  >
                    {selected.name}
                  </button>
                )}

                {editingSlug ? (
                  <div className="-mt-6 space-y-1">
                    <Input
                      autoFocus
                      value={slugDraft}
                      onChange={(e) => setSlugDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveSlug();
                        if (e.key === 'Escape') cancelSlug();
                      }}
                      placeholder="workspace-slug"
                      className="h-8 w-64 max-w-full font-mono text-sm"
                    />
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={saveSlug}
                        disabled={!normalizeSlug(slugDraft)}
                        aria-label="Save slug"
                        className="h-7 w-7 text-emerald-600 hover:text-emerald-700"
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={cancelSlug}
                        aria-label="Cancel"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={startEditSlug}
                    title="Click to change slug"
                    className="-mt-6 w-fit text-left font-mono text-xs text-muted-foreground transition hover:text-primary"
                  >
                    {selected.slug}
                  </button>
                )}

                <Tabs defaultValue="copilot" className="flex min-h-0 flex-1 flex-col">
                  <TabsList className="w-fit">
                    <TabsTrigger value="copilot" className={ACTIVE_TAB_CLASS}>
                      General
                    </TabsTrigger>
                    <TabsTrigger value="users" className={ACTIVE_TAB_CLASS}>
                      Users
                    </TabsTrigger>
                    <TabsTrigger value="features" className={ACTIVE_TAB_CLASS}>
                      Features
                    </TabsTrigger>
                    <TabsTrigger value="funds" className={ACTIVE_TAB_CLASS}>
                      Funds
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="copilot" className="flex min-h-0 flex-col">
                    <div className="flex h-9 shrink-0 items-center">
                      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        AI Copilot
                      </h3>
                    </div>
                    <div className="mt-3 space-y-1.5">
                      <Select value={selected.copilot_agent ?? 'mna'} onValueChange={saveCopilotAgent}>
                        <SelectTrigger className="w-64 max-w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {COPILOT_AGENT_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Which Copilot flavor this workspace&apos;s chat uses — M&amp;A deal
                        analysis, funds &amp; investing, or a combined assistant with
                        access to both.
                      </p>
                    </div>
                    <div className="mt-6 flex h-9 shrink-0 items-center">
                      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        Display Currency
                      </h3>
                    </div>
                    <div className="mt-3 space-y-1.5">
                      <Select
                        value={selected.default_currency ?? 'USD'}
                        onValueChange={saveDefaultCurrency}
                      >
                        <SelectTrigger className="w-64 max-w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CURRENCY_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        The currency all money is displayed in across this workspace — Fund
                        Management and the Revenue/EBITDA/EV columns. Relabels only; stored
                        values are not converted.
                      </p>
                    </div>
                  </TabsContent>

                  <TabsContent value="users" className="mt-0 flex min-h-0 flex-col">
                    <div className="flex h-9 shrink-0 items-center justify-between">
                      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        Users
                      </h3>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={handleAddUserRow}
                        disabled={usersLoading || hasEmptyDraft || allAssigned}
                      >
                        <Plus className="h-4 w-4" />
                        {allAssigned ? 'All users added' : 'Add user'}
                      </Button>
                    </div>

                  {usersLoading || membersLoading ? (
                    <div className="mt-3 flex items-center justify-center py-8 text-muted-foreground">
                      <Loader2 className="h-5 w-5 animate-spin" />
                    </div>
                  ) : (
                    <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                      {members.length === 0 && draftRows.length === 0 && (
                        <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
                          No users yet.
                        </p>
                      )}
                      {members.map((m) => {
                        const dbUser = usersById.get(m.userId);
                        const options = dbUsers.filter((u) => !assignedUserIds.has(u.id));
                        return (
                          <div
                            key={m.userId}
                            className="grid grid-cols-1 items-center gap-3 rounded-lg border bg-background px-3 py-2 sm:grid-cols-[1fr_140px_170px_auto]"
                          >
                            <UserCombobox
                              selectedUser={dbUser ?? { id: m.userId, name: m.userName, email: m.userEmail }}
                              options={options}
                              disabled
                              onSelect={() => {}}
                            />
                            <Select
                              value={m.roleName}
                              onValueChange={(value) => updateMemberRole(m.userId, value)}
                            >
                              <SelectTrigger className="capitalize">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {roles.map((role) => (
                                  <SelectItem key={role.id} value={role.name} className="capitalize">
                                    {role.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <EmailSyncCombobox
                              value={m.isEmailSynced}
                              onChange={(next) => updateMemberEmailSync(m.userId, next)}
                            />
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`Remove ${m.userName}`}
                                  className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                                >
                                  <Minus className="h-4 w-4" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Remove member</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    Are you sure you want to remove {m.userName} from{' '}
                                    {selected?.name}? They will lose access to this
                                    workspace immediately.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => removeMember(m.userId)}
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  >
                                    Remove
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        );
                      })}
                      {draftRows.map((draft) => {
                        const options = dbUsers.filter((u) => !assignedUserIds.has(u.id));
                        return (
                          <div
                            key={draft.draftId}
                            className="grid grid-cols-1 items-center gap-3 rounded-lg border bg-background px-3 py-2 sm:grid-cols-[1fr_140px_170px_auto]"
                          >
                            <UserCombobox
                              selectedUser={null}
                              options={options}
                              onSelect={(userId) => selectUserForDraft(draft.draftId, userId)}
                            />
                            <Select value={defaultRoleName} disabled>
                              <SelectTrigger className="capitalize">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {roles.map((role) => (
                                  <SelectItem key={role.id} value={role.name} className="capitalize">
                                    {role.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <EmailSyncCombobox value={false} onChange={() => {}} disabled />
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              onClick={() => removeDraftRow(draft.draftId)}
                              aria-label="Remove row"
                              className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                            >
                              <Minus className="h-4 w-4" />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  </TabsContent>

                  <TabsContent value="features" className="mt-0 flex min-h-0 flex-col">
                    <div className="flex h-9 shrink-0 items-center">
                      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        Features
                      </h3>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Turn features on or off for{' '}
                      <span className="font-medium text-foreground">{selected.name}</span>. Only
                      affects this workspace.
                    </p>
                    {featuresLoading ? (
                      <div className="mt-3 flex items-center justify-center py-8 text-muted-foreground">
                        <Loader2 className="h-5 w-5 animate-spin" />
                      </div>
                    ) : features.length === 0 ? (
                      <p className="mt-3 rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
                        No features available.
                      </p>
                    ) : (
                      <div className="mt-3 min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
                        <FeatureToggleList
                          features={navFeatures}
                          onToggle={toggleFeature}
                          emptyLabel="No navigation features."
                        />
                        {nonNavFeatures.length > 0 && (
                          <div className="space-y-2">
                            <div className="border-t pt-4">
                              <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                                Other features
                              </h4>
                              <p className="mt-1 text-xs text-muted-foreground">
                                Not shown on the navbar — in-page flags and background behaviours.
                              </p>
                            </div>
                            <FeatureToggleList
                              features={nonNavFeatures}
                              onToggle={toggleFeature}
                              emptyLabel="No non-navbar features."
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="funds" className="mt-0 flex min-h-0 flex-col">
                    <div className="flex h-9 shrink-0 items-center">
                      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        Funds
                      </h3>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Fund-management settings for{' '}
                      <span className="font-medium text-foreground">{selected.name}</span>. Only
                      affects this workspace.
                    </p>
                    {featuresLoading ? (
                      <div className="mt-3 flex items-center justify-center py-8 text-muted-foreground">
                        <Loader2 className="h-5 w-5 animate-spin" />
                      </div>
                    ) : (
                      <div className="mt-3 min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
                        <FeatureToggleList
                          features={fundFeatures}
                          onToggle={toggleFeature}
                          emptyLabel="No fund settings available."
                        />
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

/** Searchable user picker for a membership row. Shows name with the email
 *  stacked beneath it in smaller text, both in the trigger and the options. */
function UserCombobox({
  selectedUser,
  options,
  onSelect,
  disabled = false,
}: {
  selectedUser: DbUser | null;
  options: DbUser[];
  onSelect: (userId: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="flex min-h-[3rem] w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-left ring-offset-background transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
        >
          {selectedUser ? (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{selectedUser.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {selectedUser.email ?? '—'}
              </span>
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">Select user…</span>
          )}
          {!disabled && <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command>
          <CommandInput placeholder="Search users…" />
          <CommandList>
            <CommandEmpty>No users found.</CommandEmpty>
            <CommandGroup>
              {options.map((u) => (
                <CommandItem
                  key={u.id}
                  value={`${u.name} ${u.email ?? ''}`}
                  onSelect={() => {
                    onSelect(u.id);
                    setOpen(false);
                  }}
                  className="group"
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4 shrink-0',
                      selectedUser?.id === u.id ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{u.name}</span>
                    <span className="block truncate text-xs text-muted-foreground group-data-[selected=true]:text-accent-foreground/80">
                      {u.email ?? '—'}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const EMAIL_SYNC_OPTIONS: { value: boolean; label: string; hint: string }[] = [
  { value: true, label: 'Sync', hint: 'Mailbox scanned for this workspace' },
  { value: false, label: "Don't sync", hint: 'Mailbox not scanned' },
];

/** Per-member email-sync picker. Sets whether this member's mailbox is the
 *  scanned ("synced") custodian mailbox for the workspace — backed by
 *  `user_workspaces.is_email_synced`, which `findWorkspaceIdsBySyncedEmail`
 *  uses to resolve fan-out targets for CRM email ingest. */
function EmailSyncCombobox({
  value,
  onChange,
  disabled = false,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = EMAIL_SYNC_OPTIONS.find((o) => o.value === value) ?? EMAIL_SYNC_OPTIONS[1];

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label="Email sync"
          disabled={disabled}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm ring-offset-background transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Mail
              className={cn(
                'h-4 w-4 shrink-0',
                value ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
              )}
            />
            <span className="truncate">{current.label}</span>
          </span>
          {!disabled && <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-56 p-0"
      >
        <Command>
          <CommandList>
            <CommandGroup>
              {EMAIL_SYNC_OPTIONS.map((option) => (
                <CommandItem
                  key={String(option.value)}
                  value={option.label}
                  onSelect={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className="group gap-2"
                >
                  <Check
                    className={cn(
                      'h-4 w-4 shrink-0',
                      option.value === value ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm">{option.label}</span>
                    <span className="text-xs text-muted-foreground group-data-[selected=true]:text-accent-foreground">
                      {option.hint}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Renders a group of feature rows with per-feature on/off switches. */
function FeatureToggleList({
  features,
  onToggle,
  emptyLabel,
}: {
  features: FeatureFlagState[];
  onToggle: (key: string, enabled: boolean) => void;
  emptyLabel: string;
}) {
  if (features.length === 0) {
    return (
      <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {features.map((feature) => (
        <div
          key={feature.key}
          className="flex items-center justify-between gap-4 rounded-lg border bg-background px-4 py-3"
        >
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium">{feature.label}</span>
            <p className="mt-0.5 text-xs text-muted-foreground">{feature.description}</p>
          </div>
          <Switch
            checked={feature.enabled}
            onCheckedChange={(next) => onToggle(feature.key, next)}
            aria-label={`Toggle ${feature.label}`}
          />
        </div>
      ))}
    </div>
  );
}
