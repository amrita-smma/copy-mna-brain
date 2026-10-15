import { apiRequest } from '@/lib/api/client';
import type { UserTask, UserTaskInput, UserTaskUpdate } from '@/lib/services/userTaskService';

export type { UserTask, UserTaskInput, UserTaskUpdate } from '@/lib/services/userTaskService';

/** The signed-in user's tasks: open (oldest first), then recently completed. */
export function listTasks(): Promise<UserTask[]> {
  return apiRequest<UserTask[]>('/api/tasks');
}

export function createTask(input: UserTaskInput): Promise<UserTask> {
  return apiRequest<UserTask>('/api/tasks', { method: 'POST', body: JSON.stringify(input) });
}

export function updateTask(id: string, input: UserTaskUpdate): Promise<UserTask> {
  return apiRequest<UserTask>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteTask(id: string): Promise<{ id: string }> {
  return apiRequest<{ id: string }>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
