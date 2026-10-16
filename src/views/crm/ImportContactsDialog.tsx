"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  chunkRows,
  collapseByEmail,
  parseContactCsv,
  type ImportContactField,
  type ImportContactRow,
  type ParsedContactFile,
} from "@/lib/crm/contactImport";
import { CloudUpload, FileSpreadsheet, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface ImportResult {
  created: number;
  merged: number;
  skipped: number;
  errors: string[];
}

/** Rows rendered in the scrollable preview; the rest are counted, not drawn. */
const PREVIEW_ROWS = 500;
const ACCEPT = ".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const FIELD_LABELS: Record<ImportContactField, string> = {
  name: "Name",
  firm: "Company",
  email: "Email",
  phone: "Phone",
  title: "Title",
  type: "Type",
  department: "Department",
  specialization: "Specialization",
  seniority: "Seniority",
  coverageRegion: "Coverage region",
  linkedinUrl: "LinkedIn",
  bio: "Bio",
};


async function parseFile(file: File): Promise<ParsedContactFile> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx")) {
    const { parseContactWorkbook } = await import("@/lib/crm/contactImportExcel");
    return parseContactWorkbook(await file.arrayBuffer());
  }
  if (name.endsWith(".csv") || file.type === "text/csv") {
    return parseContactCsv(await file.text());
  }
  return {
    rows: [],
    mappedHeaders: {},
    extraHeaders: [],
    errors: ["Unsupported file — use .csv or .xlsx (save older .xls files as .xlsx)."],
  };
}

/**
 * Bulk contact import from a CSV or Excel file, dropped or picked. Rows merge
 * into existing CRM contacts — manual or email-ingested — by email; see
 * `CRMService.importContacts`. Any file size: rows are posted in batches.
 */
