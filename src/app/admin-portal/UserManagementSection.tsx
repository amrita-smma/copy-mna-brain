'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  createUser,
  deactivateUser,
  listAllUsersForAdmin,
  reactivateUser,
  sendResetLink,
  updateUser,
  type AdminUser,
} from '@/lib/api/adminUsers';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mail,
  MoreVertical,
  RotateCcw,
  Search,
  UserPlus,
  Users as UsersIcon,
  UserX,
  X,
} from 'lucide-react';

const PAGE_SIZE = 10;

function initialsFor(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0]!.toUpperCase())
      .join('') || '?'
  );
}

interface EditState {
  id: string;
  field: 'name' | 'email';
  draft: string;
}

/**
 * Superadmin-only global user directory, rendered above the per-workspace
 * "Workspace Configuration" panel. Backed by `PATCH/DELETE /api/users/[id]`,
 * `POST /api/users/[id]/reactivate`, and `POST /api/users/[id]/send-reset-link`
 * — all session-gated superadmin routes (see `.claude/rules/api-routes.md`
 * and `src/lib/services/userService.ts`).
 *
 * "Remove" was deliberately merged into "Deactivate": a real hard delete can
 * fail outright (a user who has cast a vote is FK-`restrict`-protected) and
 * silently cascades away workspace memberships/chat history/consents for
 * everyone else. Deactivating instead mirrors the workspace archive/reinstate
 * pattern — reversible, no data loss, no FK risk.
 */
