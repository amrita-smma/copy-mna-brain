'use client';

import { useState } from 'react';
import { MessageSquarePlus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiRequest } from '@/lib/api/client';

/**
 * "Send Feedback" affordance in the sidebar footer (MB-480). Opens a dialog
 * with a required title + free-text box; submitting posts to `/api/feedback`,
 * which stores the submission (with the submitter + active workspace), emails
 * nico.alimin@smma.id, and files a Jira ticket — all server-side, so this
 * component just POSTs and reports success/failure.
 */
export function FeedbackDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = Boolean(title.trim() && message.trim());

  const handleSubmit = async () => {
    const trimmedTitle = title.trim();
    const trimmedMessage = message.trim();
    if (!trimmedTitle || !trimmedMessage) return;

    setSubmitting(true);
    try {
      await apiRequest('/api/feedback', {
        method: 'POST',
        body: JSON.stringify({ title: trimmedTitle, message: trimmedMessage }),
      });
      toast.success('Thanks! Your feedback has been sent.');
      setTitle('');
      setMessage('');
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to submit feedback');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground group-data-[state=collapsed]:justify-center group-data-[state=collapsed]:p-2"
        >
          <MessageSquarePlus className="h-4 w-4 group-data-[state=expanded]:mr-2" />
          <span className="group-data-[state=collapsed]:hidden">Send Feedback</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send Feedback</DialogTitle>
          <DialogDescription>
            Tell us what&apos;s working, what&apos;s not, or what you&apos;d like to see. This
            goes straight to the team.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
            aria-label="Feedback title"
            maxLength={200}
            disabled={submitting}
            autoFocus
          />
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What's on your mind?"
            aria-label="Feedback message"
            rows={5}
            maxLength={5000}
            disabled={submitting}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !canSubmit}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Submit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
