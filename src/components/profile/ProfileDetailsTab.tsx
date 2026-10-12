'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { getMyProfile, updateMyProfile, type UserProfile } from '@/lib/api/profileMe';

/**
 * Dialling codes the phone field offers, matching the prototype. A short list
 * on purpose: this is the region the product operates in, and a 200-entry
 * picker would be worse for everyone who lives in these seven.
 */
const PHONE_CODES = [
  { value: '+62', label: '🇮🇩 +62' },
  { value: '+65', label: '🇸🇬 +65' },
  { value: '+60', label: '🇲🇾 +60' },
  { value: '+66', label: '🇹🇭 +66' },
  { value: '+63', label: '🇵🇭 +63' },
  { value: '+84', label: '🇻🇳 +84' },
  { value: '+1', label: '🇺🇸 +1' },
];

const DEFAULT_PHONE_CODE = '+62';

/** The fields the form edits, as controlled strings. */
type Draft = Pick<
  UserProfile,
  'fullName' | 'nickName' | 'phoneCode' | 'phone' | 'jobTitle' | 'howBrainHelps'
>;

function toDraft(profile: UserProfile): Draft {
  return {
    fullName: profile.fullName,
    nickName: profile.nickName,
    // An account that has never set one lands on the default rather than an
    // empty select, which would render as a blank control.
    phoneCode: profile.phoneCode || DEFAULT_PHONE_CODE,
    phone: profile.phone,
    jobTitle: profile.jobTitle,
    howBrainHelps: profile.howBrainHelps,
  };
}

function isDirty(draft: Draft, saved: Draft): boolean {
  return (Object.keys(draft) as (keyof Draft)[]).some((key) => draft[key] !== saved[key]);
}

/**
 * Profile → Your Profile: the account details the user maintains themselves.
 *
 * `email` is shown but disabled — it is the sign-in identity, and changing one
 * is an admin operation (`/api/users/:id`), deliberately not reachable from a
 * self-service form.
 *
 * Save is disabled until something actually changes, so the button is a
 * statement about unsaved work rather than decoration.
 */
export default function ProfileDetailsTab() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const data = await getMyProfile();
      setProfile(data);
      setDraft(toDraft(data));
      setSaved(toDraft(data));
    } catch (err) {
      console.error('Failed to load profile', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchProfile();
  }, [fetchProfile]);

  const set = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }, []);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const updated = await updateMyProfile(draft);
      setProfile(updated);
      // Re-seed from the server's response, not the draft: it has trimmed and
      // normalized the values, and the form should show what was stored.
      setDraft(toDraft(updated));
      setSaved(toDraft(updated));
      toast.success('Profile saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save your profile');
    } finally {
      setSaving(false);
    }
  }, [draft]);

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4" data-testid="profile-details-loading">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (error || !draft || !saved || !profile) {
    return (
      <div className="rounded-xl border bg-card p-6 text-center">
        <p className="text-sm text-muted-foreground">Could not load your profile.</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={fetchProfile}>
          Try again
        </Button>
      </div>
    );
  }

  const dirty = isDirty(draft, saved);

  return (
    <div
      className="mx-auto flex w-full max-w-xl flex-col gap-4 rounded-xl border bg-card p-6"
      data-testid="profile-details"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="profile-full-name">Full Name</Label>
        <Input
          id="profile-full-name"
          data-testid="profile-full-name"
          value={draft.fullName}
          onChange={(e) => set('fullName', e.target.value)}
          disabled={saving}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="profile-nick-name">Nick Name</Label>
        <Input
          id="profile-nick-name"
          data-testid="profile-nick-name"
          value={draft.nickName}
          onChange={(e) => set('nickName', e.target.value)}
          placeholder="What should the CoPilot call you?"
          disabled={saving}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="profile-email">Email</Label>
        <Input
          id="profile-email"
          data-testid="profile-email"
          value={profile.email}
          disabled
          readOnly
        />
        <p className="text-xs text-muted-foreground">
          This is how you sign in. An administrator can change it for you.
        </p>
      </div>

      <div className="flex gap-2.5">
        <div className="flex w-28 shrink-0 flex-col gap-1.5">
          <Label htmlFor="profile-phone-code">Code</Label>
          <Select
            value={draft.phoneCode}
            onValueChange={(value) => set('phoneCode', value)}
            disabled={saving}
          >
            <SelectTrigger id="profile-phone-code" data-testid="profile-phone-code">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PHONE_CODES.map((code) => (
                <SelectItem key={code.value} value={code.value}>
                  {code.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="profile-phone">Phone</Label>
          <Input
            id="profile-phone"
            data-testid="profile-phone"
            value={draft.phone}
            onChange={(e) => set('phone', e.target.value)}
            inputMode="tel"
            disabled={saving}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="profile-job-title">Job Title or Role</Label>
        <Input
          id="profile-job-title"
          data-testid="profile-job-title"
          value={draft.jobTitle}
          onChange={(e) => set('jobTitle', e.target.value)}
          placeholder="Investment Associate"
          disabled={saving}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="profile-how-brain-helps">How Brain Can Help Your Job</Label>
        <Textarea
          id="profile-how-brain-helps"
          data-testid="profile-how-brain-helps"
          value={draft.howBrainHelps}
          onChange={(e) => set('howBrainHelps', e.target.value)}
          placeholder="Helps me screen inbound deals faster and keep the pipeline up to date without manual data entry."
          rows={3}
          className="resize-y"
          disabled={saving}
        />
      </div>

      <div className="flex justify-end pt-1">
        <Button
          onClick={handleSave}
          disabled={!dirty || saving}
          data-testid="profile-save"
        >
          {saving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            'Save Changes'
          )}
        </Button>
      </div>
    </div>
  );
}
