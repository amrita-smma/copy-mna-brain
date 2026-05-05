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
import { Textarea } from '@/components/ui/textarea';
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
import { Loader2, Settings, Radar, Play, Sparkles, EyeOff, Eye, ChevronUp, ChevronDown } from 'lucide-react';
import { getActiveInvestmentThesis, saveInvestmentThesis } from '@/lib/api/pipeline';
import { waitForJob } from '@/lib/jobs/useJob';

interface InvestmentThesis {
  id: string;
  title: string;
  content: string;
  is_active: boolean;
  scan_frequency: string;
  last_scan_at: string | null;
  next_scan_at: string | null;
  sources_count: number;
}

interface MarketScreeningStatusProps {
  onScanComplete: () => void;
  newCandidatesCount: number;
  isVisible: boolean;
  onToggle: () => void;
}

export default function MarketScreeningStatus({ onScanComplete, newCandidatesCount, isVisible, onToggle }: MarketScreeningStatusProps) {
  const [thesis, setThesis] = useState<InvestmentThesis | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [showThesisDialog, setShowThesisDialog] = useState(false);

  // Form state
  const [thesisTitle, setThesisTitle] = useState('');
  const [thesisContent, setThesisContent] = useState('');
  const [scanFrequency, setScanFrequency] = useState('weekly');
  const [sourcesCount, setSourcesCount] = useState(5);

  const fetchThesis = async () => {
    try {
      const data = await getActiveInvestmentThesis();

      if (data) {
        setThesis(data as InvestmentThesis);
        setThesisTitle(data.title ?? '');
        setThesisContent(data.content ?? '');
        setScanFrequency(data.scan_frequency ?? 'weekly');
        setSourcesCount(data.sources_count ?? 5);
      }
    } catch (error: any) {
      console.error('Error fetching thesis:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchThesis();
  }, []);

  const saveThesis = async () => {
    try {
      if (!thesisContent.trim()) {
        toast.error('Please enter an investment thesis');
        return;
      }

      if (thesis) {
        await saveInvestmentThesis({
          id: thesis.id,
          title: thesisTitle,
          content: thesisContent,
          scan_frequency: scanFrequency,
          sources_count: sourcesCount,
        });
        toast.success('Investment thesis updated');
      } else {
        // Create new thesis
        const nextScan = new Date();
        if (scanFrequency === 'daily') {
          nextScan.setDate(nextScan.getDate() + 1);
        } else if (scanFrequency === 'weekly') {
          nextScan.setDate(nextScan.getDate() + 7);
        } else {
          nextScan.setMonth(nextScan.getMonth() + 1);
        }

        const data = await saveInvestmentThesis({
          title: thesisTitle || 'Default Thesis',
          content: thesisContent,
          scan_frequency: scanFrequency,
          sources_count: sourcesCount,
          next_scan_at: nextScan.toISOString(),
        });
        setThesis(data as InvestmentThesis);
        toast.success('Investment thesis created');
      }

      setShowThesisDialog(false);
      fetchThesis();
    } catch (error: any) {
      console.error('Error saving thesis:', error);
      toast.error('Failed to save thesis');
    }
  };

  const runScan = async () => {
    if (!thesis) {
      toast.error('Please set up an investment thesis first');
      setShowThesisDialog(true);
      return;
    }

    setScanning(true);
    try {
      const response = await fetch('/api/market-screening', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          thesisId: thesis.id,
          thesis: thesis.content,
          sourcesCount: thesis.sources_count,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.jobId) {
        throw new Error(data.error || 'Failed to start market screening');
      }

      const job = await waitForJob(data.jobId);

      if (job.status === 'completed') {
        const result = (job.result ?? {}) as { count?: number; message?: string };
        if (result.count && result.count > 0) {
          toast.success(`Found ${result.count} matching companies`);
        } else {
          toast.info(result.message || 'No new companies found');
        }
        fetchThesis();
        onScanComplete();
      } else {
        throw new Error(job.error || `Market screening ${job.status}`);
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

  const isActive = thesis?.is_active && thesis?.content;

  return (
    <div className="border border-purple-100 dark:border-purple-900/20 rounded-xl p-3 bg-purple-50/50 dark:bg-purple-950/10 backdrop-blur-sm w-full">
      <div className="flex flex-wrap items-center justify-between gap-y-3 gap-x-4 w-full min-w-0">

        {/* Left Section: Icon & Title */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="relative h-10 w-10 rounded-lg bg-gradient-to-br from-[#8B5CF6] to-[#6D28D9] flex items-center justify-center shadow-md shadow-purple-500/20 shrink-0">
            <Sparkles className="h-5 w-5 text-white" />
            {isActive && (
              <span className="absolute -bottom-1 -right-1 h-3 w-3 rounded-full bg-emerald-400 border-2 border-white dark:border-gray-900" />
            )}
          </div>

          <div className="flex flex-col justify-center min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-sm text-purple-600 dark:text-purple-400 whitespace-nowrap truncate">
                AI Market Scanning
              </h3>
              {isActive && (
                <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-purple-100 dark:bg-purple-500/20 text-[10px] font-semibold text-purple-600 dark:text-purple-300 border border-purple-200 dark:border-purple-500/30 whitespace-nowrap shrink-0">
                  <Radar className="h-2.5 w-2.5" />
                  Live
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground whitespace-nowrap truncate">
              Powered by AI thesis matching
            </p>
          </div>

          {isVisible && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggle}
              className="hidden xl:flex text-muted-foreground hover:text-foreground ml-1 h-6 px-2 shrink-0 gap-1"
            >
              <EyeOff className="h-3.5 w-3.5" />
              <span className="text-[10px]">Hide</span>
              <ChevronUp className="h-3 w-3 opacity-50" />
            </Button>
          )}
        </div>

        {/* Middle Section: Stats */}
        {isVisible && (
          <div className="hidden lg:flex items-center gap-4 xl:gap-8 shrink">
            <div className="flex flex-col gap-0.5 shrink-0">
              <span className="text-[10px] font-bold text-muted-foreground/70 uppercase tracking-wider whitespace-nowrap">
                LAST SCAN COMPLETED
              </span>
              <span className="text-xs font-semibold text-foreground/90 whitespace-nowrap">
                {thesis?.last_scan_at ? format(new Date(thesis.last_scan_at), 'MMM d, yyyy, hh:mm a') : '-'}
              </span>
            </div>

            <div className="flex flex-col gap-0.5 shrink-0">
              <span className="text-[10px] font-bold text-muted-foreground/70 uppercase tracking-wider whitespace-nowrap">
                NEXT SCAN
              </span>
              <span className="text-xs font-semibold text-foreground/90 whitespace-nowrap">
                {thesis?.next_scan_at ? format(new Date(thesis.next_scan_at), 'MMM d, yyyy, hh:mm a') : '-'}
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
        )}

        {/* Right Section: Actions */}
        {isVisible && (
          <div className="flex flex-col gap-2 shrink-0 ml-auto">
            <Dialog open={showThesisDialog} onOpenChange={setShowThesisDialog}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <Settings className="h-4 w-4 mr-2" />
                  Configure
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Investment Thesis Configuration</DialogTitle>
                  <DialogDescription>
                    Define your investment criteria. AI will search for companies matching this thesis.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 mt-4">
                  <div>
                    <Label htmlFor="thesis-title">Thesis Name</Label>
                    <Input
                      id="thesis-title"
                      value={thesisTitle}
                      onChange={(e) => setThesisTitle(e.target.value)}
                      placeholder="e.g., Healthcare SaaS Mid-Market"
                    />
                  </div>

                  <div>
                    <Label htmlFor="thesis-content">Investment Thesis</Label>
                    <Textarea
                      id="thesis-content"
                      value={thesisContent}
                      onChange={(e) => setThesisContent(e.target.value)}
                      placeholder="Describe your ideal investment target in detail. Include:
    - Target sectors and industries
    - Revenue range and growth requirements
    - EBITDA margins expectations
    - Geographic focus
    - Business model characteristics
    - Value creation opportunities"
                      rows={8}
                    />
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
                      Save Thesis
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>

            <Button
              onClick={runScan}
              disabled={scanning}
              className="bg-[#059669] hover:bg-[#047857] text-white shadow-sm font-medium h-7 px-3 text-xs w-full justify-start"
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
        )}

        {!isVisible && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggle}
            className="ml-auto flex text-muted-foreground hover:text-foreground h-7 px-3 shrink-0 gap-1.5"
          >
            <Eye className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">Show</span>
            <ChevronDown className="h-3 w-3 opacity-50" />
          </Button>
        )}
      </div>
    </div>
  );
}
