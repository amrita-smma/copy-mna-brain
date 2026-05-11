'use client';

import * as React from 'react';
import { useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';

import { RailGroup, RailItem } from './rail';
import { TaskCanvas } from './TaskCanvas';
import { RoutineCanvas } from './RoutineCanvas';
import { NewRoutineModal } from './NewRoutineModal';

import { doneTasks, initialQueue, routineRuns, routines } from './data';
import {
  DEFAULT_SELECTION,
  avatarToneClass,
} from './shared';
import type { QueueTask, Selection } from './shared';

const QUEUE_PAGE_SIZE = 5;

export function WorkforceTasks() {
  const [selection, setSelection] = useState<Selection>(DEFAULT_SELECTION);
  const [queue, setQueue] = useState<QueueTask[]>(initialQueue);
  const [queuePage, setQueuePage] = useState(0);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [routineModalOpen, setRoutineModalOpen] = useState(false);
  const totalQueuePages = Math.max(1, Math.ceil(queue.length / QUEUE_PAGE_SIZE));
  const paginatedQueue = useMemo(
    () => queue.slice(queuePage * QUEUE_PAGE_SIZE, (queuePage + 1) * QUEUE_PAGE_SIZE),
    [queue, queuePage],
  );

  const selectedRoutine =
    selection.kind === 'routine'
      ? routines.find((r) => r.id === selection.id)
      : undefined;
  const showTaskCanvas = !selectedRoutine;

  const goToTask = () => setSelection(DEFAULT_SELECTION);
  const goToRoutine = (id: string) => setSelection({ kind: 'routine', id });

  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggingId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };
  const handleDragOver = (e: React.DragEvent, overId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!draggingId || draggingId === overId) return;
    setQueue((prev) => {
      const fromIdx = prev.findIndex((t) => t.id === draggingId);
      const toIdx = prev.findIndex((t) => t.id === overId);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };
  const handleDragEnd = () => setDraggingId(null);

  return (
    <div className="flex-1 grid grid-cols-[280px_1fr] min-h-0 overflow-hidden bg-muted/20">
      {/* Rail */}
      <aside className="border-r bg-muted/30 flex flex-col min-h-0">
        <div className="flex-shrink-0 p-3 border-b">
          <button
            type="button"
            onClick={() => setRoutineModalOpen(true)}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-border transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            New Routine
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          {/* Routines */}
          <RailGroup label="Routines" count={routines.length}>
            <div className="space-y-0.5">
              {routines.map((routine) => {
                const Icon = routine.icon;
                const isActive =
                  selection.kind === 'routine' && selection.id === routine.id;
                return (
                  <RailItem
                    key={routine.id}
                    onClick={() => goToRoutine(routine.id)}
                    active={isActive}
                    icon={<Icon className="h-3 w-3" />}
                    iconClass={
                      routine.isFiring
                        ? 'bg-amber-50 text-amber-600'
                        : 'bg-emerald-50 text-emerald-700'
                    }
                    title={routine.name}
                    meta={
                      <span className="flex items-center gap-1">
                        {routine.isFiring && (
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                        )}
                        {routine.scheduleSummary}
                      </span>
                    }
                  />
                );
              })}
            </div>
          </RailGroup>

          {/* In progress */}
          <RailGroup label="In progress" count={1}>
            <RailItem
              active={showTaskCanvas}
              onClick={goToTask}
              icon={<AlertCircle className="h-3 w-3" />}
              iconClass="bg-violet-100 text-violet-600"
              title="Project Maple — L0/L1 screening"
              meta={<span className="text-violet-600 font-semibold">Waiting on input</span>}
            />
          </RailGroup>

          {/* Queued — paginated by 5, drag to reorder */}
          <RailGroup
            label="Queued"
            count={queue.length}
            hint="drag to reorder"
          >
            <div className="space-y-0.5">
              {paginatedQueue.map((task) => {
                const Icon = task.icon;
                const position = queue.findIndex((t) => t.id === task.id) + 1;
                return (
                  <RailItem
                    key={task.id}
                    onClick={goToTask}
                    showDragHandle
                    draggable
                    isDragging={draggingId === task.id}
                    onDragStart={(e) => handleDragStart(e, task.id)}
                    onDragOver={(e) => handleDragOver(e, task.id)}
                    onDragEnd={handleDragEnd}
                    onDrop={(e) => e.preventDefault()}
                    icon={<Icon className="h-3 w-3" />}
                    iconClass="bg-violet-50 text-violet-700"
                    title={
                      <>
                        <span className="font-mono text-[10px] text-muted-foreground/70 mr-1.5">
                          #{position}
                        </span>
                        {task.title}
                      </>
                    }
                    meta={
                      <span className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            'h-3 w-3 rounded-full grid place-items-center text-[7px] font-bold',
                            avatarToneClass[task.avatarTone],
                          )}
                        >
                          {task.initials}
                        </span>
                        {task.owner}
                      </span>
                    }
                  />
                );
              })}
            </div>
            {totalQueuePages > 1 && (
              <div className="flex items-center justify-between px-2 pt-2">
                <button
                  type="button"
                  onClick={() => setQueuePage((p) => Math.max(0, p - 1))}
                  disabled={queuePage === 0}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:hover:text-muted-foreground disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  Prev
                </button>
                <span className="text-[11px] text-muted-foreground/70">
                  Page {queuePage + 1} of {totalQueuePages}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setQueuePage((p) => Math.min(totalQueuePages - 1, p + 1))
                  }
                  disabled={queuePage >= totalQueuePages - 1}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:hover:text-muted-foreground disabled:cursor-not-allowed"
                >
                  Next
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </RailGroup>

          {/* Done today */}
          <RailGroup label="Done today" count={7}>
            <div className="space-y-0.5">
              {doneTasks.map((task) => (
                <RailItem
                  key={task.title}
                  onClick={goToTask}
                  icon={<Check className="h-3 w-3" strokeWidth={3} />}
                  iconClass="bg-emerald-50 text-emerald-600"
                  title={task.title}
                  meta={
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'h-3 w-3 rounded-full grid place-items-center text-[7px] font-bold',
                          avatarToneClass[task.avatarTone],
                        )}
                      >
                        {task.initials}
                      </span>
                      {task.owner} · {task.meta}
                    </span>
                  }
                />
              ))}
            </div>
          </RailGroup>
        </div>
      </aside>

      {/* Canvas */}
      {selectedRoutine ? (
        <RoutineCanvas
          routine={selectedRoutine}
          runs={routineRuns[selectedRoutine.id] ?? []}
        />
      ) : (
        <TaskCanvas />
      )}

      <NewRoutineModal open={routineModalOpen} onOpenChange={setRoutineModalOpen} />
    </div>
  );
}
