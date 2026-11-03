'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { consentUrlWithCallback } from '@/lib/callbackUrl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
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
import { UserManagementSection } from './UserManagementSection';
import { GmailIcon, MeetingIntelligenceIcon } from '@/components/integrations/AppIcons';
import {
  Loader2,
  ArrowLeft,
  Plus,
  Settings,
  Check,
  ChevronsUpDown,
  Mail,
  X,
  Trash2,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Archive,
  MoreVertical,
  UserMinus,
  CheckCircle2,
  XCircle,
  MailX,
} from 'lucide-react';
import { COPILOT_AGENT_KEYS, COPILOT_AGENT_LABELS } from '@/lib/agents/analysis/flavors/keys';
import {
  DEFAULT_PPTX_TEMPLATE,
  PPTX_TEMPLATE_IDS,
  PPTX_TEMPLATE_LABELS,
} from '@/lib/pptx/templates/catalog';

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
  /** PowerPoint template every generated deck adheres to. */
  pptx_template?: string;
  /** Non-null once the workspace has been soft-deleted (archived). Only ever
   *  populated here — `GET /api/workspaces?all=true` is the one listing that
   *  returns archived rows, and only to a superadmin. */
  deleted_at?: string | null;
}

/** The AI Copilot flavors, in registry order. */
const COPILOT_AGENT_OPTIONS: { value: string; label: string }[] = COPILOT_AGENT_KEYS.map((value) => ({
  value,
  label: COPILOT_AGENT_LABELS[value],
}));

/** The display currencies, mirrored from the server's WORKSPACE_CURRENCIES. */
const CURRENCY_OPTIONS: { value: string; label: string }[] = [
  { value: 'USD', label: 'USD ($)' },
  { value: 'IDR', label: 'IDR (Rp)' },
  { value: 'CNY', label: 'CNY (RMB)' },
];

/** The PowerPoint templates, mirrored from the server's WORKSPACE_PPTX_TEMPLATES. */
const PPTX_TEMPLATE_OPTIONS: { value: string; label: string }[] = PPTX_TEMPLATE_IDS.map((value) => ({
  value,
  label: PPTX_TEMPLATE_LABELS[value],
}));

/** Active tab: primary (blue) background with white text. */
const ACTIVE_TAB_CLASS =
  'data-[state=active]:bg-blue-700 data-[state=active]:text-white data-[state=active]:shadow-sm';

/** Shared column layout for the member header and rows — kept narrow so the
 *  remove button never gets pushed past the panel's right edge. */
const MEMBER_ROW_GRID = 'sm:grid-cols-[minmax(0,1fr)_auto_32px_32px_36px]';

/** Per-user integrations shown on each member row, in display order. Add an
 *  entry (and its key on `MemberConnectedApps`) when a new connector ships. */
const MEMBER_CONNECTORS = [
  { key: 'meetingIntelligence', name: 'MoM Intelligent', Icon: MeetingIntelligenceIcon },
  { key: 'gmail', name: 'Gmail', Icon: GmailIcon },
] as const;

