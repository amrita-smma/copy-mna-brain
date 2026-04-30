'use client';

import DashboardLayout from '@/components/layout/DashboardLayout';
import FilePreview from '@/components/Files/FilePreview';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import {
  AlertCircle,
  Bot,
  Building,
  CalendarIcon,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  Download,
  Eye,
  File,
  FileSpreadsheet,
  FileText,
  FileUp,
  FileStack,
  Loader2,
  Search,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import posthog from 'posthog-js';

interface FileRecord {
  id: string;
  file_name: string;
  raw_notes: string | null;
  structured_notes: string | null;
  processing_status: 'pending' | 'processing' | 'completed' | 'failed';
  tags: string[];
  matched_companies: any[];
  signed_url?: string;
  file_date: string | null;
  created_at: string;
  updated_at: string;
}

// Keep these for backward compatibility
type MeetingNote = FileRecord;
type Prospectus = FileRecord;
type OtherFile = FileRecord;

// Reusable FileTable component props
interface FileTableProps {
  title: string;
  icon: React.ReactNode;
  iconColor: string;
  files: FileRecord[];
  filteredFiles: FileRecord[];
  searchQuery: string;
  onSearchChange: (query: string) => void;
  sortField: keyof FileRecord;
  sortDirection: 'asc' | 'desc';
  onSort: (field: keyof FileRecord) => void;
  expandedTags: Record<string, boolean>;
  toggleTags: (id: string) => void;
  expandedCompanies: Record<string, boolean>;
  toggleCompanies: (id: string) => void;
  onUpdateDate: (id: string, date: Date | undefined) => void;
  onDownload: (id: string, fileName: string) => Promise<void>;
  onDelete: (id: string) => void;
  downloadingId: string | null;
  deletingId: string | null;
  emptyMessage: string;
  emptySubMessage: string;
  currentPage: number;
  onPageChange: (page: number) => void;
  itemsPerPage?: number;
}

function FileTable({
  title,
  icon,
  iconColor,
  files,
  filteredFiles,
  searchQuery,
  onSearchChange,
  sortField,
  sortDirection,
  onSort,
  expandedTags,
  toggleTags,
  expandedCompanies,
  toggleCompanies,
  onUpdateDate,
  onDownload,
  onDelete,
  downloadingId,
  deletingId,
  emptyMessage,
  emptySubMessage,
  currentPage,
  onPageChange,
  itemsPerPage = 10,
}: FileTableProps) {
  const totalPages = Math.max(1, Math.ceil(filteredFiles.length / itemsPerPage));
  const paginatedFiles = filteredFiles.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );
  const SortIcon = ({ field }: { field: keyof FileRecord }) => {
    if (sortField !== field) return <ChevronsUpDown className="h-3 w-3 ml-1 opacity-50" />;
    return sortDirection === 'asc' ?
      <ChevronUp className="h-3 w-3 ml-1 text-primary" /> :
      <ChevronDown className="h-3 w-3 ml-1 text-primary" />;
  };

  const renderStatusBadge = (status: FileRecord['processing_status']) => {
    switch (status) {
      case 'processing':
        return (
          <Badge variant="outline" className="flex items-center gap-1 text-blue-500 bg-blue-500/5 border-blue-200">
            <Loader2 className="h-3 w-3 animate-spin" />
            Processing
          </Badge>
        );
      case 'completed':
        return (
          <Badge variant="outline" className="flex items-center gap-1 text-green-600 bg-green-500/5 border-green-200">
            <CheckCircle2 className="h-3 w-3" />
            Completed
          </Badge>
        );
      case 'failed':
        return (
          <Badge variant="outline" className="flex items-center gap-1 text-red-600 bg-red-500/5 border-red-200">
            <AlertCircle className="h-3 w-3" />
            Failed
          </Badge>
        );
      case 'pending':
      default:
        return (
          <Badge variant="outline" className="flex items-center gap-1 text-gray-500 bg-gray-500/5 border-gray-200">
            Pending
          </Badge>
        );
    }
  };

  const renderTags = (note: FileRecord) => (
    <div className="flex flex-wrap gap-1">
      {note.tags && note.tags.length > 0 ? (
        <>
          {(expandedTags[note.id] ? note.tags : note.tags.slice(0, 3)).map((tag, i) => (
            <Badge key={i} variant="secondary" className="text-[10px] py-0 px-1.5 flex items-center gap-1">
              <Tag className="h-2.5 w-2.5" />
              {tag}
            </Badge>
          ))}
          {note.tags.length > 3 && (
            <Badge
              variant="outline"
              className="text-[10px] py-0 px-1.5 cursor-pointer hover:bg-muted"
              onClick={() => toggleTags(note.id)}
            >
              {expandedTags[note.id] ? 'Show less' : `+${note.tags.length - 3} more`}
            </Badge>
          )}
        </>
      ) : (
        <span className="text-muted-foreground text-xs">-</span>
      )}
    </div>
  );

  const renderCompanies = (note: FileRecord) => {
    const raw = note.matched_companies || [];
    const isPipelineCompany = (c: { type?: string }) => c.type === 'company';
    const list = [...raw].sort((a, b) => {
      const aClick = isPipelineCompany(a as { type?: string }) ? 1 : 0;
      const bClick = isPipelineCompany(b as { type?: string }) ? 1 : 0;
      return bClick - aClick;
    });
    const chipClass = "inline-flex items-center gap-1 text-xs text-muted-foreground rounded px-1.5 py-0.5 min-w-[5rem] max-w-[10rem] w-[10rem] overflow-hidden";
    const visible = expandedCompanies[note.id] ? list : list.slice(0, 2);
    return (
    <div className="flex flex-col gap-1">
      {list.length > 0 ? (
        <>
          {visible.map((company: { id?: string; name?: string; type?: string }, i: number) =>
            isPipelineCompany(company) && company.id ? (
              <Link
                key={i}
                href={`/pipeline/${company.id}`}
                className={`${chipClass} hover:text-primary hover:underline bg-sky-100 dark:bg-sky-900/30`}
                title={company.name}
              >
                <Building className="h-3 w-3 shrink-0" />
                <span className="truncate">{company.name}</span>
              </Link>
            ) : (
              <div key={i} className={`${chipClass} bg-orange-100 dark:bg-orange-900/30`} title={company.name}>
                <Building className="h-3 w-3 shrink-0" />
                <span className="truncate">{company.name}</span>
              </div>
            )
          )}
          {list.length > 2 && (
              <button
                className="text-[10px] text-primary hover:underline text-left"
                onClick={() => toggleCompanies(note.id)}
              >
              {expandedCompanies[note.id] ? 'Show less' : `+${list.length - 2} more`}
            </button>
          )}
        </>
      ) : (
        <span className="text-muted-foreground text-xs">-</span>
      )}
    </div>
  );
  };

  const renderStructuredNotes = (note: FileRecord) => {
    if (!note.structured_notes) {
      return (
        <p className="text-sm text-muted-foreground italic p-4">
          Processing not complete or structure extraction failed.
        </p>
      );
    }

    try {
      const structured = JSON.parse(note.structured_notes);
      return (
        <>
          <div>
            <h4 className="font-medium text-primary mb-1">Summary</h4>
            <p>{structured.summary}</p>
          </div>
          <div>
            <h4 className="font-medium text-primary mb-1">Key Points</h4>
            <ul className="list-disc pl-4 space-y-1">
              {structured.key_points?.map((p: string, i: number) => <li key={i}>{p}</li>)}
            </ul>
          </div>
          <div>
            <h4 className="font-medium text-primary mb-1">Action Items</h4>
            <ul className="list-disc pl-4 space-y-1">
              {structured.action_items?.map((p: string, i: number) => <li key={i}>{p}</li>)}
            </ul>
          </div>
        </>
      );
    } catch {
      return <pre className="text-xs whitespace-pre-wrap">{note.structured_notes}</pre>;
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <CardTitle className="flex items-center gap-2">
            <span className={iconColor}>{icon}</span>
            {title} ({filteredFiles.length})
          </CardTitle>
          <div className="relative w-full md:w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search notes, tags, companies..."
              className="pl-9"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {files.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <div className={cn("mx-auto h-12 w-12 mb-4 opacity-50 flex items-center justify-center", iconColor)}>
              {icon}
            </div>
            <p>{emptyMessage}</p>
            <p className="text-sm">{emptySubMessage}</p>
          </div>
        ) : filteredFiles.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Search className="mx-auto h-12 w-12 mb-4 opacity-50" />
            <p>No results found for &quot;{searchQuery}&quot;</p>
            <Button variant="link" onClick={() => onSearchChange('')}>Clear search</Button>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead
                      className="cursor-pointer hover:text-primary transition-colors"
                      onClick={() => onSort('file_name')}
                    >
                      <div className="flex items-center">
                        File Name
                        <SortIcon field="file_name" />
                      </div>
                    </TableHead>
                    <TableHead
                      className="cursor-pointer hover:text-primary transition-colors"
                      onClick={() => onSort('processing_status')}
                    >
                      <div className="flex items-center">
                        Status
                        <SortIcon field="processing_status" />
                      </div>
                    </TableHead>
                    <TableHead>Tags</TableHead>
                    <TableHead>Matched Companies</TableHead>
                    <TableHead
                      className="cursor-pointer hover:text-primary transition-colors text-right"
                      onClick={() => onSort('file_date')}
                    >
                      <div className="flex items-center justify-end">
                        Meeting Date & Actions
                        <SortIcon field="file_date" />
                      </div>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedFiles.map((note) => (
                    <TableRow key={note.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          {note.file_name}
                        </div>
                      </TableCell>
                      <TableCell>{renderStatusBadge(note.processing_status)}</TableCell>
                      <TableCell className="max-w-[200px]">{renderTags(note)}</TableCell>
                      <TableCell>{renderCompanies(note)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-col items-end gap-2">
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                variant="ghost"
                                className={cn(
                                  "h-8 w-auto justify-end text-right font-normal px-2",
                                  !note.file_date && "text-muted-foreground"
                                )}
                              >
                                <CalendarIcon className="mr-2 h-3 w-3" />
                                {note.file_date ? format(new Date(note.file_date), 'PPP') : (
                                  <span className="text-xs italic text-muted-foreground">Set meeting date</span>
                                )}
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-0" align="end">
                              <Calendar
                                mode="single"
                                selected={note.file_date ? new Date(note.file_date) : undefined}
                                onSelect={(date) => onUpdateDate(note.id, date)}
                                initialFocus
                              />
                            </PopoverContent>
                          </Popover>

                          <div className="flex items-center justify-end gap-1">
                            <Dialog>
                              <DialogTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title="View details"
                                  className="h-8 w-8"
                                >
                                  <Eye className="h-4 w-4" />
                                </Button>
                              </DialogTrigger>
                              <DialogContent className="max-w-3xl max-h-[80vh]">
                                <DialogHeader>
                                  <DialogTitle>{note.file_name} - Details</DialogTitle>
                                </DialogHeader>
                                <div className="grid md:grid-cols-2 gap-6 mt-4 overflow-hidden">
                                  <div className="flex flex-col gap-2">
                                    <h3 className="text-sm font-semibold flex items-center gap-2">
                                      <FileText className="h-4 w-4" />
                                      File Preview
                                    </h3>
                                    {note.signed_url ? (
                                      <FilePreview
                                        url={note.signed_url}
                                        onDownload={() => onDownload(note.id, note.file_name)}
                                        fileName={note.file_name}
                                      />
                                    ) : (
                                      <div className="flex h-[400px] w-full items-center justify-center bg-muted/30 rounded-md border text-muted-foreground">
                                        Preview not available (Link missing)
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex flex-col gap-2">
                                    <h3 className="text-sm font-semibold flex items-center gap-2">
                                      <Bot className="h-4 w-4" />
                                      AI Structured Notes
                                    </h3>
                                    <ScrollArea className="h-[400px] w-full rounded-md border p-4 bg-muted/30">
                                      <div className="space-y-4 text-sm">
                                        {renderStructuredNotes(note)}
                                      </div>
                                    </ScrollArea>
                                  </div>
                                </div>
                              </DialogContent>
                            </Dialog>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => onDownload(note.id, note.file_name)}
                              disabled={downloadingId === note.id}
                              title="Download file"
                              className="h-8 w-8"
                            >
                              {downloadingId === note.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Download className="h-4 w-4" />
                              )}
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="text-destructive hover:text-destructive h-8 w-8"
                                  disabled={deletingId === note.id}
                                >
                                  {deletingId === note.id ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="h-4 w-4" />
                                  )}
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Delete File</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    Are you sure you want to delete &quot;{note.file_name}&quot;?
                                    This will remove both the file from storage and the database record.
                                    This action cannot be undone.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => onDelete(note.id)}
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  >
                                    Delete
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t">
                <p className="text-sm text-muted-foreground">
                  Page {currentPage} of {totalPages} ({filteredFiles.length} files)
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onPageChange(Math.max(1, currentPage - 1))}
                    disabled={currentPage === 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
                    disabled={currentPage === totalPages}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface AIFileDumpProps {
  showCrm?: boolean;
  showAiWorkforce?: boolean;
}

export default function AIFileDump({ showCrm = false, showAiWorkforce = false }: AIFileDumpProps) {
  const router = useRouter();
  const [meetingNotes, setMeetingNotes] = useState<MeetingNote[]>([]);
  const [prospectus, setProspectus] = useState<Prospectus[]>([]);
  const [bankerComms, setBankerComms] = useState<FileRecord[]>([]);
  const [otherFiles, setOtherFiles] = useState<OtherFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // File drop state
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  /** Per-file raw notes: key = `${file.name}-${index}` */
  const [fileRawNotes, setFileRawNotes] = useState<Record<string, string>>({});
  /** Which file note dropdowns are expanded: key = `${file.name}-${index}` */
  const [expandedFileNotes, setExpandedFileNotes] = useState<Record<string, boolean>>({});
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);

  // Sorting and Filtering state - separate for each table
  const [momSearchQuery, setMomSearchQuery] = useState('');
  const [momSortField, setMomSortField] = useState<keyof MeetingNote>('file_date');
  const [momSortDirection, setMomSortDirection] = useState<'asc' | 'desc'>('desc');

  const [prospectusSearchQuery, setProspectusSearchQuery] = useState('');
  const [prospectusSortField, setProspectusSortField] = useState<keyof MeetingNote>('file_date');
  const [prospectusSortDirection, setProspectusSortDirection] = useState<'asc' | 'desc'>('desc');

  const [bankerCommsSearchQuery, setBankerCommsSearchQuery] = useState('');
  const [bankerCommsSortField, setBankerCommsSortField] = useState<keyof MeetingNote>('file_date');
  const [bankerCommsSortDirection, setBankerCommsSortDirection] = useState<'asc' | 'desc'>('desc');

  const [otherFilesSearchQuery, setOtherFilesSearchQuery] = useState('');
  const [otherFilesSortField, setOtherFilesSortField] = useState<keyof MeetingNote>('file_date');
  const [otherFilesSortDirection, setOtherFilesSortDirection] = useState<'asc' | 'desc'>('desc');

  const [expandedTags, setExpandedTags] = useState<Record<string, boolean>>({});
  const [expandedCompanies, setExpandedCompanies] = useState<Record<string, boolean>>({});
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  // Pagination state for each table
  const [momPage, setMomPage] = useState(1);
  const [prospectusPage, setProspectusPage] = useState(1);
  const [bankerCommsPage, setBankerCommsPage] = useState(1);
  const [otherFilesPage, setOtherFilesPage] = useState(1);

  const fetchMeetingNotes = useCallback(async () => {
    try {
      const response = await fetch('/api/ai-file-dump?file_type');
      const result = await response.json();

      if (result.success) {
        setMeetingNotes(result.data);
      } else {
        toast.error('Failed to load MoM');
      }
    } catch (error) {
      console.error('Error fetching MoM:', error);
      toast.error('Failed to load MoM');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchProspectus = useCallback(async () => {
    try {
      const response = await fetch('/api/ai-file-dump?file_type=prospectus');
      const result = await response.json();

      if (result.success) {
        setProspectus(result.data);
      } else {
        toast.error('Failed to load prospectus');
      }
    } catch (error) {
      console.error('Error fetching prospectus:', error);
      toast.error('Failed to load prospectus');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchBankerComms = useCallback(async () => {
    try {
      const response = await fetch('/api/ai-file-dump?file_type=banker_communications');
      const result = await response.json();

      if (result.success) {
        setBankerComms(result.data);
      } else {
        toast.error('Failed to load banker communications');
      }
    } catch (error) {
      console.error('Error fetching banker communications:', error);
      toast.error('Failed to load banker communications');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchOtherFiles = useCallback(async () => {
    try {
      const response = await fetch('/api/ai-file-dump?file_type=other');
      const result = await response.json();

      if (result.success) {
        setOtherFiles(result.data);
      } else {
        toast.error('Failed to load other files');
      }
    } catch (error) {
      console.error('Error fetching other files:', error);
      toast.error('Failed to load other files');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMeetingNotes();
    fetchProspectus();
    fetchBankerComms();
    fetchOtherFiles();
  }, [fetchMeetingNotes, fetchProspectus, fetchBankerComms, fetchOtherFiles]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      setSelectedFiles(prev => [...prev, ...files]);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      setSelectedFiles(prev => [...prev, ...Array.from(files)]);
    }
  };

  const handleUpload = async () => {
    if (selectedFiles.length === 0) {
      toast.error('Please select at least one file first');
      return;
    }

    // Check for duplicates across all file types (meeting notes, prospectus, banker comms, other files)
    const existingFileNames = new Set([
      ...meetingNotes.map(n => n.file_name),
      ...prospectus.map(n => n.file_name),
      ...bankerComms.map(n => n.file_name),
      ...otherFiles.map(n => n.file_name),
    ]);
    const duplicates = selectedFiles.filter(file => existingFileNames.has(file.name));
    const filesToUpload = selectedFiles.filter(file => !existingFileNames.has(file.name));

    if (filesToUpload.length === 0 && duplicates.length > 0) {
      toast.warning(
        duplicates.length === 1
          ? `File "${duplicates[0].name}" already exists and has been skipped.`
          : `${duplicates.length} files already exist and have been skipped.`
      );
      setSelectedFiles([]);
      return;
    }

    setUploading(true);
    setUploadProgress({ current: 0, total: filesToUpload.length });

    const results = {
      success: 0,
      failed: 0,
    };

    for (let i = 0; i < filesToUpload.length; i++) {
      const file = filesToUpload[i];
      setUploadProgress({ current: i + 1, total: filesToUpload.length });

      try {
        // 1. Get pre-signed URL
        const fileName = file.name;
        const contentType = file.type || 'application/octet-stream';

        const urlParams = new URLSearchParams({
          fileName,
          contentType,
        });

        const presignedResponse = await fetch(`/api/ai-file-dump/upload-url?${urlParams.toString()}`);
        const presignedResult = await presignedResponse.json();

        if (!presignedResult.success) {
          throw new Error(presignedResult.error || 'Failed to get upload URL');
        }

        const { uploadUrl, key } = presignedResult.data;

        // 2. Upload directly to S3
        const s3Response = await fetch(uploadUrl, {
          method: 'PUT',
          body: file,
          headers: {
            'Content-Type': contentType,
          },
        });

        if (!s3Response.ok) {
          throw new Error('Failed to upload file to S3');
        }

        // 3. Notify server of completion
        const fileKey = `${fileName}-${i}`;
        const rawNotesForFile = fileRawNotes[fileKey]?.trim() || undefined;
        const body: Record<string, unknown> = {
          key,
          fileName,
          contentType,
        };
        if (rawNotesForFile) body.raw_notes = rawNotesForFile;

        const notifyResponse = await fetch('/api/ai-file-dump', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        const notifyResult = await notifyResponse.json();

        if (notifyResult.success) {
          results.success++;
        } else {
          console.error(`Processing failed for ${file.name}:`, notifyResult.error);
          results.failed++;
        }
      } catch (error) {
        console.error(`Upload error for ${file.name}:`, error);
        results.failed++;
      }
    }

    if (results.success > 0) {
      // Capture file upload event
      posthog.capture('file_uploaded', {
        file_count: results.success,
        failed_count: results.failed,
        duplicate_count: duplicates.length,
      });

      toast.success(
        filesToUpload.length === 1
          ? 'File uploaded successfully'
          : `Successfully uploaded ${results.success} of ${filesToUpload.length} files`
      );

      if (duplicates.length > 0) {
        toast.warning(`${duplicates.length} duplicate ${duplicates.length === 1 ? 'file was' : 'files were'} skipped.`);
      }

      if (results.failed > 0) {
        toast.error(`Failed to upload ${results.failed} files`);
      }
      setSelectedFiles([]);
      setFileRawNotes({});
      setExpandedFileNotes({});
      fetchMeetingNotes();
      fetchProspectus();
      fetchBankerComms();
      fetchOtherFiles();
    } else {
      if (duplicates.length > 0) {
        toast.warning(`${duplicates.length} duplicate ${duplicates.length === 1 ? 'file was' : 'files were'} skipped.`);
      }
      if (results.failed > 0) {
        toast.error('Failed to upload file');
      }
    }

    setUploading(false);
    setUploadProgress(null);
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);

    try {
      const response = await fetch(`/api/ai-file-dump/${id}`, {
        method: 'DELETE',
      });

      const result = await response.json();

      if (result.success) {
        // Capture file deleted event
        posthog.capture('file_deleted', {
          file_id: id,
        });

        toast.success('File deleted successfully');
        fetchMeetingNotes();
        fetchProspectus();
        fetchBankerComms();
        fetchOtherFiles();
      } else {
        toast.error(result.error || 'Failed to delete file');
      }
    } catch (error) {
      console.error('Delete error:', error);
      toast.error('Failed to delete file');
    } finally {
      setDeletingId(null);
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const clearSelectedFiles = () => {
    setSelectedFiles([]);
    setFileRawNotes({});
    setExpandedFileNotes({});
  };

  // Sort handlers for each table
  const handleMomSort = (field: keyof MeetingNote) => {
    if (momSortField === field) {
      setMomSortDirection(momSortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setMomSortField(field);
      setMomSortDirection('asc');
    }
    setMomPage(1);
  };

  const handleProspectusSort = (field: keyof MeetingNote) => {
    if (prospectusSortField === field) {
      setProspectusSortDirection(prospectusSortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setProspectusSortField(field);
      setProspectusSortDirection('asc');
    }
    setProspectusPage(1);
  };

  const handleBankerCommsSort = (field: keyof MeetingNote) => {
    if (bankerCommsSortField === field) {
      setBankerCommsSortDirection(bankerCommsSortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setBankerCommsSortField(field);
      setBankerCommsSortDirection('asc');
    }
    setBankerCommsPage(1);
  };

  const handleOtherFilesSort = (field: keyof MeetingNote) => {
    if (otherFilesSortField === field) {
      setOtherFilesSortDirection(otherFilesSortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setOtherFilesSortField(field);
      setOtherFilesSortDirection('asc');
    }
    setOtherFilesPage(1);
  };

  // Search handlers for each table
  const handleMomSearchChange = (query: string) => {
    setMomSearchQuery(query);
    setMomPage(1);
  };

  const handleProspectusSearchChange = (query: string) => {
    setProspectusSearchQuery(query);
    setProspectusPage(1);
  };

  const handleBankerCommsSearchChange = (query: string) => {
    setBankerCommsSearchQuery(query);
    setBankerCommsPage(1);
  };

  const handleOtherFilesSearchChange = (query: string) => {
    setOtherFilesSearchQuery(query);
    setOtherFilesPage(1);
  };

  const toggleTags = (id: string) => {
    setExpandedTags(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleCompanies = (id: string) => {
    setExpandedCompanies(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleUpdateDate = async (id: string, date: Date | undefined) => {
    if (!date) return;

    try {
      const response = await fetch('/api/ai-file-dump', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id,
          file_date: format(date, 'yyyy-MM-dd'),
        }),
      });

      if (!response.ok) throw new Error('Failed to update date');

      setMeetingNotes(prev =>
        prev.map(note =>
          note.id === id ? { ...note, file_date: format(date, 'yyyy-MM-dd') } : note
        )
      );

      toast.success("Meeting date updated successfully");
    } catch (error) {
      console.error('Error updating meeting date:', error);
      toast.error("Failed to update meeting date");
    }
  };

  const handleDownload = async (noteId: string, fileName: string) => {
    setDownloadingId(noteId);
    try {
      const response = await fetch(`/api/ai-file-dump/${noteId}/download`);
      if (!response.ok) throw new Error('Failed to generate download URL');

      const { download_url } = await response.json();
      if (!download_url) throw new Error('Download URL not provided');

      // Trigger download
      const link = document.createElement('a');
      link.href = download_url;
      link.setAttribute('download', fileName);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error('Download error:', error);
      toast.error("Failed to download file. Please try again.");
    } finally {
      setDownloadingId(null);
    }
  };

  // Reusable filter and sort function
  const filterAndSortFiles = useCallback((
    files: FileRecord[],
    searchQuery: string,
    sortField: keyof FileRecord,
    sortDirection: 'asc' | 'desc'
  ) => {
    return files
      .filter((note) => {
        const searchLower = searchQuery.toLowerCase();
        const fileNameMatch = note.file_name.toLowerCase().includes(searchLower);
        const tagsMatch = note.tags?.some(tag => tag.toLowerCase().includes(searchLower));
        const companiesMatch = note.matched_companies?.some((company: { name?: string }) =>
          company.name?.toLowerCase().includes(searchLower)
        );
        return fileNameMatch || tagsMatch || companiesMatch;
      })
      .sort((a, b) => {
        const aValue = a[sortField];
        const bValue = b[sortField];

        if (aValue === bValue) return 0;
        if (aValue === null || aValue === undefined) return 1;
        if (bValue === null || bValue === undefined) return -1;

        let comparison = 0;
        if (typeof aValue === 'string' && typeof bValue === 'string') {
          comparison = aValue.localeCompare(bValue);
        } else if (Array.isArray(aValue) && Array.isArray(bValue)) {
          comparison = aValue.length - bValue.length;
        } else {
          comparison = aValue < bValue ? -1 : 1;
        }

        return sortDirection === 'asc' ? comparison : -comparison;
      });
  }, []);

  const filteredAndSortedNotes = filterAndSortFiles(meetingNotes, momSearchQuery, momSortField, momSortDirection);
  const filteredAndSortedProspectus = filterAndSortFiles(prospectus, prospectusSearchQuery, prospectusSortField, prospectusSortDirection);
  const filteredAndSortedBankerComms = filterAndSortFiles(bankerComms, bankerCommsSearchQuery, bankerCommsSortField, bankerCommsSortDirection);
  const filteredAndSortedOtherFiles = filterAndSortFiles(otherFiles, otherFilesSearchQuery, otherFilesSortField, otherFilesSortDirection);

  if (loading) {
    return (
      <DashboardLayout showCrm={showCrm} showAiWorkforce={showAiWorkforce}>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout showCrm={showCrm} showAiWorkforce={showAiWorkforce}>
      <div className="flex flex-col h-full p-6 space-y-6 animate-fade-in">
        {/* Header */}
        <div className="relative flex-shrink-0">
          <div className="absolute -inset-2 rounded-2xl opacity-20 blur-xl transition-colors duration-500 bg-gradient-to-r from-teal-500 via-emerald-500 to-cyan-500" />
          <div className="relative flex items-center gap-5">
            <div className="relative group">
              <div className="absolute inset-0 rounded-2xl blur-md opacity-60 group-hover:opacity-80 transition-opacity bg-gradient-to-br from-teal-400 to-emerald-600" />
              <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl shadow-xl transition-all duration-300 group-hover:scale-105 bg-gradient-to-br from-teal-500 via-emerald-500 to-cyan-600">
                <FileStack className="h-7 w-7 text-white drop-shadow-lg" />
                <div
                  className="absolute inset-0 rounded-2xl animate-ping opacity-20 bg-teal-400"
                  style={{ animationDuration: '3s' }}
                />
              </div>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-1">
                <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text">
                  AI File Dump
                </h1>
                <Badge
                  variant="outline"
                  className="text-xs font-medium px-2 py-0.5 border-0 bg-teal-500/10 text-teal-600 hover:bg-teal-500/20"
                >
                  <Zap className="h-3 w-3 mr-1" />
                  AI Powered
                </Badge>
              </div>
              <p className="text-muted-foreground text-sm">
                Drop your files and let AI automatically organize and categorize them
              </p>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="inline-flex h-10 items-center justify-center rounded-md text-muted-foreground w-fit bg-muted/50 p-1 flex-shrink-0">
          <button
            type="button"
            onClick={() => router.push('/ai-discovery')}
            className="inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 gap-2 text-purple-400/70 hover:text-purple-600 transition-all"
          >
            <Sparkles className="h-4 w-4" />
            AI CoPilot
          </button>
          <button
            type="button"
            onClick={() => router.push('/ai-file-dump')}
            className="inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 gap-2 bg-teal-500/15 text-teal-600 shadow-sm transition-all"
          >
            <FileStack className="h-4 w-4" />
            AI File Dump
          </button>
        </div>

        {/* Upload Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              Drag and drop files
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Drop Zone */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`
                border-2 border-dashed rounded-lg p-8 text-center transition-colors
                ${isDragging
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/25 hover:border-primary/50'}
                ${selectedFiles.length > 0 ? 'bg-muted/50' : ''}
              `}
            >
              <div className="space-y-2">
                <div className="flex flex-wrap items-start justify-center gap-x-8 gap-y-4">
                  <div className="flex flex-col items-center gap-2 text-center">
                    <FileUp className="h-10 w-10 text-muted-foreground" />
                    <p className="text-muted-foreground text-sm">
                      Drag and drop files here, or{' '}
                      <label className="text-primary cursor-pointer hover:underline">
                        browse
                        <Input
                          type="file"
                          className="hidden"
                          onChange={handleFileSelect}
                          accept=".pdf,.doc,.docx,.txt,.md,.csv,.mbox"
                          multiple
                        />
                      </label>
                    </p>
                    <p className="text-xs text-muted-foreground text-center">
                      Supports PPTX, PDF, DOC, DOCX, TXT, MD, CSV, MBOX
                    </p>
                  </div>
                  {/* <div className="flex flex-col items-center gap-2 text-center">
                    <FileSpreadsheet className="h-10 w-10 text-emerald-600" />
                    <p className="text-muted-foreground text-sm flex flex-col items-center justify-center gap-0.5">
                      <span>Upload bulk companies using</span><span>this template {' '}
                        <a
                          href="/File Upload Template.xlsx"
                          download="File Upload Template.xlsx"
                          className="text-primary font-medium underline underline-offset-2 hover:no-underline cursor-pointer"
                        >
                          here
                        </a>
                      </span>
                    </p>
                  </div> */}
                </div>
              </div>
            </div>

            {/* Selected Files List with per-file Raw Notes dropdown */}
            {selectedFiles.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">Selected Files ({selectedFiles.length})</h3>
                  <Button variant="ghost" size="sm" onClick={clearSelectedFiles} className="text-xs h-7">
                    Clear all
                  </Button>
                </div>
                <div className="grid gap-2 max-h-[400px] overflow-y-auto pr-2">
                  {selectedFiles.map((file, index) => {
                    const fileKey = `${file.name}-${index}`;
                    const existingFileNames = new Set([
                      ...meetingNotes.map(n => n.file_name),
                      ...prospectus.map(n => n.file_name),
                      ...bankerComms.map(n => n.file_name),
                      ...otherFiles.map(n => n.file_name),
                    ]);
                    const isDuplicate = existingFileNames.has(file.name);
                    const notesExpanded = expandedFileNotes[fileKey];
                    const hasNotes = (fileRawNotes[fileKey] ?? '').trim() !== '';
                    return (
                      <div
                        key={fileKey}
                        className={cn(
                          "rounded-md border transition-colors",
                          isDuplicate ? "bg-orange-500/5 border-orange-200" : "bg-muted/40 border-muted"
                        )}
                      >
                        <div className="flex items-center justify-between p-2">
                          <div className="flex items-center gap-3 overflow-hidden min-w-0">
                            <FileText className={cn("h-4 w-4 shrink-0", isDuplicate ? "text-orange-500" : "text-primary")} />
                            <div className="overflow-hidden min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="text-sm font-medium truncate">{file.name}</p>
                                {isDuplicate && (
                                  <Badge variant="outline" className="text-[10px] h-4 py-0 px-1 text-orange-600 bg-orange-500/5 border-orange-200 shrink-0">
                                    Duplicate
                                  </Badge>
                                )}
                              </div>
                              <p className="text-[10px] text-muted-foreground">
                                {(file.size / 1024).toFixed(1)} KB
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs gap-1"
                              onClick={() => setExpandedFileNotes(prev => ({ ...prev, [fileKey]: !prev[fileKey] }))}
                            >
                              {notesExpanded ? (
                                <ChevronUp className="h-3 w-3" />
                              ) : (
                                <ChevronDown className="h-3 w-3" />
                              )}
                              Raw notes {hasNotes && <span className="text-primary">•</span>}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => removeFile(index)}
                              className="h-7 w-7"
                              disabled={uploading}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                        {notesExpanded && (
                          <div className="border-t border-muted px-2 pb-2 pt-1">
                            <Textarea
                              placeholder="Paste raw notes for this file (optional)..."
                              value={fileRawNotes[fileKey] ?? ''}
                              onChange={(e) => setFileRawNotes(prev => ({ ...prev, [fileKey]: e.target.value }))}
                              rows={3}
                              className="resize-none text-sm"
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Upload Button & Progress */}
            {selectedFiles.length > 0 && (
              <div className="flex flex-col gap-4 pt-2">
                {uploading && uploadProgress && (
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">
                        Processing {uploadProgress.current} of {uploadProgress.total}...
                      </span>
                      <span className="font-medium">
                        {Math.round((uploadProgress.current / uploadProgress.total) * 100)}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all duration-300"
                        style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}

                <div className="flex justify-end">
                  <Button onClick={handleUpload} disabled={uploading}>
                    {uploading ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        {selectedFiles.length > 1
                          ? `Uploading Queue (${uploadProgress?.current}/${uploadProgress?.total})`
                          : 'Uploading...'
                        }
                      </>
                    ) : (
                      <>
                        <Upload className="h-4 w-4 mr-2" />
                        {selectedFiles.length > 1
                          ? `Upload ${selectedFiles.length} Files`
                          : 'Upload File'
                        }
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* MoM List */}
        <FileTable
          title="MoM"
          icon={<FileText className="h-5 w-5" />}
          iconColor="text-teal-500"
          files={meetingNotes}
          filteredFiles={filteredAndSortedNotes}
          searchQuery={momSearchQuery}
          onSearchChange={handleMomSearchChange}
          sortField={momSortField}
          sortDirection={momSortDirection}
          onSort={handleMomSort}
          expandedTags={expandedTags}
          toggleTags={toggleTags}
          expandedCompanies={expandedCompanies}
          toggleCompanies={toggleCompanies}
          onUpdateDate={handleUpdateDate}
          onDownload={handleDownload}
          onDelete={handleDelete}
          downloadingId={downloadingId}
          deletingId={deletingId}
          emptyMessage="No MoM uploaded yet."
          emptySubMessage="Upload your first MoM using the form above."
          currentPage={momPage}
          onPageChange={setMomPage}
        />

        {/* Prospectus List */}
        <FileTable
          title="Prospectus"
          icon={<FileSpreadsheet className="h-5 w-5" />}
          iconColor="text-teal-500"
          files={prospectus}
          filteredFiles={filteredAndSortedProspectus}
          searchQuery={prospectusSearchQuery}
          onSearchChange={handleProspectusSearchChange}
          sortField={prospectusSortField}
          sortDirection={prospectusSortDirection}
          onSort={handleProspectusSort}
          expandedTags={expandedTags}
          toggleTags={toggleTags}
          expandedCompanies={expandedCompanies}
          toggleCompanies={toggleCompanies}
          onUpdateDate={handleUpdateDate}
          onDownload={handleDownload}
          onDelete={handleDelete}
          downloadingId={downloadingId}
          deletingId={deletingId}
          emptyMessage="No prospectus uploaded yet."
          emptySubMessage="Upload your first prospectus using the form above."
          currentPage={prospectusPage}
          onPageChange={setProspectusPage}
        />

        {/* Banker Communications List */}
        <FileTable
          title="Banker Communications"
          icon={<FileSpreadsheet className="h-5 w-5" />}
          iconColor="text-indigo-500"
          files={bankerComms}
          filteredFiles={filteredAndSortedBankerComms}
          searchQuery={bankerCommsSearchQuery}
          onSearchChange={handleBankerCommsSearchChange}
          sortField={bankerCommsSortField}
          sortDirection={bankerCommsSortDirection}
          onSort={handleBankerCommsSort}
          expandedTags={expandedTags}
          toggleTags={toggleTags}
          expandedCompanies={expandedCompanies}
          toggleCompanies={toggleCompanies}
          onUpdateDate={handleUpdateDate}
          onDownload={handleDownload}
          onDelete={handleDelete}
          downloadingId={downloadingId}
          deletingId={deletingId}
          emptyMessage="No banker communications uploaded yet."
          emptySubMessage="Upload CSV or MBOX files from Google Vault exports."
          currentPage={bankerCommsPage}
          onPageChange={setBankerCommsPage}
        />

        {/* Other List */}
        <FileTable
          title="Other"
          icon={<File className="h-5 w-5" />}
          iconColor=""
          files={otherFiles}
          filteredFiles={filteredAndSortedOtherFiles}
          searchQuery={otherFilesSearchQuery}
          onSearchChange={handleOtherFilesSearchChange}
          sortField={otherFilesSortField}
          sortDirection={otherFilesSortDirection}
          onSort={handleOtherFilesSort}
          expandedTags={expandedTags}
          toggleTags={toggleTags}
          expandedCompanies={expandedCompanies}
          toggleCompanies={toggleCompanies}
          onUpdateDate={handleUpdateDate}
          onDownload={handleDownload}
          onDelete={handleDelete}
          downloadingId={downloadingId}
          deletingId={deletingId}
          emptyMessage="No other files uploaded yet."
          emptySubMessage="Upload your files using the form above."
          currentPage={otherFilesPage}
          onPageChange={setOtherFilesPage}
        />
      </div>
    </DashboardLayout >
  );
}
