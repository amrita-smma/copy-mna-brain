"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CompanyPicker } from "./CompanyPicker";
import { ContactFields, EMPTY_CONTACT_FORM } from "./ContactFields";
import type {
  CompanyPickerValue,
  ContactFormValues,
  EmployerSummary,
} from "./types";
import { contactFormToPayload } from "./utils";

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
  const [values, setValues] = useState<ContactFormValues>(EMPTY_CONTACT_FORM);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setFirm(null);
      setValues(EMPTY_CONTACT_FORM);
    } else if (employerId) {
      const existing = employers.find((e) => e.id === employerId);
      setFirm(existing ? { name: existing.name, id: existing.id } : null);
    }
  }, [open, employerId, employers]);

  const lockedFirm = !!employerId;

  const submit = async () => {
    if (!values.name.trim()) {
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
        body: JSON.stringify(contactFormToPayload(values)),
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
      <DialogContent className="max-h-[85vh] overflow-y-auto">
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
          <ContactFields
            values={values}
            onChange={setValues}
            disabled={submitting}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={submitting}
            data-testid="contact-create-submit"
          >
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
