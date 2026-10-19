"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import StatusCombobox from "@/components/pipeline/StatusCombobox";
import {
  createCompany,
  getBankerNames,
  updateCompanyFinancials,
} from "@/lib/api/pipeline";
import {
  emptyManualCompanyForm,
  validateManualCompany,
  type ManualCompanyField,
  type ManualCompanyForm,
} from "@/lib/pipeline/manualAddCompany";
import { DEAL_TYPE_OPTIONS } from "@/lib/companies/dealTypes";

interface AddCompanyFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * Pipeline "Add Company → Manual": one company straight into L0. Collects the
 * same fields the "Ask AI" prompt asks for, plus the required-fields gate's deal fields
 * (source, deal type, banker for inbound). Rules live in
 * `@/lib/pipeline/manualAddCompany`.
 */
export default function AddCompanyForm({ onSuccess, onCancel }: AddCompanyFormProps) {
  const [form, setForm] = useState<ManualCompanyForm>(() => emptyManualCompanyForm());
  const [errors, setErrors] = useState<Partial<Record<ManualCompanyField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [bankerOptions, setBankerOptions] = useState<string[]>([]);

  useEffect(() => {
    getBankerNames()
      .then(setBankerOptions)
      .catch((err) => console.error("Failed to load bankers:", err));
  }, []);

  const set = <K extends ManualCompanyField>(key: K, value: ManualCompanyForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = validateManualCompany(form);
    if (result.status === "invalid") {
      setErrors(result.errors);
      setFormError(result.formError ?? null);
      return;
    }
    setErrors({});
    setFormError(null);

    setIsSubmitting(true);
    try {
      const created = await createCompany(result.company, "ADDED_TO_PIPELINE");
      if (result.financials && created?.id) {
        try {
          await updateCompanyFinancials(created.id, {
            rows: [result.financials],
            logAction: "UPDATED_FINANCIALS",
          });
        } catch (err) {
          console.error("Error saving financials:", err);
          toast.warning(
            `${result.company.target} was added, but its financials didn't save. Add them from the company card.`,
          );
          onSuccess();
          return;
        }
      }
      toast.success(`${result.company.target} added to the pipeline`);
      onSuccess();
    } catch (err) {
      console.error("Error adding company:", err);
      toast.error(err instanceof Error ? err.message : "Failed to add company");
    } finally {
      setIsSubmitting(false);
    }
  };

  const fieldError = (key: ManualCompanyField) =>
    errors[key] ? (
      <p className="text-xs text-destructive" data-testid={`add-company-error-${key}`}>
        {errors[key]}
      </p>
    ) : null;

  const textField = (
    key: ManualCompanyField,
    label: string,
    opts: { placeholder?: string; required?: boolean; inputMode?: "decimal" | "numeric" } = {},
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={`add_company_${key}`}>
        {label}
        {opts.required && " *"}
      </Label>
      <Input
        id={`add_company_${key}`}
        data-testid={`add-company-${key}`}
        value={form[key]}
        onChange={(e) => set(key, e.target.value as ManualCompanyForm[typeof key])}
        placeholder={opts.placeholder}
        inputMode={opts.inputMode}
        aria-invalid={!!errors[key]}
        disabled={isSubmitting}
      />
      {fieldError(key)}
    </div>
  );

  const textArea = (key: ManualCompanyField, label: string, placeholder?: string, required = false) => (
    <div className="space-y-1.5">
      <Label htmlFor={`add_company_${key}`}>
        {label}
        {required && " *"}
      </Label>
      <Textarea
        id={`add_company_${key}`}
        data-testid={`add-company-${key}`}
        value={form[key]}
        onChange={(e) => set(key, e.target.value as ManualCompanyForm[typeof key])}
        placeholder={placeholder}
        rows={2}
        aria-invalid={!!errors[key]}
        disabled={isSubmitting}
      />
      {fieldError(key)}
    </div>
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-6" data-testid="add-company-form" noValidate>
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Required</h3>
        <div className="grid gap-4 md:grid-cols-2">
          {textField("name", "Company name", { required: true, placeholder: "Acme Corp" })}
          {textField("segment", "Segment", { required: true, placeholder: "e.g. Semiconductor" })}
          {textField("geography", "HQ country", { required: true, placeholder: "e.g. Indonesia" })}
          <div className="space-y-1.5">
            <Label>Source *</Label>
            <Select
              value={form.source || undefined}
              onValueChange={(v) => set("source", v as ManualCompanyForm["source"])}
              disabled={isSubmitting}
            >
              <SelectTrigger data-testid="add-company-source" aria-invalid={!!errors.source}>
                <SelectValue placeholder="Inbound or outbound" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inbound">Inbound</SelectItem>
                <SelectItem value="outbound">Outbound</SelectItem>
              </SelectContent>
            </Select>
            {fieldError("source")}
          </div>
          <div className="space-y-1.5">
            <Label>Deal type *</Label>
            <Select
              value={form.deal_type}
              onValueChange={(v) => set("deal_type", v as ManualCompanyForm["deal_type"])}
              disabled={isSubmitting}
            >
              <SelectTrigger data-testid="add-company-deal_type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEAL_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {form.source === "inbound" && (
            <div className="space-y-1.5" data-testid="add-company-banker">
              <Label>Banker *</Label>
              <StatusCombobox
                value={form.banker || null}
                options={bankerOptions}
                placeholder="Set banker…"
                searchPlaceholder="Search or add a banker…"
                emptyText="No bankers yet."
                onChange={(v) => set("banker", v)}
                disabled={isSubmitting}
              />
              {fieldError("banker")}
            </div>
          )}
        </div>
        {textArea("company_focus", "What the company does", "1–2 lines", true)}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Recommended</h3>
        <div className="grid gap-4 md:grid-cols-2">
          {textField("website", "Website", { placeholder: "https://…" })}
          {textField("ownership", "Ownership", { placeholder: "e.g. family office / PE-backed / public" })}
        </div>
        <div className="grid gap-4 md:grid-cols-4">
          {textField("fiscal_year", "Fiscal year", { inputMode: "numeric" })}
          {textField("revenue_usd_mn", "Revenue (USD mn)", { inputMode: "decimal" })}
          {textField("ebitda_usd_mn", "EBITDA (USD mn)", { inputMode: "decimal" })}
          {textField("ev_usd_mn", "EV (USD mn)", { inputMode: "decimal" })}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Optional</h3>
        <div className="grid gap-4 md:grid-cols-2">
          {textArea("comments", "Comments")}
          {textArea("remarks", "Remarks")}
        </div>
        {textArea("thesis_content", "Thesis notes")}
        <div className="grid gap-4 md:grid-cols-2">
          {textField("watchlist_id", "Watchlist ID", { inputMode: "numeric" })}
          {textField("watchlist_status", "Watchlist status")}
        </div>
      </section>

      {formError && <p className="text-sm text-destructive">{formError}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting} data-testid="add-company-submit">
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Add to Pipeline
        </Button>
      </div>
    </form>
  );
}
