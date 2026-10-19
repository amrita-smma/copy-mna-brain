"use client";

import { useEffect, useState } from "react";
import { Loader2, ScanSearch } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  getPendingAutomation,
  savePendingAutomation,
  scanPendingNow,
} from "@/lib/api/pendingAutomation";
import {
  DEFAULT_PENDING_AUTOMATION,
  normalizePendingAutomation,
  type PendingAutomation,
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

  const handleScanNow = async () => {
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
        onClick={handleScanNow}
        title="Match and AI-screen every company in Pending Confirmation now, generating any missing Company Card"
      >
        {scanning ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ScanSearch className="h-4 w-4" />
        )}
        Scan now
      </Button>
    </div>
  );
}
