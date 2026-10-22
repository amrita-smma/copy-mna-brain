"use client";

import { useEffect, useState } from 'react';
import { Archive, Lock, Shuffle, Users } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  BOT_NAME_MAX_LENGTH,
  BOT_PERSONA_MAX_LENGTH,
  BOT_SKILL_KEYS,
  BOT_SHAPES,
  BOT_SHAPE_META,
  BOT_SKILL_META,
  randomBotAvatar,
  type BotAvatarConfig,
  type BotDto,
  type BotVisibility,
} from '@/lib/bots/types';
import { AVATAR_STATES, type AvatarState } from '@/lib/bots/avatarState';
import { archiveBot, createBot, updateBot } from '@/lib/api/bots';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { personaText } from '@/lib/bots/persona';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { BotAvatar } from './BotAvatar';
import { BotRoutinesTab } from './BotRoutinesTab';
import { BotTaskLogTab } from './BotTaskLogTab';
import { BotMemoryTab } from './BotMemoryTab';

const PREVIEW_STATES: AvatarState[] = AVATAR_STATES.filter((s) => s !== 'handoff');

interface BotEditDialogProps {
  /** The bot to edit, or null to create one. */
  bot: BotDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (bot: BotDto) => void;
  /** The tab to open on (an existing bot only). */
  initialTab?: BotDialogTab;
  /** Open the bot's chat — a task in the Task log was picked. */
  onOpenChat?: () => void;
  /** The bot was archived from the dialog (its owner confirmed); the dialog is done. */
  onArchived?: (bot: BotDto) => void;
}

export type BotDialogTab = 'settings' | 'memory' | 'routines' | 'tasks';

/** A tab's panel: fills the dialog's fixed height and scrolls on its own. */
const TAB_PANEL = 'mt-4 min-h-0 flex-1 overflow-y-auto pr-1';

/**
 * Create or edit a bot. A new bot is a name, a shape and a colour — nothing
 * else: every bot has every skill, and its persona starts blank, so it is set
 * up in its chat (it greets its creator asking who it is). An existing bot
 * adds sharing and its system prompt (the persona, also editable by telling
 * the bot), plus its Routines and its Task log, each on its own tab. Brain Bot
 * cannot be customized: its first tab is a read-only "About".
 */
