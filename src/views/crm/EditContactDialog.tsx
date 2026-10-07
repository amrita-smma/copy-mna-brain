"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ContactFields } from "./ContactFields";
import type { ContactFormValues, Correspondent } from "./types";
import { contactFormToPayload, contactToFormValues } from "./utils";

/**
 * Edits an existing correspondent in place. Record-scoped: the parent mounts it
 * only while a contact is selected and keys it by that contact's id (see
 * `.claude/rules/dialog-open-state.md`), so the initial state below is always
 * the right contact's and never a stale one. The firm is fixed — moving a
 * contact between firms is a different operation.
 */
export function EditContactDialog({
  contact,
  open,
  onOpenChange,
  onSaved,
}: {
  contact: Correspondent;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<ContactFormValues>(() =>
    contactToFormValues(contact),
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!values.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/crm/correspondents/${contact.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(contactFormToPayload(values)),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Failed to save contact");
      }
      toast.success("Contact updated");
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto"
        data-testid="edit-contact-dialog"
      >
        <DialogHeader>
          <DialogTitle>Edit contact</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <ContactFields
            values={values}
            onChange={setValues}
            disabled={saving}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={saving}
            data-testid="contact-edit-submit"
          >
            {saving && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
