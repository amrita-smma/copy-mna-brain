import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Sparkles, Plus, Pencil, Trash2, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import posthog from 'posthog-js';
import {
  createCriteria,
  deleteCriteria,
  getCriterias,
  prepareScreenings,
  updateCriteria,
} from '@/lib/api/pipeline';
import { companyDisplayName } from '@/lib/companyDisplay';

interface Company {
  id: string;
  name: string;
  target?: string | null;
  project_name?: string | null;
  segment?: string | null;
  geography?: string | null;
  company_focus?: string | null;
  ownership?: string | null;
  website?: string | null;
  revenue_2022_usd_mn?: number | null;
  revenue_2023_usd_mn?: number | null;
  revenue_2024_usd_mn?: number | null;
  ebitda_2022_usd_mn?: number | null;
  ebitda_2023_usd_mn?: number | null;
  ebitda_2024_usd_mn?: number | null;
  ev_2024?: number | null;
}



interface AIScreeningDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companies: Company[];
  onComplete: () => void;
}

interface Criteria {
  id: string;
  name: string;
  prompt: string;
}

export default function AIScreeningDialog({
  open,
  onOpenChange,
  companies,
  onComplete,
}: AIScreeningDialogProps) {
  const [criteria, setCriteria] = useState<Criteria[]>([]);
  const [isLoadingCriteria, setIsLoadingCriteria] = useState(true);
  const [newCriterionName, setNewCriterionName] = useState('');
  const [newCriterionPrompt, setNewCriterionPrompt] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [isScreening, setIsScreening] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Fetch criteria from database on mount
  useEffect(() => {
    const fetchCriteria = async () => {
      setIsLoadingCriteria(true);
      try {
        const data = await getCriterias();
        setCriteria(data || []);
      } catch (error: any) {
        console.error('Error fetching criteria:', error);
        toast.error('Failed to load screening criteria');
      } finally {
        setIsLoadingCriteria(false);
      }
    };

    if (open) {
      fetchCriteria();
    }
  }, [open]);

  const addCriterion = async () => {
    if (!newCriterionName.trim() || !newCriterionPrompt.trim()) return;

    setIsSaving(true);
    try {
      const data = await createCriteria(newCriterionName.trim(), newCriterionPrompt.trim());

      setCriteria([...criteria, data]);
      setNewCriterionName('');
      setNewCriterionPrompt('');

      // Capture criterion added event
      posthog.capture('screening_criterion_added', {
        criterion_id: data.id,
        criterion_name: data.name,
      });

      toast.success('Criterion added');
    } catch (error: any) {
      console.error('Error adding criterion:', error);
      toast.error('Failed to add criterion');
    } finally {
      setIsSaving(false);
    }
  };

  const deleteCriterion = async (index: number) => {
    const criterionToDelete = criteria[index];

    try {
      await deleteCriteria(criterionToDelete.id);

      setCriteria(criteria.filter((_, i) => i !== index));

      // Capture criterion deleted event
      posthog.capture('screening_criterion_deleted', {
        criterion_id: criterionToDelete.id,
        criterion_name: criterionToDelete.name,
      });

      toast.success('Criterion deleted');
    } catch (error: any) {
      console.error('Error deleting criterion:', error);
      toast.error('Failed to delete criterion');
    }
  };

  const startEdit = (index: number) => {
    setEditingIndex(index);
    setEditName(criteria[index].name);
    setEditPrompt(criteria[index].prompt);
  };

  const saveEdit = async () => {
    if (editingIndex === null || !editName.trim() || !editPrompt.trim()) return;

    const criterionToUpdate = criteria[editingIndex];
    setIsSaving(true);

    try {
      await updateCriteria(criterionToUpdate.id, editName.trim(), editPrompt.trim());

      const newCriteria = [...criteria];
      newCriteria[editingIndex] = {
        ...criterionToUpdate,
        name: editName.trim(),
        prompt: editPrompt.trim(),
      };
      setCriteria(newCriteria);
      setEditingIndex(null);
      setEditName('');
      setEditPrompt('');
      toast.success('Criterion updated');
    } catch (error: any) {
      console.error('Error updating criterion:', error);
      toast.error('Failed to update criterion');
    } finally {
      setIsSaving(false);
    }
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditName('');
    setEditPrompt('');
  };

  const runScreening = async () => {
    if (criteria.length === 0) {
      toast.error('Please add at least one screening criterion');
      return;
    }

    if (companies.length === 0) {
      toast.error('No companies selected for screening');
      return;
    }

    setIsScreening(true);

    try {
      const screeningEntries = await prepareScreenings(
        companies.map((c) => c.id),
        criteria.map((c) => c.id)
      );

      // Capture AI screening started event
      posthog.capture('ai_screening_started', {
        company_count: companies.length,
        criteria_count: criteria.length,
        total_screenings: screeningEntries.length,
      });

      toast.success(`Started AI screening for ${companies.length} companies with ${criteria.length} criteria`);

      // Close the dialog immediately - progress will be shown in Pipeline view
      onOpenChange(false);
      onComplete();

      // Step 2: Dispatch one job per (company, criteria) pair. The job handler
      // writes the screening row's final state on completion; we don't poll
      // here — the pipeline view re-reads screenings after onComplete().
      screeningEntries.forEach((entry) => {
        const company = companies.find((c) => c.id === entry.company_id);
        const criterion = criteria.find((c) => c.id === entry.criteria_id);

        if (!company || !criterion) return;

        void fetch('/api/ai-screening', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            companyId: company.id,
            criteriaId: criterion.id,
            criteriaPrompt: criterion.prompt,
            screeningId: entry.id,
            company: {
              id: company.id,
              name: companyDisplayName(company, company.name || ''),
              segment: company.segment,
              geography: company.geography,
              company_focus: company.company_focus,
              ownership: company.ownership,
              website: company.website,
              revenue_2022_usd_mn: company.revenue_2022_usd_mn,
              revenue_2023_usd_mn: company.revenue_2023_usd_mn,
              revenue_2024_usd_mn: company.revenue_2024_usd_mn,
              ebitda_2022_usd_mn: company.ebitda_2022_usd_mn,
              ebitda_2023_usd_mn: company.ebitda_2023_usd_mn,
              ebitda_2024_usd_mn: company.ebitda_2024_usd_mn,
              ev_2024: company.ev_2024,
            },
          }),
        }).catch((err) => {
          console.error(`Failed to dispatch screening ${company.id}/${criterion.id}:`, err);
        });
      });
    } catch (error: any) {
      console.error('Screening error:', error);
      toast.error(error.message || 'Failed to start AI screening');
    } finally {
      setIsScreening(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <div>
              <DialogTitle className="text-xl">AI Screening</DialogTitle>
              <DialogDescription>
                Configure screening criteria in natural language
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Criteria Header */}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold">Screening Criteria</h3>
              <p className="text-sm text-muted-foreground">
                Define your criteria using Natural Language, AI will do the rest
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => document.getElementById('new-criterion-input')?.focus()}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add New
            </Button>
          </div>

          {/* Criteria List */}
          <div className="space-y-3">
            {isLoadingCriteria ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                <span className="ml-2 text-muted-foreground">Loading criteria...</span>
              </div>
            ) : criteria.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No screening criteria found. Add your first criterion below.
              </div>
            ) : (
              criteria.map((criterion, index) => (
                <div
                  key={criterion.id}
                  className="flex items-start gap-3 p-4 border rounded-lg bg-card"
                >
                  <Badge
                    variant="secondary"
                    className="shrink-0 h-6 w-6 rounded-full p-0 flex items-center justify-center bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                  >
                    {index + 1}
                  </Badge>

                  {editingIndex === index ? (
                    <div className="flex-1 space-y-2">
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Name</label>
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder="Criterion name"
                          disabled={isSaving}
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Prompt</label>
                        <Input
                          value={editPrompt}
                          onChange={(e) => setEditPrompt(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                          placeholder="Screening prompt"
                          autoFocus
                          disabled={isSaving}
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={saveEdit} disabled={isSaving || !editName.trim() || !editPrompt.trim()}>
                          {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={isSaving}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex-1 pt-0.5">
                        <div className="font-medium text-sm">{criterion.name}</div>
                        <div className="text-muted-foreground text-sm">{criterion.prompt}</div>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => startEdit(index)}
                        >
                          <Pencil className="h-3.5 w-3.5 mr-1" />
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                          onClick={() => deleteCriterion(index)}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-1" />
                          Delete
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ))
            )}

            {/* Add New Criterion Input */}
            <div className="space-y-2 p-4 border rounded-lg border-dashed">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Name</label>
                <Input
                  placeholder="e.g., Asia Revenue Check"
                  value={newCriterionName}
                  onChange={(e) => setNewCriterionName(e.target.value)}
                  disabled={isSaving}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Prompt</label>
                <Input
                  id="new-criterion-input"
                  placeholder="e.g., Revenue contribution from Asia > 30%"
                  value={newCriterionPrompt}
                  onChange={(e) => setNewCriterionPrompt(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !isSaving && addCriterion()}
                  disabled={isSaving}
                />
              </div>
              <Button onClick={addCriterion} disabled={!newCriterionName.trim() || !newCriterionPrompt.trim() || isSaving}>
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add Criterion'}
              </Button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-4 border-t">
          <span className="text-sm text-muted-foreground">
            {companies.length} companies selected, {criteria.length} criteria
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={runScreening}
              disabled={isScreening || isLoadingCriteria || criteria.length === 0}
              className="bg-gradient-to-r from-purple-600 to-purple-500"
            >
              {isScreening ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4 mr-2" />
                  Run AI Screening
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
