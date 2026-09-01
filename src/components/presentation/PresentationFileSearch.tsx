'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileText, FileType2, Presentation as PresentationIcon } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { searchFiles, type FileSearchResult } from '@/lib/api/files';
import { detectFileKind, isPresentableFileKind } from '@/lib/fileType';

const DEBOUNCE_MS = 250;
const PAGE_SIZE = 20;
const TARGET_RESULTS = 10;
// Bounds the worst case (a workspace where most name matches happen to be
// non-presentable kinds, e.g. spreadsheets) to at most 3 sequential requests
// per debounced search instead of paging indefinitely.
const MAX_PAGES = 3;

interface Props {
  onSelect: (file: { fileKey: string; fileName: string }) => void;
  className?: string;
}

/**
 * A search bar that opens a dropdown of files available to present — any
 * file kind `FilePreview` can render (PDF, PPTX, DOCX, images, text,
 * markdown). With no query typed yet, opening the dropdown browses the most
 * recently uploaded files; typing switches to matching on name/tag/company
 * via the same search `/api/smart-files` already exposes. The `Popover`
 * nests *inside* `Command` (rather than the usual other way around) so
 * `CommandInput` and `CommandList` stay in the same cmdk context despite
 * `CommandList` rendering into a portal — that's what keeps arrow-key
 * navigation and Enter-to-select working while the always-visible input sits
 * outside the dropdown itself.
 */
export function PresentationFileSearch({ onSelect, className }: Props) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<FileSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const browsing = !debouncedQuery;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Fetches whenever the dropdown is open — with no query typed, this
  // browses the most recently uploaded files instead of searching.
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoading(true);
    setSearchFailed(false);

    (async () => {
      try {
        // `/api/smart-files` can come back entirely non-presentable on a
        // single capped page (e.g. all spreadsheets) even when matching/
        // recent PDFs exist further in — keep paging (bounded) until enough
        // presentable hits are found or there's nothing left to fetch.
        const collected: FileSearchResult[] = [];
        for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
          const rows = await searchFiles({
            search: debouncedQuery || undefined,
            limit: PAGE_SIZE,
            offset: pageIndex * PAGE_SIZE,
            ...(browsing ? { sortField: 'created_at' as const, sortDirection: 'desc' as const } : {}),
          });
          if (cancelled) return;
          collected.push(...rows.filter((file) => isPresentableFileKind(detectFileKind(file.file_name))));
          if (rows.length < PAGE_SIZE || collected.length >= TARGET_RESULTS) break;
        }
        if (!cancelled) setResults(collected.slice(0, TARGET_RESULTS));
      } catch {
        if (!cancelled) {
          setResults([]);
          setSearchFailed(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, debouncedQuery, browsing]);

  const handleSelect = useCallback(
    (file: FileSearchResult) => {
      onSelect({ fileKey: file.file_link, fileName: file.file_name });
      setQuery('');
      setDebouncedQuery('');
      setResults([]);
      setOpen(false);
    },
    [onSelect],
  );

  return (
    <Command shouldFilter={false} className={`h-auto overflow-visible bg-transparent ${className ?? ''}`}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <div className="rounded-md border">
            <CommandInput
              value={query}
              onValueChange={setQuery}
              onFocus={() => setOpen(true)}
              onClick={() => setOpen(true)}
              placeholder="Search files to present..."
              className="h-8 text-sm"
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          className="w-[--radix-popover-trigger-width] p-0"
          align="start"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <CommandList>
            <CommandEmpty>
              {loading
                ? browsing
                  ? 'Loading…'
                  : 'Searching…'
                : searchFailed
                  ? "Couldn't load files."
                  : browsing
                    ? 'No files uploaded yet.'
                    : 'No presentable files found.'}
            </CommandEmpty>
            <CommandGroup heading={browsing && results.length > 0 ? 'Recently uploaded' : undefined}>
              {results.map((file) => {
                const kind = detectFileKind(file.file_name);
                return (
                  <CommandItem key={file.id} value={file.id} onSelect={() => handleSelect(file)}>
                    {kind === 'pptx' ? (
                      <PresentationIcon className="mr-2 h-4 w-4 shrink-0 text-orange-500" />
                    ) : kind === 'pdf' ? (
                      <FileText className="mr-2 h-4 w-4 shrink-0 text-red-500" />
                    ) : (
                      <FileType2 className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{file.file_name}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </PopoverContent>
      </Popover>
    </Command>
  );
}
