"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, ScanSearch } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  getPendingAutomation,
  getScanNowPreview,
  savePendingAutomation,
  scanPendingNow,
} from "@/lib/api/pendingAutomation";
import {
  countScanCompaniesByTrack,
  countScanSelection,
  DEFAULT_PENDING_AUTOMATION,
  formatScanEstimate,
  normalizePendingAutomation,
  type PendingAutomation,
  type ScanNowPreview,
  type ScanNowSelection,
} from "@/lib/sourcing/pendingAutomation";

interface PendingAutomationTogglesProps {
  /** Active companies waiting in Pending Confirmation; Scan now is off at 0. */
  pendingCount: number;
  /** Called after Scan now queued a scan. */
  onQueued?: () => void;
  /** `data-testid` prefix — the controls render on Sourcing and on Pipeline. */
  testIdPrefix?: string;
}

const plural = (n: number) => `${n} ${n === 1 ? "company" : "companies"}`;

const queuedMessage = (queued: number, alreadyQueued: number) =>
  `Queued ${plural(queued)} for AI screening in AI Workforce` +
  (alreadyQueued > 0 ? ` (${alreadyQueued} already queued)` : "");

/**
 * Pending Confirmation automation (Sourcing's Pending tab and Pipeline's
 * Pending Confirmation chip): the workspace's Auto-scan, Auto promote and
 * Auto drop toggles, and a Scan now button that re-screens every company
 * waiting in the bucket.
 */
