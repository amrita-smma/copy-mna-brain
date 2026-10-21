"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, ScanSearch } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
  DEFAULT_PENDING_AUTOMATION,
  formatScanEstimate,
  normalizePendingAutomation,
  type PendingAutomation,
  type ScanNowPreview,
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
  const previewRequestRef = useRef(0);

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
      if (previewRequestRef.current === requestId) setPreview(data);
    } catch (err) {
      console.error("Failed to estimate the scan:", err);
      if (previewRequestRef.current === requestId) setPreview("error");
    }
  };

  const handleScanNow = async () => {
    if (scanning) return;
    setConfirmOpen(false);
    setScanning(true);
    try {
      const { queued, alreadyQueued } = await scanPendingNow();
      if (queued > 0) {
        toast.success(queuedMessage(queued, alreadyQueued));
        onQueued?.();
      } else if (alreadyQueued > 0) {
        toast.info(`All ${plural(alreadyQueued)} are already queued for AI screening`);
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
              {preview && preview !== "error"
                ? `Scan ${plural(preview.companies)} now?`
                : "Scan Pending Confirmation now?"}
            </AlertDialogTitle>
            <AlertDialogDescription
              data-testid={`${testIdPrefix}-scan-now-estimate`}
            >
              {preview === null ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Estimating…
                </span>
              ) : preview === "error" ? (
                `This AI-screens the ${plural(pendingCount)} waiting in Pending Confirmation. The time estimate is unavailable.`
              ) : preview.companies === 0 ? (
                "Every company in Pending Confirmation is already queued for AI screening."
              ) : (
                <>
                  {`This AI-screens ${plural(preview.companies)} in Pending Confirmation` +
                    (preview.missingCards > 0
                      ? `, generating the Company Card first for the ${preview.missingCards} without one`
                      : "") +
                    "."}
                  <span className="mt-2 block">
                    Total estimated time:{" "}
                    <strong className="font-semibold text-foreground">
                      {formatScanEstimate(preview)}
                    </strong>
                  </span>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`${testIdPrefix}-scan-now-cancel`}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid={`${testIdPrefix}-scan-now-confirm-button`}
              disabled={
                scanning ||
                preview === null ||
                (preview !== "error" && preview.companies === 0)
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
