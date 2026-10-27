import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BotForbiddenError,
  BotNotFoundError,
  BotService,
  BotValidationError,
  BOT_ORDER_MAX_LENGTH,
} from './botService';
import type { BotRow } from '@/lib/repositories';
import { BRAIN_BOT_AVATAR, BRAIN_BOT_PERSONA } from '@/lib/bots/types';

const repo = vi.hoisted(() => ({
  listVisible: vi.fn(),
  findById: vi.fn(),
  findDefault: vi.fn(),
  ensureDefault: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  savePinned: vi.fn(),
}));
const chats = vi.hoisted(() => ({
  findBotThread: vi.fn(),
  findOrCreateBotThread: vi.fn(),
  markRead: vi.fn(),
  markUnread: vi.fn(),
}));
const workspace = vi.hoisted(() => ({
  getCopilotAgent: vi.fn(),
  dispatchBotMessage: vi.fn(),
  getUser: vi.fn(),
  greet: vi.fn(),
  publishBotsChanged: vi.fn(),
  openRequests: vi.fn(),
}));

function row(overrides: Partial<BotRow> = {}): BotRow {
  return {
    id: 'bot-1',
    workspace_id: 'ws-1',
    owner_user_id: 'owner',
    name: 'Scout',
    system_prompt: '',
    persona_md: '',
    base_flavor: 'mna',
    avatar: {},
    visibility: 'private',
    is_default: false,
    created_at: '2026-10-13T00:00:00Z',
    updated_at: '2026-10-13T00:00:00Z',
    archived_at: null,
    ...overrides,
  };
}