export function BotEditDialog({
  bot,
  open,
  onOpenChange,
  onSaved,
  initialTab = 'settings',
  onOpenChat,
  onArchived,
}: BotEditDialogProps) {
  const [tab, setTab] = useState<BotDialogTab>(bot ? initialTab : 'settings');
  // Archiving asks first; only the owner of a bot that is not Brain Bot can.
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const canArchive = !!bot && !bot.is_default && bot.is_owner;
  const handleArchive = async () => {
    if (!bot) return;
    setArchiving(true);
    try {
      await archiveBot(bot.id);
      toast.success(`${bot.name} archived`);
      setConfirmingArchive(false);
      onArchived?.(bot);
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message || 'Could not archive the bot');
    } finally {
      setArchiving(false);
    }
  };
  const [name, setName] = useState(bot?.name ?? '');
  // The bot's system prompt as its owner writes it (its persona).
  const [prompt, setPrompt] = useState(() => personaText(bot?.persona_md));
  const [visibility, setVisibility] = useState<BotVisibility>(bot?.visibility ?? 'private');
  const [avatar, setAvatar] = useState<Required<BotAvatarConfig>>(
    () => bot?.avatar ?? randomBotAvatar(),
  );
  const [previewState, setPreviewState] = useState<AvatarState>('idle');
  const [saving, setSaving] = useState(false);

  // Walk the preview through the states so the user sees the avatar move.
  const [autoPreview, setAutoPreview] = useState(true);
  useEffect(() => {
    if (!autoPreview) return;
    let i = 0;
    const t = setInterval(() => {
      i = (i + 1) % PREVIEW_STATES.length;
      setPreviewState(PREVIEW_STATES[i]);
    }, 2200);
    return () => clearInterval(t);
  }, [autoPreview]);

  // Bots page opens the same bot on different tabs without remounting (key=id).
  useEffect(() => {
    if (open && bot) setTab(initialTab);
  }, [open, bot?.id, initialTab, bot]);

  const isDefault = bot?.is_default ?? false;
  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0 && !saving && !archiving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const saved = bot
        ? await updateBot(bot.id, { name: trimmedName, avatar, persona_md: prompt, visibility })
        : await createBot({ name: trimmedName, avatar });
      toast.success(bot ? 'Bot saved' : 'Bot created');
      onSaved(saved);
    } catch (err) {
      toast.error((err as Error).message || 'Could not save the bot');
    } finally {
      setSaving(false);
    }
  };

  const about = bot?.is_default ? <BrainBotAbout bot={bot} /> : null;

  const nameField = (opts?: { autoFocus?: boolean; submitOnEnter?: boolean }) => (
    <div className="space-y-1.5">
      <Label htmlFor="bot-name">Name</Label>
      <Input
        id="bot-name"
        value={name}
        maxLength={BOT_NAME_MAX_LENGTH}
        autoFocus={opts?.autoFocus}
        onChange={(e) => setName(e.target.value)}
        placeholder="Deal Scout"
        onKeyDown={(e) => {
          if (!opts?.submitOnEnter || e.key !== 'Enter' || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (canSave) void handleSave();
        }}
      />
    </div>
  );

  const lookControls = (
    <>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Shape</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                onClick={() => setAvatar(randomBotAvatar())}
                data-testid="bot-surprise"
              >
                <Shuffle className="h-3 w-3" />
                Surprise me
              </Button>
            </div>
            <ToggleGroup
              type="single"
              size="sm"
              value={avatar.shape}
              onValueChange={(v) => v && setAvatar((a) => ({ ...a, shape: v as typeof a.shape }))}
              className="flex-wrap justify-start"
              aria-label="Body shape"
            >
              {BOT_SHAPES.map((shape) => (
                <ToggleGroupItem
                  key={shape}
                  value={shape}
                  aria-label={BOT_SHAPE_META[shape].label}
                  title={`${BOT_SHAPE_META[shape].label} — ${BOT_SHAPE_META[shape].tagline}`}
                  className="h-10 w-10 p-0"
                >
                  <BotAvatar avatar={{ ...avatar, shape }} size="sm" trackCursor={false} />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="space-y-1.5">
            <Label>Colour</Label>
            <Slider
              value={[avatar.hue]}
              min={0}
              max={359}
              step={1}
              onValueChange={([hue]) => setAvatar((a) => ({ ...a, hue }))}
              aria-label="Avatar colour"
            />
          </div>
    </>
  );

  // A new bot is a look and a name: a small form, everything else is set up
  // in its chat.
  const createForm = (
    <div className="space-y-4" data-testid="bot-create-form">
      <div className="flex justify-center rounded-lg border bg-muted p-3">
        <BotAvatar avatar={avatar} state={previewState} size="xl" label="Avatar preview" />
      </div>
      {lookControls}
      {nameField({ autoFocus: true, submitOnEnter: true })}
    </div>
  );

  const settings = (
    <>
      {bot && !bot.is_owner && (
        <p
          className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2 text-sm"
          data-testid="bot-shared-edit-notice"
        >
          <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
          Shared bot — your changes apply for everyone in the workspace.
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_220px] lg:grid-cols-[minmax(0,1fr)_260px] lg:gap-8">
        <div className="space-y-5">
          {nameField()}

          {bot ? (
            <div className="space-y-1.5">
              <Label htmlFor="bot-prompt">System prompt</Label>
              <p className="text-xs text-muted-foreground">
                Who {trimmedName || 'the bot'} is and what it does, as instructions to it. You can
                also just tell it in its chat, and it will propose the change for you to approve.
                How it uses its tools is built in.
              </p>
              <Textarea
                id="bot-prompt"
                value={prompt}
                maxLength={BOT_PERSONA_MAX_LENGTH}
                onChange={(e) => setPrompt(e.target.value)}
                rows={12}
                className="min-h-[12rem] font-mono text-sm"
                placeholder={'Blank: the bot asks you who it is.\n\n## Focus\nMining deals in Indonesia. Lead with production volumes and licence status.'}
                data-testid="bot-system-prompt"
              />
              <p className="text-right text-xs text-muted-foreground">
                {prompt.length} / {BOT_PERSONA_MAX_LENGTH}
              </p>
            </div>
          ) : null}

          {bot && !isDefault && (
            <div className="flex items-center justify-between rounded-md border bg-card p-3">
              <div>
                <Label htmlFor="bot-visibility">Share with workspace</Label>
                <p className="text-xs text-muted-foreground">
                  {bot && !bot.is_owner
                    ? 'Only its owner can change who sees it.'
                    : 'Everyone in the workspace can chat with it and edit it.'}
                </p>
              </div>
              <Switch
                id="bot-visibility"
                disabled={!!bot && !bot.is_owner}
                checked={visibility === 'workspace'}
                onCheckedChange={(v) => setVisibility(v ? 'workspace' : 'private')}
              />
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="flex flex-col items-center gap-2 rounded-lg border bg-muted p-4">
            <BotAvatar avatar={avatar} state={previewState} size="lg" label="Avatar preview" />
            <Select
              value={previewState}
              onValueChange={(v) => {
                setAutoPreview(false);
                setPreviewState(v as AvatarState);
              }}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PREVIEW_STATES.map((s) => (
                  <SelectItem key={s} value={s} className="text-xs capitalize">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {lookControls}
        </div>
      </div>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          // An existing bot's dialog has tabs: one fixed height, so switching
          // tabs never resizes it; each tab scrolls inside. A new bot's is small.
          bot
            ? 'flex h-[min(90vh,56rem)] flex-col overflow-hidden sm:max-w-3xl lg:max-w-5xl'
            : 'max-h-[90vh] overflow-y-auto sm:max-w-sm',
        )}
        data-testid="bot-edit-dialog"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{isDefault ? bot!.name : bot ? `Edit ${bot.name}` : 'New bot'}</DialogTitle>
          <DialogDescription className={bot ? undefined : 'sr-only'}>
            {isDefault
              ? 'Your primary bot: always on, with every skill. Your chat, routines and task log with it are yours alone.'
              : bot
                ? 'Every bot has every skill. Its system prompt says who it is; each person gets one ongoing chat with it.'
                : 'A new bot: pick its look and name.'}
          </DialogDescription>
        </DialogHeader>

        {bot ? (
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as BotDialogTab)}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            <TabsList className="shrink-0 self-start">
              <TabsTrigger value="settings">{isDefault ? 'About' : 'Settings'}</TabsTrigger>
              <TabsTrigger value="memory" data-testid="bot-tab-memory">
                Memory
              </TabsTrigger>
              <TabsTrigger value="routines" data-testid="bot-tab-routines">
                Routines
              </TabsTrigger>
              <TabsTrigger value="tasks" data-testid="bot-tab-tasks">
                Task log
              </TabsTrigger>
            </TabsList>
            <TabsContent value="settings" className={cn(TAB_PANEL, 'space-y-4')}>
              {about ?? settings}
            </TabsContent>
            <TabsContent value="memory" className={TAB_PANEL}>
              <BotMemoryTab bot={bot} />
            </TabsContent>
            <TabsContent value="routines" className={TAB_PANEL}>
              <BotRoutinesTab bot={bot} />
            </TabsContent>
            <TabsContent value="tasks" className={TAB_PANEL}>
              <BotTaskLogTab bot={bot} onOpenChat={onOpenChat} />
            </TabsContent>
          </Tabs>
        ) : (
          createForm
        )}

        {/* Always rendered, so the tab panels above keep the same height.
            Routines and the task log save as they go: only Close there. */}
        <DialogFooter className="shrink-0">
          {canArchive && (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive sm:mr-auto"
              onClick={() => setConfirmingArchive(true)}
              disabled={saving || archiving}
              data-testid="bot-archive"
            >
              <Archive className="mr-1.5 h-4 w-4" />
              Archive bot
            </Button>
          )}
          {tab === 'settings' && !isDefault ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="button" onClick={handleSave} disabled={!canSave} data-testid="bot-save">
                {saving ? 'Saving…' : bot ? 'Save' : 'Create bot'}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>

        {bot && (
          <AlertDialog open={confirmingArchive} onOpenChange={setConfirmingArchive}>
            <AlertDialogContent data-testid="bot-archive-confirm">
              <AlertDialogHeader>
                <AlertDialogTitle>Archive {bot.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The bot disappears for everyone it was shared with. Past chats with it are kept
                  but can no longer be continued.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={archiving}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    // Stays open while the request runs; closes itself on success.
                    e.preventDefault();
                    void handleArchive();
                  }}
                  disabled={archiving}
                  data-testid="bot-archive-confirm-action"
                >
                  {archiving ? 'Archiving…' : 'Archive'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Brain Bot's "About" tab: what it is and what it can do. Nothing to edit. */
function BrainBotAbout({ bot }: { bot: BotDto }) {
  return (
    <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)] lg:gap-8" data-testid="brain-bot-about">
      <div className="flex flex-col items-center gap-3 rounded-lg border bg-muted p-6 text-center">
        <BotAvatar avatar={bot.avatar} state="happy" size="lg" label={`${bot.name} avatar`} />
        <div>
          <p className="font-semibold">{bot.name}</p>
          <p className="text-sm text-muted-foreground">The master agent. Orchestrates. Always on.</p>
        </div>
      </div>
      <div className="space-y-5">
        <p className="flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-sm">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          Your primary bot cannot be customized. It always comes first in your
          bots, and it can hand work to any other bot with an @mention.
        </p>
        <div className="space-y-2">
          <Label>Every skill</Label>
          <ul className="grid gap-2 sm:grid-cols-2">
            {BOT_SKILL_KEYS.map((key) => (
              <li key={key} className="rounded-md border bg-card p-2.5 text-sm">
                <span className="font-medium">{BOT_SKILL_META[key].label}</span>
                <span className="block text-xs text-muted-foreground">{BOT_SKILL_META[key].description}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