export function UserManagementSection({ currentUserId }: { currentUserId?: string }) {
  const [expanded, setExpanded] = useState(true);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDeactivated, setShowDeactivated] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createEmail, setCreateEmail] = useState('');
  const [createPending, setCreatePending] = useState(false);

  const [editing, setEditing] = useState<EditState | null>(null);

  const load = async () => {
    try {
      const data = await listAllUsersForAdmin();
      setUsers(data);
    } catch {
      toast.error('Could not load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const activeUsers = useMemo(() => users.filter((u) => !u.deactivated_at), [users]);
  const deactivatedUsers = useMemo(() => users.filter((u) => u.deactivated_at), [users]);

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredActiveUsers = useMemo(() => {
    if (!normalizedQuery) return activeUsers;
    return activeUsers.filter(
      (u) =>
        u.name.toLowerCase().includes(normalizedQuery) ||
        (u.email ?? '').toLowerCase().includes(normalizedQuery),
    );
  }, [activeUsers, normalizedQuery]);
  const filteredDeactivatedUsers = useMemo(() => {
    if (!normalizedQuery) return deactivatedUsers;
    return deactivatedUsers.filter(
      (u) =>
        u.name.toLowerCase().includes(normalizedQuery) ||
        (u.email ?? '').toLowerCase().includes(normalizedQuery),
    );
  }, [deactivatedUsers, normalizedQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredActiveUsers.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pagedActiveUsers = filteredActiveUsers.slice(pageStart, pageStart + PAGE_SIZE);

  // Keep `page` clamped to `totalPages` whenever the result set shrinks (a
  // search narrows it, or a user gets deactivated off the active list) so
  // Prev/Next — which step off `page`, not the display-only `currentPage` —
  // don't have to "catch up" through several no-op clicks first.
  useEffect(() => {
    setPage((p) => Math.min(p, totalPages));
  }, [totalPages]);

  // Reset to page 1 whenever the search narrows/widens the result set, so a
  // stale page number never lands on an empty page.
  useEffect(() => {
    setPage(1);
  }, [normalizedQuery]);

  const handleCreateUser = async () => {
    const name = createName.trim();
    const email = createEmail.trim();
    if (!name || !email) return;
    setCreatePending(true);
    try {
      await createUser({ name, email });
      await load();
      setCreateOpen(false);
      setCreateName('');
      setCreateEmail('');
      toast.success(`Invite sent to ${email}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not create ${email}`);
    } finally {
      setCreatePending(false);
    }
  };

  const startEdit = (user: AdminUser, field: EditState['field']) => {
    if (user.deactivated_at) return;
    setEditing({ id: user.id, field, draft: field === 'name' ? user.name : user.email ?? '' });
  };

  const cancelEdit = () => setEditing(null);

  const saveEdit = async () => {
    if (!editing) return;
    const trimmed = editing.draft.trim();
    if (!trimmed) {
      cancelEdit();
      return;
    }
    const { id, field } = editing;
    setPendingId(id);
    try {
      await updateUser(id, { [field]: trimmed });
      await load();
      setEditing(null);
      toast.success(field === 'name' ? 'Name updated' : 'Email updated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not update ${field}`);
    } finally {
      setPendingId(null);
    }
  };

  const handleSendResetLink = async (user: AdminUser) => {
    if (!user.email) return;
    setPendingId(user.id);
    try {
      await sendResetLink(user.id);
      toast.success(`Reset link sent to ${user.email}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not send a reset link to ${user.name}`);
    } finally {
      setPendingId(null);
    }
  };

  const handleDeactivate = async (user: AdminUser) => {
    setPendingId(user.id);
    try {
      await deactivateUser(user.id);
      await load();
      toast.success(`${user.name} deactivated — they can no longer sign in`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not deactivate ${user.name}`);
    } finally {
      setPendingId(null);
    }
  };

  const handleReactivate = async (user: AdminUser) => {
    setPendingId(user.id);
    try {
      await reactivateUser(user.id);
      await load();
      toast.success(`${user.name} reactivated`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not reactivate ${user.name}`);
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="shrink-0 rounded-2xl border bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 p-4 text-left"
      >
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900 dark:to-emerald-700">
            <UsersIcon className="h-4 w-4 text-emerald-700 dark:text-emerald-200" />
          </div>
          <div>
            <h2 className="text-sm font-extrabold tracking-tight">User Management</h2>
            <p className="text-xs text-muted-foreground">
              Add, edit, deactivate, and reset passwords for platform users.
            </p>
          </div>
        </div>
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="border-t px-4 pb-4 pt-3">
          <div className="flex h-9 items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {loading ? 'Users' : `${activeUsers.length} active user${activeUsers.length === 1 ? '' : 's'}`}
            </h3>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button type="button" size="sm" variant="outline">
                  <UserPlus className="h-4 w-4" />
                  Add user
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add user</DialogTitle>
                  <DialogDescription>
                    Creates a new Investment Brain account and emails them a one-time link to
                    set their password and log in.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="new-user-name">Name</Label>
                    <Input
                      id="new-user-name"
                      value={createName}
                      onChange={(e) => setCreateName(e.target.value)}
                      placeholder="Jane Doe"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="new-user-email">Email</Label>
                    <Input
                      id="new-user-email"
                      type="email"
                      value={createEmail}
                      onChange={(e) => setCreateEmail(e.target.value)}
                      placeholder="jane@example.com"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleCreateUser();
                      }}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setCreateOpen(false)}
                    disabled={createPending}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={handleCreateUser}
                    disabled={createPending || !createName.trim() || !createEmail.trim()}
                  >
                    {createPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Mail className="h-4 w-4" />
                    )}
                    Send invite
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name or email…"
              className="pl-8"
              aria-label="Search users"
            />
          </div>

          {loading ? (
            <div className="mt-3 flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              {filteredActiveUsers.length === 0 && (
                <p className="rounded-lg border border-dashed bg-muted py-6 text-center text-sm text-muted-foreground">
                  {normalizedQuery ? 'No active users match your search.' : 'No users yet.'}
                </p>
              )}
              {pagedActiveUsers.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  editing={editing?.id === user.id ? editing : null}
                  busy={pendingId === user.id}
                  isSelf={user.id === currentUserId}
                  onStartEdit={(field) => startEdit(user, field)}
                  onEditDraftChange={(draft) => setEditing((prev) => (prev ? { ...prev, draft } : prev))}
                  onSaveEdit={saveEdit}
                  onCancelEdit={cancelEdit}
                  onSendResetLink={() => handleSendResetLink(user)}
                  onDeactivate={() => handleDeactivate(user)}
                  onReactivate={() => handleReactivate(user)}
                />
              ))}
            </div>
          )}

          {!loading && filteredActiveUsers.length > PAGE_SIZE && (
            <div className="mt-3 flex items-center justify-between border-t pt-3">
              <span className="text-xs text-muted-foreground">
                Showing {pageStart + 1}-{Math.min(pageStart + PAGE_SIZE, filteredActiveUsers.length)} of{' '}
                {filteredActiveUsers.length}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="px-1 text-xs font-medium">
                  {currentPage} / {totalPages}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  aria-label="Next page"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {!loading && filteredDeactivatedUsers.length > 0 && (
            <div className="pt-3">
              <button
                type="button"
                onClick={() => setShowDeactivated((prev) => !prev)}
                aria-expanded={showDeactivated}
                className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {showDeactivated ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                Deactivated ({filteredDeactivatedUsers.length})
              </button>
              {showDeactivated && (
                <div className="mt-2 space-y-2">
                  {filteredDeactivatedUsers.map((user) => (
                    <UserRow
                      key={user.id}
                      user={user}
                      editing={null}
                      busy={pendingId === user.id}
                      isSelf={user.id === currentUserId}
                      onStartEdit={() => {}}
                      onEditDraftChange={() => {}}
                      onSaveEdit={() => {}}
                      onCancelEdit={() => {}}
                      onSendResetLink={() => handleSendResetLink(user)}
                      onDeactivate={() => handleDeactivate(user)}
                      onReactivate={() => handleReactivate(user)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UserRow({
  user,
  editing,
  busy,
  isSelf,
  onStartEdit,
  onEditDraftChange,
  onSaveEdit,
  onCancelEdit,
  onSendResetLink,
  onDeactivate,
  onReactivate,
}: {
  user: AdminUser;
  editing: EditState | null;
  busy: boolean;
  isSelf: boolean;
  onStartEdit: (field: EditState['field']) => void;
  onEditDraftChange: (draft: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onSendResetLink: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
}) {
  const isDeactivated = Boolean(user.deactivated_at);
  const isEditingName = editing?.field === 'name';
  const isEditingEmail = editing?.field === 'email';

  const editRow = (field: EditState['field'], type: 'text' | 'email') => (
    <div className="flex items-center gap-1">
      <Input
        autoFocus
        type={type}
        value={editing?.draft ?? ''}
        onChange={(e) => onEditDraftChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSaveEdit();
          if (e.key === 'Escape') onCancelEdit();
        }}
        className={cn('h-7', field === 'name' ? 'text-sm' : 'text-xs')}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={onSaveEdit}
        disabled={busy}
        aria-label="Save"
        className="h-6 w-6 shrink-0 text-emerald-600 hover:text-emerald-700"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={onCancelEdit}
        aria-label="Cancel"
        className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-lg border bg-background px-3 py-2 sm:flex-row sm:items-center sm:justify-between',
        isDeactivated && 'opacity-70',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          className={cn(
            'grid h-9 w-9 shrink-0 place-items-center rounded-lg text-xs font-bold text-white',
            isDeactivated ? 'bg-muted-foreground/60' : 'bg-gradient-to-br from-emerald-500 to-emerald-600',
          )}
        >
          {initialsFor(user.name)}
        </span>
        <div className="min-w-0 flex-1">
          {isEditingName ? (
            editRow('name', 'text')
          ) : (
            <button
              type="button"
              onClick={() => onStartEdit('name')}
              disabled={isDeactivated}
              title={isDeactivated ? undefined : 'Click to rename'}
              className={cn(
                'block max-w-full truncate text-left text-sm font-semibold hover:underline disabled:cursor-default disabled:no-underline',
                isDeactivated && 'text-muted-foreground line-through',
              )}
            >
              {user.name}
            </button>
          )}
          {isEditingEmail ? (
            <div className="mt-0.5">{editRow('email', 'email')}</div>
          ) : (
            <button
              type="button"
              onClick={() => onStartEdit('email')}
              disabled={isDeactivated}
              title={isDeactivated ? undefined : 'Click to change email'}
              className="block max-w-full truncate text-left text-xs text-muted-foreground hover:underline disabled:cursor-default disabled:no-underline"
            >
              {user.email ?? '—'}
            </button>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-1">
          {user.is_superadmin && (
            <Badge variant="outline" className="text-[10px] uppercase">
              Superadmin
            </Badge>
          )}
          {isDeactivated && (
            <Badge variant="outline" className="text-[10px] uppercase">
              Deactivated
            </Badge>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
        {isDeactivated ? (
          <Button type="button" size="sm" variant="outline" onClick={onReactivate} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            Reactivate
          </Button>
        ) : (
          <UserRowMenu
            user={user}
            busy={busy}
            isSelf={isSelf}
            onSendResetLink={onSendResetLink}
            onDeactivate={onDeactivate}
          />
        )}
      </div>
    </div>
  );
}

type UserRowAction = 'reset' | 'deactivate';

/** Row-actions kebab menu for an active user — both actions are confirmed
 *  before firing, so the menu drives a single controlled AlertDialog instead
 *  of showing the destination action right on the row. */
function UserRowMenu({
  user,
  busy,
  isSelf,
  onSendResetLink,
  onDeactivate,
}: {
  user: AdminUser;
  busy: boolean;
  isSelf: boolean;
  onSendResetLink: () => void;
  onDeactivate: () => void;
}) {
  const [confirmAction, setConfirmAction] = useState<UserRowAction | null>(null);

  return (
    <AlertDialog
      open={confirmAction !== null}
      onOpenChange={(open) => {
        if (!open) setConfirmAction(null);
      }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Actions for ${user.name}`}
            disabled={busy}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreVertical className="h-4 w-4" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => setConfirmAction('reset')}
            disabled={!user.email}
          >
            <Mail className="mr-2 h-4 w-4" />
            Send reset link
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setConfirmAction('deactivate')}
            disabled={isSelf}
            title={isSelf ? "You can't deactivate your own account" : undefined}
            className="text-destructive focus:text-destructive"
          >
            <UserX className="mr-2 h-4 w-4 text-destructive" />
            Deactivate
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {confirmAction === 'reset' && (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send password-reset link</AlertDialogTitle>
            <AlertDialogDescription>
              Send {user.name} a link to set a new password? It&apos;s valid for a limited time
              and their current password keeps working until they use it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onSendResetLink}>Send link</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
      {confirmAction === 'deactivate' && (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate user</AlertDialogTitle>
            <AlertDialogDescription>
              Deactivate {user.name}? They will no longer be able to sign in, but nothing is
              erased — their data, workspace memberships, and history all stay intact, and you
              can reactivate them at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onDeactivate}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