describe('BotService', () => {
  let service: BotService;

  beforeEach(() => {
    for (const fn of [...Object.values(repo), ...Object.values(chats), ...Object.values(workspace)]) {
      fn.mockReset();
    }
    workspace.getCopilotAgent.mockResolvedValue('vc');
    workspace.getUser.mockResolvedValue({ name: 'Nico Alimin', email: 'nico@example.com' });
    workspace.greet.mockResolvedValue(undefined);
    // No thread yet: an open below creates one unless the test says otherwise.
    chats.findBotThread.mockResolvedValue(null);
    service = new BotService(repo as never, chats as never, workspace);
  });

  describe('BotService.list', () => {
    it('creates Brain Bot on the workspace base flavor when none exists yet', async () => {
      const def = row({ id: 'def', owner_user_id: null, is_default: true, visibility: 'workspace' });
      repo.listVisible.mockResolvedValueOnce([row({ owner_user_id: 'owner' })]);
      repo.ensureDefault.mockResolvedValueOnce(def);

      const list = await service.list('owner');

      expect(repo.ensureDefault).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Primary bot',
          base_flavor: 'vc',
          visibility: 'workspace',
          persona_md: BRAIN_BOT_PERSONA,
          avatar: BRAIN_BOT_AVATAR,
        }),
      );
      expect(list.map((b) => b.id)).toEqual(['def', 'bot-1']);
      expect(list[0]).toMatchObject({ name: "Nico's bot", avatar: BRAIN_BOT_AVATAR, can_edit: false });
    });

    it('passes through each bot\'s unread, busy, pinned, last-activity and preview state', async () => {
      repo.listVisible.mockResolvedValueOnce([
        {
          ...row({ id: 'def', owner_user_id: null, is_default: true }),
          unread: false,
          busy: false,
          pinned: true,
          last_activity_at: null,
          last_message: null,
        },
        {
          ...row({ id: 'b1', owner_user_id: 'me' }),
          unread: true,
          busy: true,
          pinned: false,
          last_activity_at: '2026-10-14T08:00:00Z',
          last_message: { role: 'assistant', text: 'Pipeline summary is ready.' },
        },
      ]);

      const list = await service.list('me');

      expect(list.map((b) => [b.id, b.unread, b.busy, b.pinned, b.last_activity_at])).toEqual([
        ['def', false, false, false, null],
        ['b1', true, true, false, '2026-10-14T08:00:00Z'],
      ]);
      expect(list.map((b) => b.last_message)).toEqual([
        null,
        { role: 'assistant', text: 'Pipeline summary is ready.' },
      ]);
    });

    it('marks own and shared bots editable, never Brain Bot, and only own bots owned', async () => {
      repo.listVisible.mockResolvedValueOnce([
        row({ id: 'def', owner_user_id: null, is_default: true, visibility: 'workspace' }),
        row({ id: 'mine', owner_user_id: 'me' }),
        row({ id: 'theirs', owner_user_id: 'other', visibility: 'workspace' }),
      ]);

      const list = await service.list('me');

      expect(repo.ensureDefault).not.toHaveBeenCalled();
      expect(Object.fromEntries(list.map((b) => [b.id, b.can_edit]))).toEqual({
        def: false,
        mine: true,
        theirs: true,
      });
      expect(Object.fromEntries(list.map((b) => [b.id, b.is_owner]))).toEqual({
        def: false,
        mine: true,
        theirs: false,
      });
    });

    it('fills in avatar defaults and shows a legacy persona without its managed block', async () => {
      repo.listVisible.mockResolvedValueOnce([
        row({ is_default: true, owner_user_id: null, visibility: 'workspace' }),
        row({ avatar: { hue: 400 }, persona_md: '<!-- managed:start (x) -->\n# Scout\n<!-- managed:end -->\n\nBe brief.' }),
      ]);

      const [, bot] = await service.list('owner');

      expect(bot.persona_md).toBe('Be brief.');
      expect(bot.avatar).toEqual({ hue: 40, eyes: 'round', mood: 'cheerful', shape: 'nova' });
    });

    it('shows Brain Bot with its fixed name, look and persona, whatever its row holds', async () => {
      repo.listVisible.mockResolvedValueOnce([
        row({ id: 'def', is_default: true, owner_user_id: null, visibility: 'workspace', name: 'Copilot', persona_md: 'x', avatar: { shape: 'pixel' } }),
      ]);

      const [bot] = await service.list('me');

      expect(bot).toMatchObject({ name: "Nico's bot", avatar: BRAIN_BOT_AVATAR, persona_md: BRAIN_BOT_PERSONA });
      expect(workspace.getUser).toHaveBeenCalledWith('me');
    });

    it("names the primary bot after each user, reading their name once and only when it's listed", async () => {
      const def = row({ id: 'def', is_default: true, owner_user_id: null, visibility: 'workspace' });
      workspace.getUser.mockImplementation(async (id: string) =>
        id === 'a' ? { name: 'test user' } : { name: null, email: 'jane.doe@example.com' },
      );
      repo.listVisible.mockResolvedValue([def]);

      expect((await service.list('a'))[0].name).toBe("Test's bot");
      expect((await service.list('a'))[0].name).toBe("Test's bot");
      expect((await service.list('b'))[0].name).toBe("Jane's bot");
      expect(workspace.getUser).toHaveBeenCalledTimes(2);

      workspace.getUser.mockClear();
      repo.listVisible.mockResolvedValue([row({ owner_user_id: 'c' })]);
      repo.ensureDefault.mockResolvedValue(null);
      await service.list('c');
      expect(workspace.getUser).not.toHaveBeenCalled();
    });

    it('never reports Brain Bot as pinned even when it still sits in bot_orders', async () => {
      repo.listVisible.mockResolvedValueOnce([
        {
          ...row({ id: 'def', is_default: true, owner_user_id: null, visibility: 'workspace' }),
          pinned: true,
          unread: false,
          busy: false,
          last_activity_at: null,
          last_message: null,
        },
      ]);

      const [bot] = await service.list('me');

      expect(bot.pinned).toBe(false);
    });
  });

  describe('BotService.list unread', () => {
    it("passes through whether the user's thread with each bot has an unseen reply", async () => {
      repo.listVisible.mockResolvedValueOnce([
        { ...row({ id: 'def', is_default: true }), unread: false },
        { ...row({ id: 'scout' }), unread: true },
      ]);

      const list = await service.list('owner');

      expect(Object.fromEntries(list.map((b) => [b.id, b.unread]))).toEqual({ def: false, scout: true });
    });
  });

  describe('BotService.create', () => {
    it('makes a private bot on the workspace Copilot with a blank persona, from a name and a look', async () => {
      repo.create.mockImplementationOnce(async (input) => row({ ...input, id: 'new' }));

      const bot = await service.create('me', { name: '  Scout  ', avatar: { hue: 10, shape: 'hexa' } });

      expect(repo.create).toHaveBeenCalledWith({
        owner_user_id: 'me',
        name: 'Scout',
        persona_md: '',
        base_flavor: 'vc',
        avatar: { hue: 10, eyes: 'round', mood: 'cheerful', shape: 'hexa' },
        visibility: 'private',
        is_default: false,
      });
      expect(bot).toMatchObject({ persona_md: '', can_edit: true });
    });

    it("greets its creator in their chat with it, asking who it is", async () => {
      repo.create.mockImplementationOnce(async (input) => row({ ...input, id: 'new' }));

      await service.create('me', { name: 'Scout' });

      expect(workspace.greet).toHaveBeenCalledWith({
        userId: 'me',
        bot: expect.objectContaining({ id: 'new', name: 'Scout' }),
        text: "Hi there! I'm Scout. Tell me who I am and what I do!",
      });
    });

    it('keeps the bot when the greeting fails, and skips it for a bot that already has a persona', async () => {
      repo.create.mockImplementation(async (input) => row({ ...input, id: 'new' }));
      workspace.greet.mockRejectedValueOnce(new Error('checkpointer down'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(service.create('me', { name: 'Scout' })).resolves.toMatchObject({ id: 'new' });
      expect(error).toHaveBeenCalled();
      error.mockRestore();

      workspace.greet.mockClear();
      await service.create('me', { name: 'Scout', persona_md: 'Find deals.' });
      expect(workspace.greet).not.toHaveBeenCalled();
    });

    it('still accepts the old system_prompt field as the persona', async () => {
      repo.create.mockImplementationOnce(async (input) => row({ ...input, id: 'new' }));
      await service.create('me', { name: 'Scout', system_prompt: 'Old prompt.' });
      expect(repo.create.mock.calls[0][0].persona_md).toBe('Old prompt.');
    });

    it.each([
      [{ name: '' }, 'Name is required'],
      [{ name: 'x'.repeat(61) }, 'Name must be at most 60 characters'],
      [{ name: 'ok', visibility: 'public' }, 'Visibility must be private or workspace'],
      [{ name: 'ok', persona_md: 'x'.repeat(16_001) }, 'Persona must be at most 16000 characters'],
    ])('rejects invalid input %j', async (input, message) => {
      await expect(service.create('me', input)).rejects.toThrow(new BotValidationError(message));
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('BotService.update', () => {
    it("hides another user's private bot as not found", async () => {
      repo.findById.mockResolvedValueOnce(row({ owner_user_id: 'other' }));
      await expect(service.update('me', 'bot-1', { name: 'x' })).rejects.toBeInstanceOf(BotNotFoundError);
    });

    it("lets anyone edit someone else's shared bot, but not change who sees it", async () => {
      const shared = row({ owner_user_id: 'other', visibility: 'workspace' });
      repo.findById.mockResolvedValue(shared);
      repo.update.mockResolvedValueOnce({ ...shared, name: 'Atlas' });

      const updated = await service.update('me', 'bot-1', { name: 'Atlas', visibility: 'workspace' });
      expect(updated.name).toBe('Atlas');
      expect(repo.update.mock.calls[0][1]).not.toHaveProperty('visibility');

      await expect(service.update('me', 'bot-1', { visibility: 'private' })).rejects.toBeInstanceOf(
        BotForbiddenError,
      );
      expect(repo.update).toHaveBeenCalledTimes(1);
    });

    it('lets the owner make their shared bot private', async () => {
      repo.findById.mockResolvedValueOnce(row({ owner_user_id: 'me', visibility: 'workspace' }));
      repo.update.mockResolvedValueOnce(row({ owner_user_id: 'me' }));
      await service.update('me', 'bot-1', { visibility: 'private' });
      expect(repo.update.mock.calls[0][1]).toMatchObject({ visibility: 'private' });
    });

    it('never lets anyone change Brain Bot', async () => {
      const def = row({ owner_user_id: null, is_default: true, visibility: 'workspace' });
      repo.findById.mockResolvedValue(def);

      await expect(service.update('anyone', 'bot-1', { name: 'Atlas' })).rejects.toBeInstanceOf(BotForbiddenError);
      await expect(service.previewUpdate('anyone', 'bot-1', { persona_md: 'x' })).rejects.toBeInstanceOf(
        BotForbiddenError,
      );
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("refuses Brain Bot's look for any other bot", async () => {
      repo.findById.mockResolvedValueOnce(row({ owner_user_id: 'me' }));
      await expect(service.update('me', 'bot-1', { avatar: { shape: 'apex' } })).rejects.toBeInstanceOf(
        BotValidationError,
      );
      await expect(service.create('me', { name: 'Copycat', avatar: { shape: 'apex' } })).rejects.toBeInstanceOf(
        BotValidationError,
      );
    });

    it('only writes the fields that were sent; skills and the base flavor are not settable', async () => {
      repo.findById.mockResolvedValueOnce(row({ owner_user_id: 'me', persona_md: 'Mine.' }));
      repo.update.mockImplementationOnce(async (_id, patch) => row({ owner_user_id: 'me', ...patch }));

      const bot = await service.update('me', 'bot-1', {
        name: 'Atlas',
        skills: ['email'],
        base_flavor: 'vc',
      } as never);

      const [, patch] = repo.update.mock.calls[0];
      expect(Object.keys(patch)).toEqual(['name', 'persona_md']);
      expect(patch.persona_md).toBe('Mine.');
      expect(bot.name).toBe('Atlas');
    });

    it('stores an edited persona as the text alone', async () => {
      repo.findById.mockResolvedValueOnce(row({ owner_user_id: 'me' }));
      repo.update.mockImplementationOnce(async (_id, patch) => row({ owner_user_id: 'me', ...patch }));

      const bot = await service.update('me', 'bot-1', { persona_md: '  ## Focus\n\nDeals.  ' });

      expect(repo.update.mock.calls[0][1]).toEqual({ persona_md: '## Focus\n\nDeals.' });
      expect(bot.persona_md).toBe('## Focus\n\nDeals.');
    });
  });

  describe('BotService live announcements', () => {
    it('announces a private bot to its owner only, and a shared one to the workspace', async () => {
      repo.create.mockImplementationOnce(async (input) => row({ ...input, id: 'new' }));
      await service.create('me', { name: 'Scout' });
      expect(workspace.publishBotsChanged).toHaveBeenLastCalledWith('me');

      repo.findById.mockResolvedValueOnce(row({ owner_user_id: 'other', visibility: 'workspace' }));
      repo.update.mockResolvedValueOnce(row({ owner_user_id: 'other', visibility: 'workspace', name: 'Atlas' }));
      await service.update('me', 'bot-1', { name: 'Atlas' });
      expect(workspace.publishBotsChanged).toHaveBeenLastCalledWith(null);
    });

    it('announces a bot going private to everyone, since it leaves their lists', async () => {
      repo.findById.mockResolvedValueOnce(row({ owner_user_id: 'me', visibility: 'workspace' }));
      repo.update.mockResolvedValueOnce(row({ owner_user_id: 'me', visibility: 'private' }));
      await service.update('me', 'bot-1', { visibility: 'private' });
      expect(workspace.publishBotsChanged).toHaveBeenLastCalledWith(null);
    });

    it('announces an archive and a pin change, and survives a failed announcement', async () => {
      repo.findById.mockResolvedValueOnce(row({ owner_user_id: 'me' }));
      repo.archive.mockResolvedValueOnce(true);
      workspace.publishBotsChanged.mockRejectedValueOnce(new Error('redis down'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(service.archive('me', 'bot-1')).resolves.toBeUndefined();
      expect(workspace.publishBotsChanged).toHaveBeenLastCalledWith('me');
      expect(error).toHaveBeenCalled();
      error.mockRestore();

      repo.listVisible.mockResolvedValue([row({ id: 'b1', owner_user_id: 'me' })]);
      repo.savePinned.mockResolvedValue(undefined);
      await service.setPinned('me', ['b1']);
      expect(workspace.publishBotsChanged).toHaveBeenLastCalledWith('me');
    });
  });

  describe('BotService.archive', () => {
    it('refuses to archive the default bot', async () => {
      repo.findById.mockResolvedValueOnce(row({ owner_user_id: null, is_default: true, visibility: 'workspace' }));
      await expect(service.archive('admin', 'bot-1')).rejects.toBeInstanceOf(BotForbiddenError);
      expect(repo.archive).not.toHaveBeenCalled();
    });

    it("refuses to archive someone else's shared bot", async () => {
      repo.findById.mockResolvedValueOnce(row({ owner_user_id: 'other', visibility: 'workspace' }));
      await expect(service.archive('me', 'bot-1')).rejects.toBeInstanceOf(BotForbiddenError);
      expect(repo.archive).not.toHaveBeenCalled();
    });

    it("archives the owner's own bot", async () => {
      repo.findById.mockResolvedValueOnce(row({ owner_user_id: 'me' }));
      repo.archive.mockResolvedValueOnce(true);
      await service.archive('me', 'bot-1');
      expect(repo.archive).toHaveBeenCalledWith('bot-1');
    });
  });

  describe('BotService.openThread', () => {
    it("returns the user's thread with a bot they can see, in one read, without an insert", async () => {
      const bot = row({ owner_user_id: 'other', visibility: 'workspace', persona_md: 'Deal scout.' });
      const chat = { id: 'chat-1', last_message_at: '2026-10-19T00:00:00Z', history_imported_at: null };
      repo.findById.mockResolvedValueOnce(bot);
      chats.findBotThread.mockResolvedValueOnce(chat);

      await expect(service.openThread('me', 'bot-1')).resolves.toEqual({ bot, chat });
      expect(chats.findBotThread).toHaveBeenCalledWith('me', 'bot-1');
      expect(chats.findOrCreateBotThread).not.toHaveBeenCalled();
    });

    it("creates the user's permanent thread on its first open, titled with the bot's name", async () => {
      const bot = row({ owner_user_id: 'other', visibility: 'workspace', persona_md: 'Deal scout.' });
      const chat = { id: 'chat-1', last_message_at: null, history_imported_at: null };
      repo.findById.mockResolvedValueOnce(bot);
      chats.findOrCreateBotThread.mockResolvedValueOnce(chat);

      await expect(service.openThread('me', 'bot-1')).resolves.toEqual({ bot, chat });
      expect(chats.findOrCreateBotThread).toHaveBeenCalledWith('me', 'bot-1', 'Scout');
      expect(workspace.greet).not.toHaveBeenCalled();
    });

    it('retries the greeting when the bot still has a blank persona and no messages yet', async () => {
      const bot = row({ owner_user_id: 'me', persona_md: '' });
      const chat = { id: 'chat-1', last_message_at: null, history_imported_at: null };
      repo.findById.mockResolvedValueOnce(bot);
      chats.findOrCreateBotThread.mockResolvedValueOnce(chat);

      await service.openThread('me', 'bot-1');

      expect(workspace.greet).toHaveBeenCalledWith({
        userId: 'me',
        bot,
        text: "Hi there! I'm Scout. Tell me who I am and what I do!",
      });
    });

    it('does not retry the greeting once the thread has a stored message', async () => {
      const bot = row({ owner_user_id: 'me', persona_md: '' });
      const chat = { id: 'chat-1', last_message_at: '2026-10-19T00:00:00Z', history_imported_at: null };
      repo.findById.mockResolvedValueOnce(bot);
      chats.findOrCreateBotThread.mockResolvedValueOnce(chat);
      workspace.greet.mockClear();

      await service.openThread('me', 'bot-1');

      expect(workspace.greet).not.toHaveBeenCalled();
    });

    it('never opens a thread on a bot the user cannot see', async () => {
      repo.findById.mockResolvedValueOnce(row({ owner_user_id: 'other', visibility: 'private' }));
      await expect(service.openThread('me', 'bot-1')).rejects.toBeInstanceOf(BotNotFoundError);
      expect(chats.findOrCreateBotThread).not.toHaveBeenCalled();
    });
  });

  describe('BotService.openDefaultThread', () => {
    it("opens the user's thread with Brain Bot, as the app runs it", async () => {
      const def = row({ id: 'def', owner_user_id: null, is_default: true, visibility: 'workspace', name: 'Copilot' });
      repo.findDefault.mockResolvedValueOnce(def);
      chats.findOrCreateBotThread.mockResolvedValueOnce({ id: 'chat-def' });

      const { bot, chat } = await service.openDefaultThread('me');
      expect(chat).toEqual({ id: 'chat-def' });
      expect(bot).toMatchObject({ id: 'def', name: "Nico's bot", avatar: BRAIN_BOT_AVATAR });
      expect(repo.ensureDefault).not.toHaveBeenCalled();
      expect(chats.findOrCreateBotThread).toHaveBeenCalledWith('me', 'def', "Nico's bot");
    });

    it('creates Brain Bot first when the workspace has none', async () => {
      const def = row({ id: 'def', owner_user_id: null, is_default: true, visibility: 'workspace', name: 'Copilot' });
      repo.findDefault.mockResolvedValueOnce(null);
      repo.ensureDefault.mockResolvedValueOnce(def);
      chats.findOrCreateBotThread.mockResolvedValueOnce({ id: 'chat-def' });

      await service.openDefaultThread('me');

      expect(repo.ensureDefault).toHaveBeenCalledWith(expect.objectContaining({ base_flavor: 'vc' }));
      expect(chats.findOrCreateBotThread).toHaveBeenCalledWith('me', 'def', "Nico's bot");
    });

    it("reads the user's name and the thread together, not one after the other", async () => {
      const def = row({ id: 'def', owner_user_id: null, is_default: true, visibility: 'workspace', name: 'Copilot' });
      repo.findDefault.mockResolvedValueOnce(def);
      let releaseUser!: (user: { name: string }) => void;
      workspace.getUser.mockReturnValueOnce(new Promise((resolve) => { releaseUser = resolve; }));
      let threadReadWhileUserPending = false;
      chats.findBotThread.mockImplementationOnce(async () => {
        threadReadWhileUserPending = true;
        return { id: 'chat-def' };
      });

      const opening = service.openDefaultThread('me');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(threadReadWhileUserPending).toBe(true);
      releaseUser({ name: 'Nico Alimin' });

      const { bot, chat } = await opening;
      expect(chat).toEqual({ id: 'chat-def' });
      expect(bot.name).toBe("Nico's bot");
      expect(chats.findOrCreateBotThread).not.toHaveBeenCalled();
    });
  });

  describe('BotService.prepareMentionContext', () => {
    const def = row({ id: 'def', owner_user_id: null, is_default: true, visibility: 'workspace' });
    const scout = row({ id: 'scout', name: 'Scout', owner_user_id: 'me' });

    it('starts the list read at once and writes the note for the bot named later', async () => {
      repo.listVisible.mockResolvedValue([def, scout]);

      const note = service.prepareMentionContext('me');
      expect(repo.listVisible).toHaveBeenCalledWith('me');

      const written = await note('def');
      expect(written).toContain('Scout');
      expect(written).toBe(await service.mentionContext('me', 'def'));
    });

    it('shares one user read between a list and a thread open in flight together', async () => {
      repo.listVisible.mockResolvedValue([def, scout]);
      repo.findDefault.mockResolvedValue(def);
      chats.findBotThread.mockResolvedValue({ id: 'chat-def' });

      const note = service.prepareMentionContext('me');
      const { bot } = await service.openDefaultThread('me');
      await note(bot.id);

      expect(workspace.getUser).toHaveBeenCalledTimes(1);
      expect(bot.name).toBe("Nico's bot");
    });

    it('surfaces a failed list read when the note is asked for, not before', async () => {
      repo.listVisible.mockRejectedValueOnce(new Error('db down'));

      const note = service.prepareMentionContext('me');
      await new Promise((resolve) => setTimeout(resolve, 0));

      await expect(note('def')).rejects.toThrow('db down');
    });
  });

  describe('BotService.previewCreate / previewUpdate', () => {
    it('validates a new bot without writing it', () => {
      expect(service.previewCreate({ name: ' Scout ' })).toMatchObject({
        name: 'Scout',
        persona_md: '',
        visibility: 'private',
      });
      expect(() => service.previewCreate({ name: '' })).toThrow(BotValidationError);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('shows the bot before and after, listing only what changes', async () => {
      repo.findById.mockResolvedValueOnce(row({ owner_user_id: 'me', persona_md: 'Old.' }));

      const preview = await service.previewUpdate('me', 'bot-1', { name: 'Atlas', persona_md: 'Old.' });

      expect(preview.before.name).toBe('Scout');
      expect(preview.after.name).toBe('Atlas');
      expect(preview.changed).toEqual(['name']);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("refuses a bot the user cannot see, before any card is shown", async () => {
      repo.findById.mockResolvedValueOnce(row({ owner_user_id: 'other', visibility: 'private' }));
      await expect(service.previewUpdate('me', 'bot-1', { name: 'x' })).rejects.toBeInstanceOf(BotNotFoundError);
    });
  });

  describe('BotService.dispatchMentions', () => {
    const copilot = { id: 'copilot', name: 'Copilot' };
    beforeEach(() => {
      repo.listVisible.mockResolvedValue([
        row({ id: 'copilot', name: 'Copilot' }),
        row({ id: 'scout', name: 'Deal Scout' }),
        row({ id: 'atlas', name: 'Atlas' }),
      ]);
      workspace.dispatchBotMessage.mockResolvedValue({ jobId: 'j' });
    });

    it("hands the user's message to the bots it mentions, and the reply to the bots the reply mentions", async () => {
      const pinged = await service.dispatchMentions('me', {
        bot: copilot,
        userText: ' @Deal Scout find fintech targets ',
        replyText: 'Asked Deal Scout. @Atlas, check the CRM. @Deal Scout too.',
      });

      expect(pinged).toEqual(['scout', 'atlas']);
      expect(workspace.dispatchBotMessage.mock.calls.map(([job]) => job)).toEqual([
        {
          userId: 'me',
          origin: { kind: 'user_mention', inBot: copilot },
          toBotId: 'scout',
          text: '@Deal Scout find fintech targets',
        },
        {
          userId: 'me',
          origin: { kind: 'bot_mention', fromBot: copilot },
          toBotId: 'atlas',
          text: 'Asked Deal Scout. @Atlas, check the CRM. @Deal Scout too.',
        },
      ]);
    });

    it('never pings the bot itself, and reads no bots when nothing is mentioned', async () => {
      expect(await service.dispatchMentions('me', { bot: copilot, userText: '@Copilot hi' })).toEqual([]);
      expect(await service.dispatchMentions('me', { bot: copilot, userText: 'hi', replyText: 'hello' })).toEqual([]);
      expect(repo.listVisible).toHaveBeenCalledTimes(1);
      expect(workspace.dispatchBotMessage).not.toHaveBeenCalled();
    });

    it('hands a long reply on whole — a research report is not clipped', async () => {
      const report = `@Atlas, here is the full report.\n\n${'Section. '.repeat(3_000).trimEnd()}`;

      await service.dispatchMentions('me', { bot: copilot, replyText: `  ${report}\n` });

      expect(workspace.dispatchBotMessage).toHaveBeenCalledTimes(1);
      expect(workspace.dispatchBotMessage.mock.calls[0][0].text).toBe(report);
    });

    it("pings every bot the user's message mentions, past the reply cap", async () => {
      const many = ['a', 'b', 'c', 'd', 'e'].map((n) => row({ id: n, name: `Bot ${n}` }));
      repo.listVisible.mockResolvedValue([row({ id: 'copilot', name: 'Copilot' }), ...many]);
      const text = many.map((b) => `@${b.name}`).join(' ');

      expect(await service.dispatchMentions('me', { bot: copilot, userText: text })).toEqual(['a', 'b', 'c', 'd', 'e']);
      workspace.dispatchBotMessage.mockClear();
      expect(await service.dispatchMentions('me', { bot: copilot, replyText: text })).toEqual(['a', 'b', 'c']);
    });

    it("records a request per bot the reply mentions, grouped by the turn, and stamps it on the job", async () => {
      workspace.openRequests.mockImplementation(async ({ targets }: { targets: { id: string }[] }) =>
        targets.map((t, i) => ({ id: `req-${i}`, to_bot_id: t.id })),
      );

      await service.dispatchMentions('me', {
        bot: copilot,
        replyText: 'Over to @Deal Scout and @Atlas.',
        chatId: 'chat-copilot',
        turnId: 'turn-7',
      });

      expect(workspace.openRequests).toHaveBeenCalledWith({
        userId: 'me',
        fromBot: copilot,
        fromChatId: 'chat-copilot',
        groupId: 'turn-7',
        targets: [
          { id: 'scout', name: 'Deal Scout' },
          { id: 'atlas', name: 'Atlas' },
        ],
        ask: 'Over to @Deal Scout and @Atlas.',
      });
      expect(workspace.dispatchBotMessage.mock.calls.map(([job]) => [job.toBotId, job.requestId])).toEqual([
        ['scout', 'req-0'],
        ['atlas', 'req-1'],
      ]);
    });

    it("opens no request for the user's own @mentions, nor without the asker's thread, and still pings when opening fails", async () => {
      await service.dispatchMentions('me', { bot: copilot, userText: '@Atlas hi', chatId: 'chat-copilot', turnId: 't' });
      await service.dispatchMentions('me', { bot: copilot, replyText: '@Atlas hi' });
      expect(workspace.openRequests).not.toHaveBeenCalled();

      workspace.openRequests.mockRejectedValueOnce(new Error('db down'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const pinged = await service.dispatchMentions('me', { bot: copilot, replyText: '@Atlas hi', chatId: 'c', turnId: 't' });
      expect(pinged).toEqual(['atlas']);
      expect(workspace.dispatchBotMessage.mock.calls.at(-1)?.[0].requestId).toBeUndefined();
      error.mockRestore();
    });

    it('skips reply mentions of bots the user already pinged', async () => {
      const pinged = await service.dispatchMentions('me', {
        bot: copilot,
        replyText: 'Over to @Deal Scout and @Atlas.',
        alreadyPinged: ['scout'],
      });
      expect(pinged).toEqual(['atlas']);
    });

    it('keeps going when one ping fails to queue', async () => {
      workspace.dispatchBotMessage.mockRejectedValueOnce(new Error('db down'));
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const pinged = await service.dispatchMentions('me', { bot: copilot, userText: '@Atlas and @Deal Scout' });
      expect(pinged).toEqual(['scout']);
      err.mockRestore();
    });
  });

  describe('BotService.mentionContext', () => {
    it('names the other bots the user can see', async () => {
      repo.listVisible.mockResolvedValueOnce([row({ id: 'copilot', name: 'Copilot' }), row({ id: 'atlas', name: 'Atlas' })]);
      const note = await service.mentionContext('me', 'copilot');
      expect(note).toContain('these bots: Atlas.');
    });
  });

  describe('BotService.markRead', () => {
    it("marks the user's thread with a visible bot read", async () => {
      repo.findById.mockResolvedValueOnce(row({ owner_user_id: 'me' }));
      chats.findOrCreateBotThread.mockResolvedValueOnce({ id: 'chat-1' });

      await service.markRead('me', 'bot-1');

      expect(chats.markRead).toHaveBeenCalledWith('chat-1');
    });
  });

  describe('BotService.markUnread', () => {
    it("marks the user's thread with a visible bot unread", async () => {
      repo.findById.mockResolvedValueOnce(row({ owner_user_id: 'me' }));
      chats.findOrCreateBotThread.mockResolvedValueOnce({ id: 'chat-1' });

      await service.markUnread('me', 'bot-1');

      expect(chats.markUnread).toHaveBeenCalledWith('chat-1');
    });

    it("refuses a private bot the user can't see", async () => {
      repo.findById.mockResolvedValueOnce(row({ owner_user_id: 'someone-else', visibility: 'private' }));

      await expect(service.markUnread('me', 'bot-1')).rejects.toBeInstanceOf(BotNotFoundError);
      expect(chats.markUnread).not.toHaveBeenCalled();
    });
  });

  describe('BotService.setPinned', () => {
    const def = row({ id: 'def', owner_user_id: null, is_default: true, visibility: 'workspace' });

    it('saves only bots the user can see, de-duplicated and never Brain Bot, and returns the list', async () => {
      const visible = [
        { ...def, unread: false },
        { ...row({ id: 'b1', owner_user_id: 'me' }), unread: false },
      ];
      repo.listVisible.mockResolvedValue(visible);

      const list = await service.setPinned('me', ['b1', 'someone-elses', 'b1', 'def']);

      expect(repo.savePinned).toHaveBeenCalledWith('me', ['b1']);
      expect(list.map((b) => b.id)).toEqual(['def', 'b1']);
    });

    it('rejects anything but a list of ids without saving', async () => {
      await expect(service.setPinned('me', 'b1')).rejects.toBeInstanceOf(BotValidationError);
      await expect(service.setPinned('me', [1, 2])).rejects.toBeInstanceOf(BotValidationError);
      await expect(
        service.setPinned('me', Array.from({ length: BOT_ORDER_MAX_LENGTH + 1 }, (_, i) => `b${i}`)),
      ).rejects.toBeInstanceOf(BotValidationError);
      expect(repo.savePinned).not.toHaveBeenCalled();
    });
  });
});
