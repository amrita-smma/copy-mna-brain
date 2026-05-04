import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from 'sonner';
import { Plus, Upload, FileSpreadsheet, Loader2, Trash2 } from 'lucide-react';
import ExcelJS from 'exceljs';
import { createCompany } from '@/lib/api/pipeline';

interface CompanyFormData {
  name: string;
  project_name: string;
  sector: string;
  revenue_year1: string;
  revenue_year2: string;
  revenue_year3: string;
  ebitda_year1: string;
  ebitda_year2: string;
  ebitda_year3: string;
  valuation: string;
}

const emptyForm: CompanyFormData = {
  name: '',
  project_name: '',
  sector: '',
  revenue_year1: '',
  revenue_year2: '',
  revenue_year3: '',
  ebitda_year1: '',
  ebitda_year2: '',
  ebitda_year3: '',
  valuation: '',
};

interface L0AddCompanyProps {
  onSuccess: () => void;
}

export default function L0AddCompany({ onSuccess }: L0AddCompanyProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState<CompanyFormData>(emptyForm);
  const [importedCompanies, setImportedCompanies] = useState<CompanyFormData[]>([]);
  const [isImporting, setIsImporting] = useState(false);

  const handleInputChange = (field: keyof CompanyFormData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const parseNumber = (value: string): number | null => {
    const parsed = parseFloat(value.replace(/,/g, ''));
    return isNaN(parsed) ? null : parsed;
  };

  const handleSubmitSingle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || !formData.sector) {
      toast.error('Please fill in company name and sector');
      return;
    }

    setIsSubmitting(true);
    try {
      await createCompany({
        target: formData.name,
        project_name: formData.project_name.trim() || null,
        segment: formData.sector,
        revenue_2022_usd_mn: parseNumber(formData.revenue_year1),
        revenue_2023_usd_mn: parseNumber(formData.revenue_year2),
        revenue_2024_usd_mn: parseNumber(formData.revenue_year3),
        ebitda_2022_usd_mn: parseNumber(formData.ebitda_year1),
        ebitda_2023_usd_mn: parseNumber(formData.ebitda_year2),
        ebitda_2024_usd_mn: parseNumber(formData.ebitda_year3),
        ev_2024: parseNumber(formData.valuation),
        pipeline_stage: 'L0',
        status: 'active',
      }, 'ADDED_TO_PIPELINE');

      toast.success(`${formData.name} added to pipeline!`);
      setFormData(emptyForm);
      onSuccess();
    } catch (error: any) {
      console.error('Error adding company:', error);
      toast.error(error.message || 'Failed to add company');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    try {
      const data = await file.arrayBuffer();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(data as any);
      const worksheet = workbook.worksheets[0];

      const jsonData: any[] = [];
      let headers: string[] = [];

      worksheet.eachRow((row, rowNumber) => {
        const rowValues = row.values as any[];
        // row.values is 1-based [empty, val1, val2, ...]
        if (rowNumber === 1) {
          headers = rowValues.slice(1).map(v => v?.toString() || "");
        } else {
          const rowData: any = {};
          headers.forEach((header, idx) => {
            // idx matches result of slice(1)
            // value matches slice(1)[idx]
            // actually safe way:
            const val = rowValues[idx + 1];
            if (header) {
              rowData[header] = val;
            }
          });
          jsonData.push(rowData);
        }
      });

      const companies: CompanyFormData[] = jsonData.map((row: any) => ({
        name: row['Company Name'] || row['name'] || '',
        project_name: row['Project Name'] || row['project_name'] || '',
        sector: row['Sector'] || row['sector'] || '',
        revenue_year1: String(row['Revenue Year 1'] || row['revenue_year1'] || ''),
        revenue_year2: String(row['Revenue Year 2'] || row['revenue_year2'] || ''),
        revenue_year3: String(row['Revenue Year 3'] || row['revenue_year3'] || ''),
        ebitda_year1: String(row['EBITDA Year 1'] || row['ebitda_year1'] || ''),
        ebitda_year2: String(row['EBITDA Year 2'] || row['ebitda_year2'] || ''),
        ebitda_year3: String(row['EBITDA Year 3'] || row['ebitda_year3'] || ''),
        valuation: String(row['Valuation'] || row['valuation'] || ''),
      }));

      setImportedCompanies(companies.filter((c) => c.name));
      toast.success(`Found ${companies.filter((c) => c.name).length} companies in file`);
    } catch (error) {
      console.error('Error parsing file:', error);
      toast.error('Failed to parse Excel file');
    } finally {
      setIsImporting(false);
    }
  };

  const handleImportAll = async () => {
    if (importedCompanies.length === 0) return;

    setIsImporting(true);
    let successCount = 0;

    try {
      for (const company of importedCompanies) {
        if (!company.name || !company.sector) continue;

        await createCompany({
          target: company.name,
          project_name: company.project_name.trim() || null,
          segment: company.sector,
          revenue_2022_usd_mn: parseNumber(company.revenue_year1),
          revenue_2023_usd_mn: parseNumber(company.revenue_year2),
          revenue_2024_usd_mn: parseNumber(company.revenue_year3),
          ebitda_2022_usd_mn: parseNumber(company.ebitda_year1),
          ebitda_2023_usd_mn: parseNumber(company.ebitda_year2),
          ebitda_2024_usd_mn: parseNumber(company.ebitda_year3),
          ev_2024: parseNumber(company.valuation),
          pipeline_stage: 'L0',
          status: 'active',
        }, 'ADDED_TO_PIPELINE');

        successCount++;
      }

      toast.success(`Successfully imported ${successCount} companies!`);
      setImportedCompanies([]);
      onSuccess();
    } catch (error: any) {
      console.error('Error importing companies:', error);
      toast.error(error.message || 'Failed to import companies');
    } finally {
      setIsImporting(false);
    }
  };

  const removeImportedCompany = (index: number) => {
    setImportedCompanies((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <Tabs defaultValue="import" className="w-full">
      <TabsList className="mb-4">
        <TabsTrigger value="import">
          <FileSpreadsheet className="mr-2 h-4 w-4" />
          CSV/Excel Import
        </TabsTrigger>
        <TabsTrigger value="manual">
          <Plus className="mr-2 h-4 w-4" />
          Manual Entry
        </TabsTrigger>
      </TabsList>

      <TabsContent value="manual">
        <form onSubmit={handleSubmitSingle} className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">Company Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => handleInputChange('name', e.target.value)}
                placeholder="Acme Corp"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="project_name">Project Name</Label>
              <Input
                id="project_name"
                value={formData.project_name}
                onChange={(e) => handleInputChange('project_name', e.target.value)}
                placeholder="e.g. Project Phoenix"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sector">Sector *</Label>
              <Input
                id="sector"
                value={formData.sector}
                onChange={(e) => handleInputChange('sector', e.target.value)}
                placeholder="Technology"
              />
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="font-medium">Revenue (3 Years)</h3>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="revenue_year1">Year 1</Label>
                <Input
                  id="revenue_year1"
                  value={formData.revenue_year1}
                  onChange={(e) => handleInputChange('revenue_year1', e.target.value)}
                  placeholder="10,000,000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="revenue_year2">Year 2</Label>
                <Input
                  id="revenue_year2"
                  value={formData.revenue_year2}
                  onChange={(e) => handleInputChange('revenue_year2', e.target.value)}
                  placeholder="12,000,000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="revenue_year3">Year 3</Label>
                <Input
                  id="revenue_year3"
                  value={formData.revenue_year3}
                  onChange={(e) => handleInputChange('revenue_year3', e.target.value)}
                  placeholder="15,000,000"
                />
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="font-medium">EBITDA (3 Years)</h3>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="ebitda_year1">Year 1</Label>
                <Input
                  id="ebitda_year1"
                  value={formData.ebitda_year1}
                  onChange={(e) => handleInputChange('ebitda_year1', e.target.value)}
                  placeholder="1,500,000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ebitda_year2">Year 2</Label>
                <Input
                  id="ebitda_year2"
                  value={formData.ebitda_year2}
                  onChange={(e) => handleInputChange('ebitda_year2', e.target.value)}
                  placeholder="1,800,000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ebitda_year3">Year 3</Label>
                <Input
                  id="ebitda_year3"
                  value={formData.ebitda_year3}
                  onChange={(e) => handleInputChange('ebitda_year3', e.target.value)}
                  placeholder="2,200,000"
                />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="valuation">Company Valuation (USD)</Label>
            <Input
              id="valuation"
              value={formData.valuation}
              onChange={(e) => handleInputChange('valuation', e.target.value)}
              placeholder="50,000,000"
            />
          </div>

          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-2 h-4 w-4" />
            )}
            Add to Pipeline
          </Button>
        </form>
      </TabsContent>

      <TabsContent value="import" className="space-y-4">
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Upload CSV or Excel File</Label>
            <p className="text-sm text-muted-foreground">
              Expected columns: Company Name, Sector, Revenue Year 1-3, EBITDA Year 1-3, Valuation
            </p>
          </div>
          <div className="border-2 border-dashed rounded-lg p-6 text-center hover:border-primary/50 transition-colors">
            <FileSpreadsheet className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm font-medium mb-1">Drop your file here or click to browse</p>
            <p className="text-xs text-muted-foreground mb-3">Supports .csv, .xlsx, .xls files</p>
            <div className="flex items-center justify-center gap-4">
              <Input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileUpload}
                className="max-w-xs cursor-pointer"
              />
              {isImporting && <Loader2 className="h-5 w-5 animate-spin" />}
            </div>
          </div>
        </div>

        {importedCompanies.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">
                {importedCompanies.length} companies ready to import
              </p>
              <Button onClick={handleImportAll} disabled={isImporting}>
                {isImporting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                Import All
              </Button>
            </div>

            <div className="max-h-64 overflow-y-auto border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead>Sector</TableHead>
                    <TableHead>Revenue (Y3)</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {importedCompanies.map((company, index) => (
                    <TableRow key={index}>
                      <TableCell className="font-medium">{company.name}</TableCell>
                      <TableCell>{company.sector}</TableCell>
                      <TableCell>{company.revenue_year3 || '-'}</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeImportedCompany(index)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
