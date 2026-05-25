"use client";

import { Button } from "@/components/ui/button";
import { useMemo } from "react";

export function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (p: number) => void;
}) {
  const pages = useMemo(() => {
    const set = new Set<number>([1, totalPages, page - 1, page, page + 1]);
    return Array.from(set)
      .filter((n) => n >= 1 && n <= totalPages)
      .sort((a, b) => a - b);
  }, [page, totalPages]);
  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant="outline"
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={page <= 1}
      >
        ‹
      </Button>
      {pages.map((p, i) => (
        <span key={p} className="flex items-center">
          {i > 0 && pages[i - 1] !== p - 1 && (
            <span className="px-1 text-muted-foreground">…</span>
          )}
          <Button
            size="sm"
            variant={p === page ? "default" : "outline"}
            onClick={() => onChange(p)}
          >
            {p}
          </Button>
        </span>
      ))}
      <Button
        size="sm"
        variant="outline"
        onClick={() => onChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
      >
        ›
      </Button>
    </div>
  );
}