type MemberConnectorKey = (typeof MEMBER_CONNECTORS)[number]['key'];

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
  hasConsented: boolean;
  connectedApps: Record<MemberConnectorKey, boolean>;
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
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [editingSlug, setEditingSlug] = useState(false);
  const [slugDraft, setSlugDraft] = useState('');
  const [features, setFeatures] = useState<FeatureFlagState[]>([]);
  const [featuresLoading, setFeaturesLoading] = useState(true);
  // The archived section starts collapsed — it's a recovery affordance, not
  // part of the day-to-day list.
  const [showDeleted, setShowDeleted] = useState(false);
  const [workspaceMgmtExpanded, setWorkspaceMgmtExpanded] = useState(true);
  const [archivePending, setArchivePending] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [addMemberUserId, setAddMemberUserId] = useState<string | null>(null);
  const [addMemberRoleName, setAddMemberRoleName] = useState<string | undefined>(undefined);
  const [addMemberPending, setAddMemberPending] = useState(false);
  /** Row whose ⋮ menu is open, and the member awaiting remove confirmation. */
  const [memberMenuUserId, setMemberMenuUserId] = useState<string | null>(null);
  const [memberToRemove, setMemberToRemove] = useState<Member | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    if (!user.isSuperadmin) {
      router.replace('/workspace');
      return;
    }
    // Superadmins reach this page directly (bypassing the /workspace picker,
    // which they're allowed to skip past — see that page's auto-select
    // effect), so the consent gate has to be re-checked here too.
    if (!user.hasConsented) {
      router.replace(consentUrlWithCallback('/admin-portal'));
    }
  }, [user, loading, router]);

  const isAuthorized = !loading && Boolean(user?.isSuperadmin) && Boolean(user?.hasConsented);

  // Users directory (for the member picker). Re-run whenever the User
  // Management section changes the directory (e.g. after inviting someone),
  // so a newly invited user can be added to a workspace without a reload.
  // The sequence ref drops a slower, superseded response.
  const usersRequestSeqRef = useRef(0);
  const loadDbUsers = useCallback(async () => {
    const seq = ++usersRequestSeqRef.current;
    try {
      // scope=all: the member picker must offer users who are not yet in
      // the workspace, so it needs the global directory rather than the
      // workspace-scoped default.
      const res = await fetch('/api/users?scope=all');
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) throw new Error('Failed to load users');
      const body = await res.json();
      if (seq === usersRequestSeqRef.current) setDbUsers(body?.data ?? []);
    } catch {
      if (seq === usersRequestSeqRef.current) toast.error('Could not load users');
    } finally {
      if (seq === usersRequestSeqRef.current) setUsersLoading(false);
    }
  }, [router]);

  useEffect(() => {
    if (!isAuthorized) return;
    loadDbUsers();
  }, [isAuthorized, loadDbUsers]);

  // Every workspace (superadmin listing, not just the caller's own memberships).
  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    try {
      const res = await fetch('/api/workspaces?all=true');
      if (!res.ok) throw new Error('Failed to load workspaces');
      const body = await res.json();
      const rows: Workspace[] = body?.data ?? [];
      setWorkspaces(rows);
      // Land on a live workspace, never an archived one — the archived
      // section is collapsed by default, so auto-selecting one would show a
      // config panel with no visibly selected row.
      setSelectedId((prev) => prev ?? rows.find((w) => !w.deleted_at)?.id ?? rows[0]?.id ?? null);
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
  // The latest requested workspace — a slower response for a workspace the
  // admin already switched away from must not overwrite the roster.
  const membersRequestWorkspaceRef = useRef<string | null>(null);
  const loadMembers = useCallback(async (workspaceId: string) => {
    membersRequestWorkspaceRef.current = workspaceId;
    const isLatest = () => membersRequestWorkspaceRef.current === workspaceId;
    setMembersLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/members`);
      if (!res.ok) throw new Error('Failed to load members');
      const body = await res.json();
      if (isLatest()) setMembers(body?.data ?? []);
    } catch {
      if (isLatest()) toast.error('Could not load members');
    } finally {
      if (isLatest()) setMembersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setAddMemberOpen(false);
    setMemberMenuUserId(null);
    setMemberToRemove(null);
    loadMembers(selectedId);
    loadFeatures(selectedId);
  }, [selectedId, loadMembers, loadFeatures]);

  // The User Management section changed the directory: refresh the member
  // picker, and the selected workspace's members (a rename shows there, and a
  // hard delete cascades the membership away).
  const handleUsersChanged = useCallback(() => {
    loadDbUsers();
    if (selectedId) loadMembers(selectedId);
  }, [loadDbUsers, loadMembers, selectedId]);

  const usersById = useMemo(() => {
    const map = new Map<string, DbUser>();
    for (const u of dbUsers) map.set(u.id, u);
    return map;
  }, [dbUsers]);

  const selected = workspaces.find((w) => w.id === selectedId) ?? null;
  const isSelectedDeleted = Boolean(selected?.deleted_at);
  const defaultRoleName = roles.find((r) => r.name === 'editor')?.name ?? roles[0]?.name;

  // Archived workspaces are listed separately, underneath the live ones, and
  // only for a superadmin. The page already bounces non-superadmins, but the
  // flag is re-read here so the section can never render for anyone else.
  // Both lists are alphabetical by name, matching the workspace selector.
  const activeWorkspaces = useMemo(
    () =>
      workspaces
        .filter((w) => !w.deleted_at)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [workspaces],
  );
  const deletedWorkspaces = useMemo(
    () =>
      workspaces
        .filter((w) => w.deleted_at)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [workspaces],
  );
  const canSeeDeleted = Boolean(user?.isSuperadmin);

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

  /** Archive the selected workspace. Superadmin-only on the server too. */
  const handleDeleteWorkspace = async () => {
    if (!selected) return;
    const target = selected;
    setArchivePending(true);
    try {
      const res = await fetch(`/api/workspaces/${target.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json())?.error ?? 'Failed to delete workspace');
      const { data } = await res.json();
      setWorkspaces((prev) => prev.map((w) => (w.id === target.id ? { ...w, ...data } : w)));
      // Keep the archived workspace selected (and reveal the section it just
      // moved into) so the reinstate button is one click away if this was a
      // mistake.
      setShowDeleted(true);
      setEditingName(false);
      setEditingSlug(false);
      toast.success(`${target.name} deleted — members can no longer access it`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete workspace');
    } finally {
      setArchivePending(false);
    }
  };

  /** Reinstate an archived workspace, data and memberships intact. */
  const handleRestoreWorkspace = async () => {
    if (!selected) return;
    const target = selected;
    setArchivePending(true);
    try {
      const res = await fetch(`/api/workspaces/${target.id}/restore`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json())?.error ?? 'Failed to reinstate workspace');
      const { data } = await res.json();
      setWorkspaces((prev) => prev.map((w) => (w.id === target.id ? { ...w, ...data } : w)));
      toast.success(`${target.name} reinstated`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reinstate workspace');
    } finally {
      setArchivePending(false);
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

  const savePptxTemplate = async (template: string) => {
    if (!selected || template === (selected.pptx_template ?? DEFAULT_PPTX_TEMPLATE)) return;
    const previous = workspaces;
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === selected.id ? { ...w, pptx_template: template } : w)),
    );
    const templateLabel =
      PPTX_TEMPLATE_OPTIONS.find((o) => o.value === template)?.label ?? template;
    try {
      const res = await fetch(`/api/workspaces/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pptx_template: template }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? 'Failed to update template');
      toast.success(`PowerPoint template set to ${templateLabel} for ${selected.name}`);
    } catch (err) {
      setWorkspaces(previous);
      toast.error(
        err instanceof Error
          ? err.message
          : `Could not update PowerPoint template for ${selected.name}`,
      );
    }
  };

  const assignedUserIds = useMemo(() => new Set(members.map((m) => m.userId)), [members]);
  const connectorTotals = useMemo(
    () =>
      MEMBER_CONNECTORS.map((connector) => ({
        ...connector,
        connected: members.filter((m) => m.connectedApps?.[connector.key]).length,
      })),
    [members],
  );
  const allAssigned = dbUsers.length > 0 && assignedUserIds.size >= dbUsers.length;

  const openAddMemberDialog = () => {
    setAddMemberUserId(null);
    setAddMemberRoleName(defaultRoleName);
    setAddMemberOpen(true);
  };

  const handleAddMember = async () => {
    if (!selected || !addMemberUserId || !addMemberRoleName) return;
    const userId = addMemberUserId;
    const roleName = addMemberRoleName;
    const userName = usersById.get(userId)?.name ?? 'User';
    setAddMemberPending(true);
    try {
      const res = await fetch(`/api/workspaces/${selected.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, roleName }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? 'Failed to add member');
      await loadMembers(selected.id);
      setAddMemberOpen(false);
      toast.success(`${userName} added to ${selected.name}`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Could not add ${userName} to ${selected.name}`,
      );
    } finally {
      setAddMemberPending(false);
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

  if (loading || !user || !user.isSuperadmin || !user.hasConsented) {
    return (
      <div className="relative flex min-h-screen items-center justify-center">
        <Loader2 className="relative z-10 h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="relative flex h-screen flex-col text-foreground">
      <header className="relative z-10 border-b border-border/60 bg-background px-6 py-4 sm:px-8">
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
            <h1 className="text-base font-extrabold tracking-tight">Admin Portal</h1>
            <p className="text-xs text-muted-foreground">
              Manage users and workspaces.
            </p>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-6 overflow-y-auto px-6 py-6 sm:px-8">
        <UserManagementSection currentUserId={user?.id} onUsersChanged={handleUsersChanged} />

        <div className="shrink-0 rounded-2xl border bg-card shadow-sm">
          <button
            type="button"
            onClick={() => setWorkspaceMgmtExpanded((prev) => !prev)}
            aria-expanded={workspaceMgmtExpanded}
            className="flex w-full items-center justify-between gap-3 p-4 text-left"
          >
            <div className="flex items-center gap-3">
              <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-blue-200 to-blue-300 dark:from-blue-900 dark:to-blue-700">
                <Settings className="h-4 w-4 text-blue-700 dark:text-blue-200" />
              </div>
              <div>
                <h2 className="text-sm font-extrabold tracking-tight">Workspace Configuration</h2>
                <p className="text-xs text-muted-foreground">
                  Manage workspaces and member access.
                </p>
              </div>
            </div>
            {workspaceMgmtExpanded ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
          </button>

          {workspaceMgmtExpanded && (
            <div className="grid grid-cols-1 gap-6 border-t p-4 lg:h-[1200px] lg:grid-cols-[320px_1fr]">
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
                {activeWorkspaces.map((workspace) => (
                  <WorkspaceListItem
                    key={workspace.id}
                    workspace={workspace}
                    isSelected={workspace.id === selectedId}
                    onSelect={selectWorkspace}
                  />
                ))}

                {/* Deleted workspaces live underneath the live ones, behind a
                    collapsed disclosure, and only for a superadmin — they're
                    the only role allowed to see, delete, or reinstate one. */}
                {canSeeDeleted && deletedWorkspaces.length > 0 && (
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => setShowDeleted((prev) => !prev)}
                      aria-expanded={showDeleted}
                      className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {showDeleted ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                      Deleted ({deletedWorkspaces.length})
                    </button>
                    {showDeleted && (
                      <div className="mt-2 space-y-2">
                        {deletedWorkspaces.map((workspace) => (
                          <WorkspaceListItem
                            key={workspace.id}
                            workspace={workspace}
                            isSelected={workspace.id === selectedId}
                            onSelect={selectWorkspace}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
              </aside>

              {/* Configuration panel */}
              <section className="relative flex min-h-0 flex-col rounded-2xl border bg-card shadow-sm">
            {selected && !isSelectedDeleted && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={archivePending}
                    aria-label={`Delete ${selected.name}`}
                    className="absolute right-4 top-4 z-10 h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    {archivePending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete workspace</AlertDialogTitle>
                    <AlertDialogDescription>
                      Delete {selected.name}? Its members lose access immediately and it
                      disappears from their workspace list. Nothing is erased — the workspace
                      keeps its data and its slug, and you can reinstate it from the Deleted
                      section at any time.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDeleteWorkspace}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
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
                    disabled={isSelectedDeleted}
                    title={isSelectedDeleted ? 'Reinstate the workspace to edit it' : 'Click to rename'}
                    className="w-fit border-b-2 border-border pb-1 text-left text-xl font-bold tracking-tight transition hover:border-primary/60 disabled:cursor-default disabled:border-transparent disabled:text-muted-foreground"
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
                    disabled={isSelectedDeleted}
                    title={
                      isSelectedDeleted
                        ? 'A deleted workspace keeps its slug — reinstate it to change it'
                        : 'Click to change slug'
                    }
                    className="-mt-6 w-fit text-left font-mono text-xs text-muted-foreground transition hover:text-primary disabled:cursor-default disabled:hover:text-muted-foreground"
                  >
                    {selected.slug}
                  </button>
                )}

                {isSelectedDeleted && (
                  /* Archived state: the settings tabs below are hidden, so this
                     banner is the whole panel — say what's true of the
                     workspace and offer the one action that applies. */
                  <div className="space-y-4 rounded-xl border border-destructive/30 bg-muted p-5">
                    <div className="flex items-start gap-3">
                      <Archive className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                      <div className="space-y-1">
                        <h3 className="text-sm font-semibold">This workspace is deleted</h3>
                        <p className="text-xs text-muted-foreground">
                          Members can no longer open it — anyone visiting{' '}
                          <span className="font-mono">/w/{selected.slug}</span> is sent back to the
                          workspace selector, and it no longer appears in anyone&apos;s workspace
                          list. Nothing has been erased: its data, members and slug are all kept,
                          and reinstating brings it back exactly as it was.
                        </p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleRestoreWorkspace}
                      disabled={archivePending}
                      className="w-fit"
                    >
                      {archivePending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RotateCcw className="h-4 w-4" />
                      )}
                      Reinstate workspace
                    </Button>
                  </div>
                )}

                {!isSelectedDeleted && (
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
                        analysis, funds &amp; investing, a combined assistant with access to
                        both, VC / growth equity, a portfolio manager running many small
                        minority stakes, the crowdfunding agent for small-ticket MSME and
                        project raises, the investment banking advisory agent that compares exit
                        routes (sale, IPO, bond issuance, strategic partnership), or the capital
                        markets agent for debt and equity issuance.
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
                    <div className="mt-6 flex h-9 shrink-0 items-center">
                      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        PowerPoint Template
                      </h3>
                    </div>
                    <div className="mt-3 space-y-1.5">
                      <Select
                        value={selected.pptx_template ?? DEFAULT_PPTX_TEMPLATE}
                        onValueChange={savePptxTemplate}
                      >
                        <SelectTrigger
                          className="w-64 max-w-full"
                          aria-label="PowerPoint template"
                          data-testid="pptx-template-select"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PPTX_TEMPLATE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        The template every PowerPoint generated for this workspace follows —
                        Copilot presentations and the Company Card export. StarCapital builds
                        decks on the StarCapital master: logo, layouts, palette, Arial and the
                        confidentiality footer.
                      </p>
                    </div>
                  </TabsContent>

                  <TabsContent value="users" className="mt-0 flex min-h-0 flex-col">
                    <div className="flex h-9 shrink-0 items-center justify-between">
                      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        Users
                      </h3>
                      <Dialog
                        open={addMemberOpen}
                        onOpenChange={(open) => {
                          if (!open && addMemberPending) return;
                          setAddMemberOpen(open);
                        }}
                      >
                        <DialogTrigger asChild>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={openAddMemberDialog}
                            disabled={usersLoading || allAssigned}
                          >
                            <Plus className="h-4 w-4" />
                            {allAssigned ? 'All users added' : 'Add user'}
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Add user to {selected.name}</DialogTitle>
                            <DialogDescription>
                              Pick an existing user and the role they&apos;ll have in this
                              workspace.
                            </DialogDescription>
                          </DialogHeader>
                          <div className="space-y-3">
                            <div className="space-y-1.5">
                              <Label>User</Label>
                              <UserCombobox
                                selectedUser={
                                  addMemberUserId ? usersById.get(addMemberUserId) ?? null : null
                                }
                                options={dbUsers.filter((u) => !assignedUserIds.has(u.id))}
                                onSelect={setAddMemberUserId}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label>Role</Label>
                              <Select value={addMemberRoleName} onValueChange={setAddMemberRoleName}>
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
                            </div>
                          </div>
                          <DialogFooter>
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => setAddMemberOpen(false)}
                              disabled={addMemberPending}
                            >
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              onClick={handleAddMember}
                              disabled={addMemberPending || !addMemberUserId || !addMemberRoleName}
                            >
                              {addMemberPending ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Plus className="h-4 w-4" />
                              )}
                              Add
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </div>

                    {usersLoading || membersLoading ? (
                    <div className="mt-3 flex items-center justify-center py-8 text-muted-foreground">
                      <Loader2 className="h-5 w-5 animate-spin" />
                    </div>
                    ) : (
                    <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
                      {members.length > 0 && (
                        <div
                          className="mb-3 flex flex-wrap items-center gap-2"
                          data-testid="member-connector-totals"
                        >
                          {connectorTotals.map(({ key, name, Icon, connected }) => (
                            <span
                              key={key}
                              className="inline-flex items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-xs"
                            >
                              <Icon className="h-4 w-4 shrink-0" />
                              <span className="font-medium">{name}</span>
                              <span className="tabular-nums text-muted-foreground">
                                {connected}/{members.length} connected
                              </span>
                            </span>
                          ))}
                        </div>
                      )}
                      {members.length > 0 && (
                        <div
                          className={cn(
                            'hidden items-center gap-2 px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:grid',
                            MEMBER_ROW_GRID,
                          )}
                        >
                          <span>Name</span>
                          <span className="flex">
                            {MEMBER_CONNECTORS.map(({ key, name, Icon }) => (
                              <span key={key} className="flex w-9 justify-center" title={name}>
                                <Icon className="h-4 w-4" />
                                <span className="sr-only">{name}</span>
                              </span>
                            ))}
                          </span>
                          <span className="text-center">Role</span>
                          <span className="text-center">Sync</span>
                          <span />
                        </div>
                      )}
                      <div className="space-y-2">
                      {members.length === 0 && (
                        <p className="rounded-lg border border-dashed bg-muted py-6 text-center text-sm text-muted-foreground">
                          No users yet.
                        </p>
                      )}
                      {members.map((m) => {
                        const dbUser = usersById.get(m.userId);
                        const options = dbUsers.filter((u) => !assignedUserIds.has(u.id));
                        return (
                          <div
                            key={m.userId}
                            className={cn(
                              'grid grid-cols-1 items-center gap-2 rounded-lg border bg-background px-3 py-2',
                              MEMBER_ROW_GRID,
                            )}
                          >
                            <UserCombobox
                              selectedUser={dbUser ?? { id: m.userId, name: m.userName, email: m.userEmail }}
                              options={options}
                              disabled
                              onSelect={() => {}}
                            />
                            <div className="flex">
                              {MEMBER_CONNECTORS.map(({ key, name, Icon }) => (
                                <ConnectorStatusIcon
                                  key={key}
                                  name={name}
                                  Icon={Icon}
                                  connected={!!m.connectedApps?.[key]}
                                />
                              ))}
                            </div>
                            <RoleIndicator roleName={m.roleName} />
                            <EmailSyncIndicator
                              isEmailSynced={m.isEmailSynced}
                              hasConsented={m.hasConsented}
                            />
                            <Popover
                              open={memberMenuUserId === m.userId}
                              onOpenChange={(open) => setMemberMenuUserId(open ? m.userId : null)}
                            >
                              <PopoverTrigger asChild>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`Manage ${m.userName}`}
                                  className="h-9 w-9 shrink-0 text-muted-foreground"
                                >
                                  <MoreVertical className="h-4 w-4" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent align="end" className="w-64 space-y-3">
                                <div className="space-y-1.5">
                                  <Label>Role</Label>
                                  <Select
                                    value={m.roleName}
                                    onValueChange={(value) => updateMemberRole(m.userId, value)}
                                  >
                                    <SelectTrigger className="capitalize" aria-label="Role">
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
                                </div>
                                <div className="space-y-1.5">
                                  <div className="flex items-center justify-between gap-2">
                                    <Label>Email sync</Label>
                                    <Badge
                                      variant={
                                        !m.isEmailSynced ? 'outline' : m.hasConsented ? 'default' : 'secondary'
                                      }
                                    >
                                      {!m.isEmailSynced ? 'Not required' : m.hasConsented ? 'Consented' : 'Pending'}
                                    </Badge>
                                  </div>
                                  <EmailSyncCombobox
                                    value={m.isEmailSynced}
                                    onChange={(next) => updateMemberEmailSync(m.userId, next)}
                                  />
                                </div>
                                <div className="border-t pt-3">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="w-full justify-start gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                    onClick={() => {
                                      setMemberMenuUserId(null);
                                      setMemberToRemove(m);
                                    }}
                                  >
                                    <UserMinus className="h-4 w-4" />
                                    Remove from workspace
                                  </Button>
                                </div>
                              </PopoverContent>
                            </Popover>
                          </div>
                        );
                      })}
                      </div>
                      {/* One confirm dialog for the list, outside the row menu — a dialog
                          inside the popover would unmount as the popover closes. */}
                      <AlertDialog
                        open={!!memberToRemove}
                        onOpenChange={(open) => {
                          if (!open) setMemberToRemove(null);
                        }}
                      >
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove member</AlertDialogTitle>
                            <AlertDialogDescription>
                              Are you sure you want to remove {memberToRemove?.userName} from{' '}
                              {selected?.name}? They will lose access to this workspace
                              immediately.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => {
                                if (memberToRemove) removeMember(memberToRemove.userId);
                              }}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Remove
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
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
                )}
              </div>
            )}
              </section>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/** One row in the workspace sidebar. A deleted workspace renders muted, with
 *  a "Deleted" badge, so the archived section reads as archived at a glance
 *  rather than looking like a second list of live workspaces. */
function WorkspaceListItem({
  workspace,
  isSelected,
  onSelect,
}: {
  workspace: Workspace;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const isDeleted = Boolean(workspace.deleted_at);
  return (
    <button
      type="button"
      onClick={() => onSelect(workspace.id)}
      className={cn(
        'flex w-full items-start gap-3 rounded-xl border bg-card p-3 text-left transition hover:border-primary/40 hover:bg-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isSelected && 'border-primary/60 ring-1 ring-primary/30 border-blue-400 border-2',
      )}
    >
      <span
        className={cn(
          'grid h-11 w-11 shrink-0 place-items-center rounded-lg text-sm font-bold text-white shadow-sm',
          isDeleted
            ? 'bg-muted-foreground/60'
            : 'bg-gradient-to-br from-blue-500 to-blue-600',
        )}
      >
        {initialsFor(workspace.name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span
            className={cn(
              'block truncate text-sm font-bold',
              isDeleted ? 'text-muted-foreground line-through' : 'text-primary',
            )}
          >
            {workspace.name}
          </span>
          {isDeleted && (
            <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
              Deleted
            </Badge>
          )}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{workspace.slug}</span>
      </span>
    </button>
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
        // This combobox is also used inside the "Add user" Dialog, where the
        // popover content is portalled outside the dialog — so the dialog's
        // scroll lock would otherwise swallow wheel/touch events over the
        // option list. See EntityCombobox for the same fix.
        onWheel={(event) => event.stopPropagation()}
        onTouchMove={(event) => event.stopPropagation()}
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

/** One connector's logo with a check / cross badge for whether this member connected it. */
function ConnectorStatusIcon({
  name,
  Icon,
  connected,
}: {
  name: string;
  Icon: ComponentType<{ className?: string }>;
  connected: boolean;
}) {
  const label = `${name}: ${connected ? 'connected' : 'not connected'}`;
  const Status = connected ? CheckCircle2 : XCircle;
  return (
    <span className="flex w-9 justify-center" title={label} aria-label={label} role="img">
      <span
        className={cn(
          'relative flex h-7 w-7 items-center justify-center rounded-md border',
          connected
            ? 'border-emerald-300 bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950'
            : 'bg-muted',
        )}
      >
        <Icon className={cn('h-4 w-4', !connected && 'opacity-40 grayscale')} />
        <Status
          className={cn(
            'absolute -bottom-1 -right-1 h-3 w-3 rounded-full bg-background',
            connected ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
          )}
        />
      </span>
    </span>
  );
}

/** A member's role as its initial (Admin → A, Editor → E, Viewer → V); full name on hover. */
function RoleIndicator({ roleName }: { roleName: string }) {
  return (
    <span
      className="mx-auto flex h-7 w-7 items-center justify-center rounded-md border bg-muted text-xs font-semibold"
      title={`Role: ${roleName}`}
      aria-label={`Role: ${roleName}`}
    >
      {roleName.charAt(0).toUpperCase()}
    </span>
  );
}

/** Email sync as an icon: synced (green, amber while consent is pending) or not synced. */
function EmailSyncIndicator({
  isEmailSynced,
  hasConsented,
}: {
  isEmailSynced: boolean;
  hasConsented: boolean;
}) {
  const label = !isEmailSynced
    ? "Email sync: don't sync"
    : hasConsented
      ? 'Email sync: on (consented)'
      : 'Email sync: on (consent pending)';
  const Status = isEmailSynced ? Mail : MailX;
  return (
    <span className="flex justify-center" title={label} aria-label={label} role="img">
      <span
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-md border',
          !isEmailSynced
            ? 'bg-muted text-muted-foreground'
            : hasConsented
              ? 'border-emerald-300 bg-emerald-100 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
              : 'border-amber-300 bg-amber-100 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300',
        )}
      >
        <Status className="h-4 w-4" />
      </span>
    </span>
  );
}

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