export function ImportContactsDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onImported: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState<ParsedContactFile | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setParsed(null);
      setResult(null);
      setProgress(null);
      setIsDragging(false);
    }
  }, [open]);

  const submitting = progress !== null;

  const onFile = async (picked: File | undefined | null) => {
    if (!picked || submitting) return;
    setResult(null);
    setFile(picked);
    setParsing(true);
    try {
      setParsed(await parseFile(picked));
    } catch {
      setParsed({
        rows: [],
        mappedHeaders: {},
        extraHeaders: [],
        errors: ["Could not read this file."],
      });
    } finally {
      setParsing(false);
    }
  };

  const clear = () => {
    setFile(null);
    setParsed(null);
    setResult(null);
  };

  const rows = parsed?.rows ?? [];
  const withEmail = rows.filter((r) => r.email).length;

  const submit = async () => {
    if (rows.length === 0) return;
    // Fold repeated emails across the whole file first, so a repeat landing
    // in a later batch still becomes the same contact.
    const { rows: unique, duplicates } = collapseByEmail(rows);
    const batches = chunkRows<ImportContactRow>(unique);
    const total: ImportResult = { created: 0, merged: 0, skipped: duplicates, errors: [] };
    setProgress({ done: 0, total: unique.length });
    try {
      let done = 0;
      for (const batch of batches) {
        const res = await fetch("/api/crm/contacts/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contacts: batch }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            `${j.error || "Import failed"} — ${done} of ${unique.length} contacts were imported before the error.`,
          );
        }
        const data = j.data as ImportResult;
        total.created += data.created;
        total.merged += data.merged;
        total.skipped += data.skipped;
        total.errors.push(...data.errors);
        done += batch.length;
        setProgress({ done, total: unique.length });
      }
      setResult(total);
      toast.success(`Imported: ${total.created} new, ${total.merged} merged by email`);
    } catch (err) {
      setResult(total);
      toast.error((err as Error).message);
    } finally {
      setProgress(null);
      onImported();
    }
  };

  const problems = [...(parsed?.errors ?? []), ...(result?.errors ?? [])];
  // Field order, not header order: every mapped field gets a preview column,
  // plus Bio when unrecognised columns are being folded into it.
  const mapped = parsed
    ? (Object.keys(FIELD_LABELS) as ImportContactField[]).filter(
        (f) => parsed.mappedHeaders[f] !== undefined,
      )
    : [];
  const previewColumns =
    parsed && parsed.extraHeaders.length > 0 && !mapped.includes("bio")
      ? [...mapped, "bio" as const]
      : mapped;

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      {/* Near full screen, and only the preview table scrolls — the drop
          zone, summary and footer stay put. */}
      <DialogContent className="flex h-[92vh] w-[96vw] max-w-[96vw] flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Import contacts</DialogTitle>
          <DialogDescription>
            CSV or Excel with a header row. Contacts whose email already exists
            in the CRM, including ones found in synced emails, are merged into
            that contact instead of duplicated.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!submitting) setIsDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragging(false);
              void onFile(e.dataTransfer.files?.[0]);
            }}
            className={`shrink-0 rounded-xl border-2 border-dashed bg-muted p-6 text-center transition-colors ${
              isDragging ? "border-primary" : "border-border"
            }`}
            data-testid="contact-import-dropzone"
          >
            <CloudUpload className="mx-auto mb-2 h-8 w-8 text-primary" />
            <div className="mb-2 text-sm text-muted-foreground">
              Drag &amp; drop a .csv or .xlsx file, or
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={submitting}
              onClick={() => inputRef.current?.click()}
              data-testid="contact-import-browse"
            >
              Browse files
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              data-testid="contact-import-file"
              onChange={(e) => {
                void onFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <div className="mt-2 text-xs text-muted-foreground">
              Recognised columns: Name (or First / Last name), Company, Email,
              Phone, Title, Type, Department, Specialization, Seniority, Region,
              LinkedIn, Bio / Notes. Other columns are kept in Bio.
            </div>

            {file && (
              <div className="mt-4 flex items-center justify-between rounded-lg border border-border bg-card p-2.5 text-left">
                <div className="mr-2 flex min-w-0 items-center gap-2">
                  {parsing ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                  ) : (
                    <FileSpreadsheet className="h-4 w-4 shrink-0 text-primary" />
                  )}
                  <span className="truncate text-xs font-medium text-foreground">
                    {file.name}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                  disabled={submitting}
                  onClick={clear}
                >
                  <X className="h-3.5 w-3.5" />
                  <span className="sr-only">Remove file</span>
                </Button>
              </div>
            )}
          </div>

          {parsed && rows.length > 0 && !result && (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <p className="shrink-0 text-sm">
                <b>{rows.length.toLocaleString()}</b> contact
                {rows.length === 1 ? "" : "s"} ready ·{" "}
                {withEmail.toLocaleString()} with an email (merged when it
                matches an existing contact) ·{" "}
                {(rows.length - withEmail).toLocaleString()} without (always
                added as new)
              </p>

              <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">Mapped:</span>
                {mapped.map((f) => (
                  <span
                    key={f}
                    className="rounded-full border bg-card px-2 py-0.5"
                    title={`From column "${parsed.mappedHeaders[f]}"`}
                  >
                    {FIELD_LABELS[f]}
                  </span>
                ))}
              </div>
              {parsed.extraHeaders.length > 0 && (
                <p className="shrink-0 text-xs text-muted-foreground">
                  Kept in Bio: {parsed.extraHeaders.join(", ")}
                </p>
              )}

              <div
                className="min-h-0 flex-1 overflow-auto rounded-md border bg-card"
                data-testid="contact-import-preview"
              >
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 z-10 bg-muted text-muted-foreground">
                    <tr>
                      {previewColumns.map((f) => (
                        <th key={f} className="whitespace-nowrap px-3 py-2 font-medium">
                          {FIELD_LABELS[f]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                      <tr key={i}>
                        {previewColumns.map((f) => (
                          <td
                            key={f}
                            className="max-w-[280px] truncate px-3 py-1.5"
                            title={r[f]}
                          >
                            {r[f] ?? "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > PREVIEW_ROWS && (
                <p className="shrink-0 text-xs text-muted-foreground">
                  Previewing the first {PREVIEW_ROWS.toLocaleString()} — all{" "}
                  {rows.length.toLocaleString()} will be imported.
                </p>
              )}
            </div>
          )}

          {progress && (
            <div className="shrink-0 space-y-1.5">
              <Progress value={(progress.done / Math.max(progress.total, 1)) * 100} />
              <p className="text-xs text-muted-foreground">
                Importing {progress.done.toLocaleString()} of{" "}
                {progress.total.toLocaleString()}…
              </p>
            </div>
          )}

          {result && (
            <div className="shrink-0 rounded-md border bg-card px-4 py-3 text-sm">
              <b>{result.created.toLocaleString()}</b> created ·{" "}
              <b>{result.merged.toLocaleString()}</b> merged into existing
              contacts · <b>{result.skipped.toLocaleString()}</b> skipped
            </div>
          )}

          {problems.length > 0 && (
            <ul className="max-h-40 shrink-0 list-disc overflow-y-auto rounded-md border bg-muted py-2 pl-8 pr-3 text-xs text-muted-foreground">
              {problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter className="shrink-0">
          <Button
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {result ? "Done" : "Cancel"}
          </Button>
          {!result && (
            <Button
              onClick={submit}
              disabled={submitting || parsing || rows.length === 0}
              data-testid="contact-import-submit"
            >
              {submitting && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
              Import {rows.length > 0 ? rows.length.toLocaleString() : ""} contact
              {rows.length === 1 ? "" : "s"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