export default function PendingAutomationToggles({
  pendingCount,
  onQueued,
  testIdPrefix = "sourcing",
}: PendingAutomationTogglesProps) {
  const [settings, setSettings] = useState<PendingAutomation>(
    DEFAULT_PENDING_AUTOMATION,
  );
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // What Scan now would queue, fetched each time the confirmation opens.
  // `null` while loading; `"error"` when the estimate could not be fetched.
  const [preview, setPreview] = useState<ScanNowPreview | "error" | null>(null);
  // Which tracks the scan covers; every track (and the unmatched) by default.
  const [selection, setSelection] = useState<ScanNowSelection>({
    trackIds: [],
    includeUnmatched: true,
  });
  const previewRequestRef = useRef(0);

  const byTrack = useMemo(
    () =>
      preview && preview !== "error" ? countScanCompaniesByTrack(preview) : null,
    [preview],
  );
  const selected = useMemo(
    () =>
      preview && preview !== "error"
        ? countScanSelection(preview, selection)
        : null,
    [preview, selection],
  );
  const allSelected =
    !!byTrack &&
    selection.trackIds.length === byTrack.tracks.length &&
    (byTrack.unmatched === 0 || selection.includeUnmatched);
  const noneSelected =
    selection.trackIds.length === 0 && !selection.includeUnmatched;

  const toggleTrack = (trackId: string, checked: boolean) =>
    setSelection((prev) => ({
      ...prev,
      trackIds: checked
        ? [...prev.trackIds, trackId]
        : prev.trackIds.filter((id) => id !== trackId),
    }));

  const toggleAll = (checked: boolean) =>
    setSelection({
      trackIds: checked && byTrack ? byTrack.tracks.map((t) => t.id) : [],
      includeUnmatched: checked,
    });

  useEffect(() => {
    let cancelled = false;
    getPendingAutomation()
      .then((data) => {
        if (!cancelled) setSettings(data);
      })
      .catch((err) => console.error("Failed to load pending automation:", err))
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (next: PendingAutomation) => {
    const previous = settings;
    const normalized = normalizePendingAutomation(next);
    setSettings(normalized);
    setSaving(true);
    try {
      const saved = await savePendingAutomation(normalized);
      setSettings({
        autoScan: saved.autoScan,
        autoPromote: saved.autoPromote,
        autoDrop: saved.autoDrop,
      });
    } catch (err) {
      console.error("Failed to save pending automation:", err);
      setSettings(previous);
      toast.error("Failed to update automation settings");
    } finally {
      setSaving(false);
    }
  };

  const openConfirm = async () => {
    const requestId = ++previewRequestRef.current;
    setPreview(null);
    setConfirmOpen(true);
    try {
      const data = await getScanNowPreview();
      if (previewRequestRef.current === requestId) {
        setSelection({
          trackIds: data.tracks.map((t) => t.id),
          includeUnmatched: true,
        });
        setPreview(data);
      }
    } catch (err) {
      console.error("Failed to estimate the scan:", err);
      if (previewRequestRef.current === requestId) setPreview("error");
    }
  };

  const handleScanNow = async () => {
    if (scanning) return;
    // Without a preview there is no selector, so the scan covers everything.
    const scope = preview && preview !== "error" ? selection : undefined;
    setConfirmOpen(false);
    setScanning(true);
    try {
      const { queued, alreadyQueued } = await scanPendingNow(scope);
      if (queued > 0) {
        toast.success(queuedMessage(queued, alreadyQueued));
        onQueued?.();
      } else if (alreadyQueued > 0) {
        toast.info(`All ${plural(alreadyQueued)} are already queued for AI screening`);
      } else if (scope) {
        toast.info("No pending companies are matched to the selected tracks");
      } else {
        toast.info("No companies are waiting in Pending Confirmation");
      }
    } catch (err) {
      console.error("Failed to start scan:", err);
      toast.error("Failed to start the scan");
    } finally {
      setScanning(false);
    }
  };

  const disabled = !loaded || saving;

  return (
    <div className="flex flex-wrap items-center gap-4">
      <label
        className="flex items-center gap-2 text-sm font-medium"
        title="Match each company added to Pending Confirmation from now on to your tracks and run AI screening against their criteria. Companies already waiting are not scanned — use Scan now for those."
      >
        <Switch
          data-testid={`${testIdPrefix}-auto-scan-toggle`}
          checked={settings.autoScan}
          disabled={disabled}
          onCheckedChange={(checked) =>
            save({ ...settings, autoScan: checked })
          }
        />
        Auto-scan
      </label>
      <label
        className="flex items-center gap-2 text-sm font-medium"
        title={
          settings.autoScan
            ? "After a scan: promote to L0 when screening passes"
            : "Turn on Auto-scan first"
        }
      >
        <Switch
          data-testid={`${testIdPrefix}-auto-promote-toggle`}
          checked={settings.autoPromote}
          disabled={disabled || !settings.autoScan}
          onCheckedChange={(checked) =>
            save({ ...settings, autoPromote: checked })
          }
        />
        Auto promote
      </label>
      <label
        className="flex items-center gap-2 text-sm font-medium"
        title={
          settings.autoScan
            ? "After a scan: drop when screening fails"
            : "Turn on Auto-scan first"
        }
      >
        <Switch
          data-testid={`${testIdPrefix}-auto-drop-toggle`}
          checked={settings.autoDrop}
          disabled={disabled || !settings.autoScan}
          onCheckedChange={(checked) =>
            save({ ...settings, autoDrop: checked })
          }
        />
        Auto drop
      </label>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid={`${testIdPrefix}-scan-now-button`}
        className="gap-2"
        disabled={scanning || pendingCount === 0}
        onClick={() => void openConfirm()}
        title="Match and AI-screen every company in Pending Confirmation now, generating any missing Company Card"
      >
        {scanning ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ScanSearch className="h-4 w-4" />
        )}
        Scan now
      </Button>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid={`${testIdPrefix}-scan-now-confirm`}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {selected
                ? `Scan ${plural(selected.companies)} now?`
                : "Scan Pending Confirmation now?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {preview === null ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Estimating…
                </span>
              ) : preview === "error" ? (
                `This AI-screens the ${plural(pendingCount)} waiting in Pending Confirmation. The time estimate is unavailable.`
              ) : preview.companies.length === 0 ? (
                "No companies are waiting in Pending Confirmation."
              ) : (
                "Choose the tracks to scan. Each company is AI-screened against each selected track it is matched to, and passes when any of them passes."
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {byTrack && selected && preview !== "error" && preview?.companies.length ? (
            <div className="space-y-3">
              <div
                className="max-h-64 overflow-y-auto rounded-md border bg-muted"
                data-testid={`${testIdPrefix}-scan-now-tracks`}
              >
                <label className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 text-sm font-medium">
                  <Checkbox
                    data-testid={`${testIdPrefix}-scan-now-track-all`}
                    checked={
                      allSelected ? true : noneSelected ? false : "indeterminate"
                    }
                    onCheckedChange={(checked) => toggleAll(checked === true)}
                  />
                  <span className="flex-1">All tracks</span>
                  <span className="tabular-nums text-muted-foreground">
                    {plural(preview.companies.length)}
                  </span>
                </label>
                {byTrack.tracks.map((track) => (
                  <label
                    key={track.id}
                    className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm"
                  >
                    <Checkbox
                      data-testid={`${testIdPrefix}-scan-now-track-${track.id}`}
                      checked={selection.trackIds.includes(track.id)}
                      onCheckedChange={(checked) =>
                        toggleTrack(track.id, checked === true)
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{track.title}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {plural(track.companies)}
                    </span>
                  </label>
                ))}
                {byTrack.unmatched > 0 && (
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                    <Checkbox
                      data-testid={`${testIdPrefix}-scan-now-track-unmatched`}
                      checked={selection.includeUnmatched}
                      onCheckedChange={(checked) =>
                        setSelection((prev) => ({
                          ...prev,
                          includeUnmatched: checked === true,
                        }))
                      }
                    />
                    <span className="min-w-0 flex-1">
                      Not matched to a track yet
                      <span className="block text-xs text-muted-foreground">
                        Matched to your tracks during the scan
                      </span>
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {plural(byTrack.unmatched)}
                    </span>
                  </label>
                )}
              </div>
              <div
                className="space-y-1 text-sm text-muted-foreground"
                data-testid={`${testIdPrefix}-scan-now-estimate`}
              >
                <p>
                  Total:{" "}
                  <strong className="font-semibold text-foreground">
                    {plural(selected.companies)}
                  </strong>
                  {selected.missingCards > 0 &&
                    `, ${selected.missingCards} generating a Company Card first`}
                  {selected.alreadyQueued > 0 &&
                    ` (${selected.alreadyQueued} already queued or scanning — skipped)`}
                  {" "}— a company in several selected tracks is counted once.
                </p>
                <p>
                  Total estimated time:{" "}
                  <strong className="font-semibold text-foreground">
                    {formatScanEstimate(selected)}
                  </strong>
                </p>
              </div>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`${testIdPrefix}-scan-now-cancel`}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid={`${testIdPrefix}-scan-now-confirm-button`}
              disabled={
                scanning ||
                preview === null ||
                (selected !== null && selected.companies === 0)
              }
              onClick={(e) => {
                e.preventDefault();
                void handleScanNow();
              }}
            >
              Start scan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
