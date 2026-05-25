"use client";

import { Button } from "@/components/ui/button";
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
import { CompanyPicker } from "./CompanyPicker";
import type { CompanyPickerValue, EmployerSummary } from "./types";

export function AddContactDialog({
  open,
  onOpenChange,
  employerId,
  employers,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  employerId: string | null;
  employers: EmployerSummary[];
  onCreated: () => void;
}) {
  const [firm, setFirm] = useState<CompanyPickerValue | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setFirm(null);
      setName("");
      setEmail("");
      setPhone("");
      setTitle("");
    } else if (employerId) {
      const existing = employers.find((e) => e.id === employerId);
      setFirm(existing ? { name: existing.name, id: existing.id } : null);
    }
  }, [open, employerId, employers]);

  const lockedFirm = !!employerId;

  const submit = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!firm?.name) {
      toast.error("Firm is required");
      return;
    }
    setSubmitting(true);
    try {
      const targetId = firm.id ?? (await ensureEmployer(firm.name));
      const res = await fetch(`/api/crm/employers/${targetId}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone, title }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Failed to create contact");
      }
      toast.success("Contact created");
      onCreated();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add new contact</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label className="mb-1 block text-[10px] uppercase">
              Company *
            </Label>
            <CompanyPicker
              value={firm}
              locked={lockedFirm}
              onChange={setFirm}
            />
          </div>
          <div>
            <Label className="text-[10px] uppercase">Full name *</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="John Doe"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[10px] uppercase">Email</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="john@example.com"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase">Phone</Label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 234 567 890"
              />
            </div>
          </div>
          <div>
            <Label className="text-[10px] uppercase">Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Managing Director"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            Create contact
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function ensureEmployer(name: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Firm name is required");
  const res = await fetch("/api/crm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: trimmed }),
  });
  const j = await res.json();
  if (res.status === 409) {
    // Already exists — re-fetch it to grab the id
    const list = await fetch("/api/crm?q=" + encodeURIComponent(trimmed)).then(
      (r) => r.json(),
    );
    const found = list.data?.find(
      (e: EmployerSummary) =>
        e.name.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (!found) throw new Error(j.error || "Could not resolve firm");
    return found.id;
  }
  if (!res.ok) throw new Error(j.error || "Failed to create firm");
  return j.data.id;
}
