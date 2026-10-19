"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  getBankerNames,
  getCompanies,
  getUsers,
  updateCompany,
  type UserSummary,
} from "@/lib/api/pipeline";
import {
  buildCompanyInfoUpdate,
  changedCompanyInfoFields,
  companyInfoFormFrom,
  type CompanyInfoForm,
  type CompanyInfoSource,
} from "@/lib/companies/companyInfoForm";
import { FIRST_STAGE_KEY } from "@/lib/pipeline/stages";

interface Options<C> {
  company: (CompanyInfoSource & { id: string }) | null;
  /** Called with the re-read company after a successful save. */
  onSaved: (refreshed: C | null) => void;
  /** Stage key → display label, for the "missing required fields" toast. */
  stageLabel: (stage: string) => string;
  /** Called when editing starts — e.g. to lazily load tracks. */
  onStart?: () => void;
}

export interface CompanyInformationEditor {
  isEditing: boolean;
  isSaving: boolean;
  editForm: CompanyInfoForm | null;
  setEditForm: (form: CompanyInfoForm) => void;
  users: UserSummary[];
  bankerOptions: string[];
  startEditing: () => void;
  cancelEditing: () => void;
  saveEditing: () => Promise<void>;
}

/**
 * Inline edit state for the Company Information card, shared by the full
 * company page and the pipeline dialog so both edit and save the same fields
 * the same way. Users and banker names load on first edit.
 */
export function useCompanyInformationEditor<C>({
  company,
  onSaved,
  stageLabel,
  onStart,
}: Options<C>): CompanyInformationEditor {
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editForm, setEditForm] = useState<CompanyInfoForm | null>(null);
  // The draft as seeded, so a save sends only what the user changed.
  const [seededForm, setSeededForm] = useState<CompanyInfoForm | null>(null);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [bankerOptions, setBankerOptions] = useState<string[]>([]);

  const startEditing = useCallback(() => {
    if (!company) return;
    const seeded = companyInfoFormFrom(company, FIRST_STAGE_KEY);
    setSeededForm(seeded);
    setEditForm(seeded);
    setIsEditing(true);
    onStart?.();
    if (bankerOptions.length === 0) {
      getBankerNames()
        .then(setBankerOptions)
        .catch((err) => console.error("Failed to load bankers:", err));
    }
    if (users.length === 0) {
      getUsers()
        .then(setUsers)
        .catch((err) => console.error("Failed to load users:", err));
    }
  }, [company, onStart, bankerOptions.length, users.length]);

  const cancelEditing = useCallback(() => {
    setIsEditing(false);
    setEditForm(null);
    setSeededForm(null);
  }, []);

  // Drop a stale draft when the host swaps to a different company without
  // remounting (e.g. a dialog kept mounted between opens).
  useEffect(() => {
    cancelEditing();
  }, [company?.id, cancelEditing]);

  const saveEditing = useCallback(async () => {
    if (!editForm || !company) return;
    const result = buildCompanyInfoUpdate(editForm, company.source);
    if (result.ok === false) {
      toast.error(result.error);
      return;
    }
    const baseline = seededForm ? buildCompanyInfoUpdate(seededForm, company.source) : null;
    const update = baseline?.ok ? changedCompanyInfoFields(baseline.update, result.update) : result.update;
    setIsSaving(true);
    try {
      if (Object.keys(update).length > 0) await updateCompany(company.id, update);
      const refreshed = (await getCompanies({ id: company.id })) as C | null;
      onSaved(refreshed ?? null);
      toast.success("Company updated");
      setIsEditing(false);
      setEditForm(null);
      setSeededForm(null);
    } catch (err: unknown) {
      console.error("Failed to save company:", err);
      const e = err as { message?: string; missingFields?: string[] };
      // Entering the pipeline is gated on the workspace's required fields; the
      // API returns the missing ones so the user can fill them and re-save.
      if (Array.isArray(e?.missingFields) && e.missingFields.length > 0) {
        toast.error(
          `Cannot move to ${stageLabel(editForm.pipeline_stage)}: missing ${e.missingFields.join(", ")}`,
        );
      } else {
        toast.error(`Failed to save: ${e?.message || "Unknown error"}`);
      }
    } finally {
      setIsSaving(false);
    }
  }, [editForm, seededForm, company, onSaved, stageLabel]);

  return {
    isEditing,
    isSaving,
    editForm,
    setEditForm,
    users,
    bankerOptions,
    startEditing,
    cancelEditing,
    saveEditing,
  };
}
