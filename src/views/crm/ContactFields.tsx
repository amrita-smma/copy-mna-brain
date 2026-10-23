"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useId } from "react";
import type { ContactFormValues } from "./types";
import {
  CONTACT_DEPARTMENTS,
  CONTACT_SENIORITIES,
  CONTACT_TYPES,
} from "./utils";

export const EMPTY_CONTACT_FORM: ContactFormValues = {
  name: "",
  title: "",
  email: "",
  phone: "",
  type: "",
  department: "",
  specialization: "",
  seniority: "",
  coverage_region: "",
  linkedin_url: "",
};

/**
 * The editable fields of a CRM contact (banker), shared by the add and edit
 * dialogs so both always offer the same set. The firm picker is NOT here —
 * adding a contact resolves a firm, editing one never changes it.
 *
 * Department / seniority / type are free text backed by a `<datalist>`: the
 * columns are plain `text`, and a banker's desk naming never fits a closed
 * enum across firms.
 *
 * The bio is deliberately absent: it is the AI-generated profile, written only
 * by Get Full Profile / Refresh, and the PATCH route ignores it.
 */
export function ContactFields({
  values,
  onChange,
  disabled,
}: {
  values: ContactFormValues;
  onChange: (next: ContactFormValues) => void;
  disabled?: boolean;
}) {
  const set = (field: keyof ContactFormValues) => (value: string) =>
    onChange({ ...values, [field]: value });

  // Instance-scoped <datalist> ids. The add and edit dialogs can both be
  // mounted at once, and a duplicate id would make every `list=` attribute
  // resolve to whichever copy the browser saw first.
  const uid = useId();
  const departmentListId = `contact-department-${uid}`;
  const seniorityListId = `contact-seniority-${uid}`;
  const typeListId = `contact-type-${uid}`;

  return (
    <div className="space-y-3">
      <datalist id={departmentListId}>
        {CONTACT_DEPARTMENTS.map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>
      <datalist id={seniorityListId}>
        {CONTACT_SENIORITIES.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <datalist id={typeListId}>
        {CONTACT_TYPES.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>

      <Field label="Full name *">
        <Input
          value={values.name}
          disabled={disabled}
          onChange={(e) => set("name")(e.target.value)}
          placeholder="John Doe"
          data-testid="contact-field-name"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Email">
          <Input
            type="email"
            value={values.email}
            disabled={disabled}
            onChange={(e) => set("email")(e.target.value)}
            placeholder="john@example.com"
            data-testid="contact-field-email"
          />
        </Field>
        <Field label="Phone">
          <Input
            value={values.phone}
            disabled={disabled}
            onChange={(e) => set("phone")(e.target.value)}
            placeholder="+1 234 567 890"
            data-testid="contact-field-phone"
          />
        </Field>
        <Field label="Title">
          <Input
            value={values.title}
            disabled={disabled}
            onChange={(e) => set("title")(e.target.value)}
            placeholder="Managing Director, TMT"
            data-testid="contact-field-title"
          />
        </Field>
        <Field label="Seniority">
          <Input
            list={seniorityListId}
            value={values.seniority}
            disabled={disabled}
            onChange={(e) => set("seniority")(e.target.value)}
            placeholder="Managing Director"
            data-testid="contact-field-seniority"
          />
        </Field>
        <Field label="Department">
          <Input
            list={departmentListId}
            value={values.department}
            disabled={disabled}
            onChange={(e) => set("department")(e.target.value)}
            placeholder="M&A"
            data-testid="contact-field-department"
          />
        </Field>
        <Field label="Coverage region">
          <Input
            value={values.coverage_region}
            disabled={disabled}
            onChange={(e) => set("coverage_region")(e.target.value)}
            placeholder="Southeast Asia"
            data-testid="contact-field-coverage-region"
          />
        </Field>
      </div>

      <Field label="Specialization">
        <Input
          value={values.specialization}
          disabled={disabled}
          onChange={(e) => set("specialization")(e.target.value)}
          placeholder="Semiconductors, industrial tech"
          data-testid="contact-field-specialization"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Relationship">
          <Input
            list={typeListId}
            value={values.type}
            disabled={disabled}
            onChange={(e) => set("type")(e.target.value)}
            placeholder="external"
            data-testid="contact-field-type"
          />
        </Field>
        <Field label="LinkedIn">
          <Input
            value={values.linkedin_url}
            disabled={disabled}
            onChange={(e) => set("linkedin_url")(e.target.value)}
            placeholder="https://linkedin.com/in/johndoe"
            data-testid="contact-field-linkedin-url"
          />
        </Field>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label className="mb-1 block text-[10px] uppercase">{label}</Label>
      {children}
    </div>
  );
}
