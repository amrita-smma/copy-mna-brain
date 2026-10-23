"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { TeamMemberSummary } from "./types";

/**
 * Edit a firm's name, industry and team for THIS workspace. All three are
 * per-workspace overlays (MB-687): the shared firm row the email ingest owns
 * is never touched, and another workspace keeps its own values. The team can
 * only be people in this workspace — the picker lists its members.
 *
 * Mounted per firm and keyed by its id by the caller, so the initial state is
 * always this firm's.
 */
export function EditEmployerDialog({
  employerId,
  name,
  industry,
  team,
  open,
  onOpenChange,
  onSaved,
}: {
  employerId: string;
  name: string;
  industry: string | null;
  team: TeamMemberSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [nameValue, setNameValue] = useState(name);
  const [industryValue, setIndustryValue] = useState(industry ?? "");
  const [teamIds, setTeamIds] = useState<Set<string>>(() => new Set(team.map((t) => t.id)));
  const [members, setMembers] = useState<TeamMemberSummary[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/crm/workspace-members", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error())))
      .then((j: { data: TeamMemberSummary[] }) => {
        if (live) setMembers(j.data ?? []);
      })
      .catch(() => {
        if (live) setMembers([]);
      });
    return () => {
      live = false;
    };
  }, []);

  // A current team member who has since left the workspace still shows, so
  // the dialog can take them off; they just cannot be added back.
  const options = members
    ? [...members, ...team.filter((t) => !members.some((m) => m.id === t.id))]
    : [];

  const toggle = (id: string, checked: boolean) =>
    setTeamIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const save = async () => {
    if (!nameValue.trim()) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      // Only what changed: writing an unchanged name would pin it in this
      // workspace's overlay and hide a later correction from the ingest.
      const patch: { name?: string; industry?: string | null } = {};
      if (nameValue.trim() !== name) patch.name = nameValue.trim();
      if ((industryValue.trim() || null) !== (industry ?? null)) {
        patch.industry = industryValue.trim() || null;
      }
      if (Object.keys(patch).length > 0) {
        const firm = await fetch(`/api/crm/employers/${employerId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!firm.ok) throw new Error("Could not save the firm");
      }

      const teamChanged =
        teamIds.size !== team.length || team.some((t) => !teamIds.has(t.id));
      if (teamChanged) {
        const res = await fetch(`/api/crm/employers/${employerId}/team`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_ids: [...teamIds] }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || "Could not save the team");
        }
      }
      toast.success("Firm updated");
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto" data-testid="edit-employer-dialog">
        <DialogHeader>
          <DialogTitle>Edit firm</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label htmlFor={`firm-name-${employerId}`}>Name *</Label>
            <Input
              id={`firm-name-${employerId}`}
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              disabled={saving}
              data-testid="employer-field-name"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`firm-industry-${employerId}`}>Industry</Label>
            <Input
              id={`firm-industry-${employerId}`}
              value={industryValue}
              onChange={(e) => setIndustryValue(e.target.value)}
              disabled={saving}
              placeholder="Investment banking"
              data-testid="employer-field-industry"
            />
          </div>
          <div className="space-y-1">
            <Label>Team</Label>
            {!members ? (
              <div className="flex py-3">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : options.length === 0 ? (
              <p className="text-sm text-muted-foreground">No members in this workspace.</p>
            ) : (
              <div
                className="max-h-56 space-y-1 overflow-y-auto rounded-md border bg-card p-2"
                data-testid="employer-team-picker"
              >
                {options.map((m) => (
                  <label
                    key={m.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted"
                  >
                    <Checkbox
                      checked={teamIds.has(m.id)}
                      onCheckedChange={(c) => toggle(m.id, c === true)}
                      disabled={saving}
                    />
                    <span className="min-w-0 truncate">{m.name}</span>
                    {m.email && (
                      <span className="min-w-0 truncate text-xs text-muted-foreground">
                        {m.email}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Changes apply to this workspace only.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving} data-testid="employer-edit-submit">
            {saving && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
