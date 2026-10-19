import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Loader2, Settings, Radar, Play, Sparkles } from 'lucide-react';
import { getTracks, configureMarketScan, type Track } from '@/lib/api/pipeline';
import { apiRequest } from '@/lib/api/client';
import { trackDisplayName } from '@/lib/tracks/matchTracks';
import TrackMultiSelect from '@/components/pipeline/TrackMultiSelect';
import { waitForWorkforceRun } from '@/lib/jobs/useJob';

interface MarketScreeningStatusProps {
  onScanComplete: () => void;
  newCandidatesCount: number;
  /** Bumped by the parent (e.g. after Pipeline Settings saves) to force a track refetch. */
  refreshKey?: number;
}

export default function MarketScreeningStatus({ onScanComplete, newCandidatesCount, refreshKey = 0 }: MarketScreeningStatusProps) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [showThesisDialog, setShowThesisDialog] = useState(false);

  // Configuration form state
  const [selectedThesisIds, setSelectedThesisIds] = useState<string[]>([]);
  const [scanFrequency, setScanFrequency] = useState('weekly');
  const [sourcesCount, setSourcesCount] = useState(5);

  // The active scanning set drives the live badge + scan stats.
  const activeTracks = tracks.filter((t) => t.is_active);
  const primaryThesis = activeTracks[0] ?? null;

  const fetchTracks = async () => {
    try {
      const data = await getTracks();
      setTracks(data);
      const active = data.filter((t) => t.is_active);
      setSelectedThesisIds(active.map((t) => t.id));
      setScanFrequency(active[0]?.scan_frequency ?? 'weekly');
      setSourcesCount(active[0]?.sources_count ?? 5);
    } catch (error: any) {
      console.error('Error fetching tracks:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTracks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const saveThesis = async () => {
    if (!selectedThesisIds.length) {
      toast.error('Select at least one thesis to scan');
      return;
    }
    try {
      const updated = await configureMarketScan({
        thesisIds: selectedThesisIds,
        scan_frequency: scanFrequency,
        sources_count: sourcesCount,
      });
      setTracks(updated);
      toast.success('Market scan configuration saved');
      setShowThesisDialog(false);
    } catch (error: any) {
      console.error('Error saving scan configuration:', error);
      toast.error('Failed to save configuration');
    }
  };

  const runScan = async () => {
    if (!activeTracks.length) {
      toast.error('Select at least one thesis to scan first');
      setShowThesisDialog(true);
      return;
    }

    // Scan the combined active theses in one pass.
    const combinedThesis = activeTracks
      .map((t) => t.content)
      .filter(Boolean)
      .join('\n\n---\n\n');

    setScanning(true);
    try {
      const data = await apiRequest<{ jobId?: string }>('/api/market-screening', {
        method: 'POST',
        body: JSON.stringify({
          thesis: combinedThesis,
          sourcesCount: primaryThesis?.sources_count ?? sourcesCount,
        }),
      });

      if (!data.jobId) {
        throw new Error('Failed to start market screening');
      }

      const run = await waitForWorkforceRun(data.jobId);

      if (run.status === 'succeeded') {
        const finalMessage = (run.result as { final_message?: string } | null)?.final_message;
        toast.success(finalMessage || 'Market screening completed');
        fetchTracks();
        onScanComplete();
      } else {
        throw new Error(run.error || `Market screening ${run.status}`);
      }
    } catch (error: any) {
      console.error('Error running scan:', error);
      toast.error(error.message || 'Failed to run market screening');
    } finally {
      setScanning(false);
    }
  };

  if (loading) {
    return (
      <div className="border rounded-lg p-4 bg-card animate-pulse">
        <div className="h-6 bg-muted rounded w-48"></div>
      </div>
    );
  }

  const isActive = activeTracks.length > 0;
  const activeThesisLabel = activeTracks.map(trackDisplayName).join(', ');

  // A scan covers the whole active set, so report the most recent completion
  // and the soonest upcoming scan across all active tracks — not just the first.
  const lastScanAt = activeTracks
    .map((t) => t.last_scan_at)
    .filter((v): v is string => Boolean(v))
    .reduce<string | null>((latest, v) => (!latest || new Date(v) > new Date(latest) ? v : latest), null);
  const nextScanAt = activeTracks
    .map((t) => t.next_scan_at)
    .filter((v): v is string => Boolean(v))
    .reduce<string | null>((soonest, v) => (!soonest || new Date(v) < new Date(soonest) ? v : soonest), null);

  return (
    <div className="border rounded-lg p-3 bg-card shadow-md w-full">
      {/* Header Row: identity on the left, actions on the right */}
      <div className="flex flex-wrap items-center justify-between gap-3 w-full min-w-0">

        {/* Left Section: Icon & Title */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="relative h-10 w-10 rounded-lg bg-gradient-to-br from-[#1F5FE0] to-[#1838CC] flex items-center justify-center shadow-md shadow-blue-500/20 shrink-0">
            <Sparkles className="h-5 w-5 text-white" />
            {isActive && (
              <span className="absolute -bottom-1 -right-1 h-3 w-3 rounded-full bg-emerald-400 border-2 border-white dark:border-gray-900" />
            )}
          </div>

          <div className="flex flex-col justify-center min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-sm text-blue-600 dark:text-blue-400 whitespace-nowrap truncate">
                AI Market Scanning
              </h3>
              {isActive && (
                <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-500/20 text-[10px] font-semibold text-blue-600 dark:text-blue-300 border border-blue-200 dark:border-blue-500/30 whitespace-nowrap shrink-0">
                  <Radar className="h-2.5 w-2.5" />
                  Live
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground whitespace-nowrap truncate" title={activeThesisLabel || undefined}>
              {isActive
                ? activeTracks.length === 1
                  ? activeThesisLabel
                  : `${activeTracks.length} theses active`
                : 'Powered by AI thesis matching'}
            </p>
          </div>
        </div>

        {/* Right Section: Actions */}
        <div className="flex items-center gap-2 shrink-0 ml-auto">
          <Dialog open={showThesisDialog} onOpenChange={setShowThesisDialog}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                <Settings className="h-4 w-4 mr-2" />
                Configure
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>Investment Thesis Configuration</DialogTitle>
                <DialogDescription>
                  Choose which theses to scan. AI will search for companies matching the selected
                  theses. Author thesis content with the Track button at the top of this page.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 mt-4">
                <div className="space-y-1.5">
                  <Label>Theses</Label>
                  <TrackMultiSelect
                    tracks={tracks}
                    value={selectedThesisIds}
                    onChange={setSelectedThesisIds}
                    placeholder="Select theses to scan…"
                  />
                  {tracks.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No theses yet — create one with the Track button at the top of this page.
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="scan-frequency">Scan Frequency</Label>
                    <Select value={scanFrequency} onValueChange={setScanFrequency}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select frequency" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="daily">Daily</SelectItem>
                        <SelectItem value="weekly">Weekly</SelectItem>
                        <SelectItem value="monthly">Monthly</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label htmlFor="sources-count">Companies per Scan</Label>
                    <Input
                      id="sources-count"
                      type="number"
                      min={1}
                      max={20}
                      value={sourcesCount}
                      onChange={(e) => setSourcesCount(parseInt(e.target.value) || 5)}
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-4">
                  <Button variant="outline" onClick={() => setShowThesisDialog(false)}>
                    Cancel
                  </Button>
                  <Button onClick={saveThesis}>
                    Save Configuration
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          <Button
            onClick={runScan}
            disabled={scanning}
            size="sm"
            className="bg-[#059669] hover:bg-[#047857] text-white shadow-sm font-medium"
          >
            {scanning ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                Scanning...
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5 mr-2 fill-current" />
                Run Scan Now
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Details Row: scan stats below the header */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 mt-3 pt-3 border-t">
        <div className="flex flex-col gap-0.5 shrink-0">
          <span className="text-[10px] font-bold text-muted-foreground/70 uppercase tracking-wider whitespace-nowrap">
            LAST SCAN COMPLETED
          </span>
          <span className="text-xs font-semibold text-foreground/90 whitespace-nowrap">
            {lastScanAt ? format(new Date(lastScanAt), 'MMM d, yyyy, hh:mm a') : '-'}
          </span>
        </div>

        <div className="flex flex-col gap-0.5 shrink-0">
          <span className="text-[10px] font-bold text-muted-foreground/70 uppercase tracking-wider whitespace-nowrap">
            NEXT SCAN
          </span>
          <span className="text-xs font-semibold text-foreground/90 whitespace-nowrap">
            {nextScanAt ? format(new Date(nextScanAt), 'MMM d, yyyy, hh:mm a') : '-'}
          </span>
        </div>

        <div className="flex flex-col gap-0.5 shrink-0">
          <span className="text-[10px] font-bold text-muted-foreground/70 uppercase tracking-wider whitespace-nowrap">
            NEW CANDIDATES (LAST 7D)
          </span>
          <span className="text-xs font-semibold text-foreground/90 whitespace-nowrap">
            {newCandidatesCount}
          </span>
        </div>
      </div>
    </div>
  );
}
