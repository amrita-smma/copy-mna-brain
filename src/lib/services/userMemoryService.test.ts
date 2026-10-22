import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MemoryImportTooLargeError,
  MemoryUnavailableError,
  UserMemoryService,
} from './userMemoryService';
import {
  MAX_IMPORT_CHARS,
  MAX_IMPORT_STATEMENTS,
  MAX_IMPORT_STATEMENT_CHARS,
} from '@/lib/memory/limits';

const USER = 'user-1';

const repo = {
  list: vi.fn(),
  count: vi.fn(),
  deleteByIds: vi.fn(),
  deleteAll: vi.fn(),
};

const client = {
  add: vi.fn(),
  search: vi.fn(),
  getAll: vi.fn(),
  delete: vi.fn(),
};

const userRepo = {
  findCopilotMemoryEnabled: vi.fn(),
  setCopilotMemoryEnabled: vi.fn(),
};

const buildClient = vi.fn(async () => client as never);
/** Our extraction gate — the thing that decides what a turn contributes. */
const extractFacts = vi.fn();

/** The @memory_import agent run, stubbed. */
const runImport = vi.fn();

function makeService(configured = true, recallTimeoutMs = 4_000) {
  return new UserMemoryService(
    repo as never,
    userRepo as never,
    USER,
    buildClient as never,
    () => configured,
    recallTimeoutMs,
    extractFacts as never,
    runImport as never,
  );
}

beforeEach(() => {
  [
    ...Object.values(repo),
    ...Object.values(client),
    ...Object.values(userRepo),
    buildClient,
    extractFacts,
    runImport,
  ].forEach((fn) => fn.mockReset());
  runImport.mockResolvedValue({ statements: [], summary: '' });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  // The ordinary turn contributes nothing.
  extractFacts.mockResolvedValue([]);
  userRepo.findCopilotMemoryEnabled.mockResolvedValue(true);
  userRepo.setCopilotMemoryEnabled.mockImplementation(
    async (_id: string, enabled: boolean) => enabled,
  );
  buildClient.mockResolvedValue(client as never);
  client.add.mockResolvedValue({ results: [] });
  client.search.mockResolvedValue({ results: [] });
  repo.list.mockResolvedValue([]);
  repo.count.mockResolvedValue(0);
  repo.deleteByIds.mockResolvedValue(0);
  repo.deleteAll.mockResolvedValue(0);
});

describe('UserMemoryService.recallForTurn', () => {
  it('renders the recalled memories as a system-context block', async () => {
    client.search.mockResolvedValue({
      results: [
        { id: 'm1', memory: 'Focuses on Indonesian coal', score: 0.9 },
        { id: 'm2', memory: 'Prefers short answers', score: 0.7 },
      ],
    });

    const block = await makeService().recallForTurn('What about Acme?');

    expect(block).toContain('- Focuses on Indonesian coal');
    expect(block).toContain('- Prefers short answers');
    // mem0 3.x rejects a top-level userId on search; the user goes in filters.
    expect(client.search).toHaveBeenCalledWith('What about Acme?', {
      filters: { user_id: USER },
      topK: expect.any(Number),
    });
  });

  it('returns null without calling mem0 for a blank query', async () => {
    expect(await makeService().recallForTurn('   ')).toBeNull();
    expect(client.search).not.toHaveBeenCalled();
  });

  it('returns null without calling mem0 when memory is not configured', async () => {
    expect(await makeService(false).recallForTurn('hello')).toBeNull();
    expect(buildClient).not.toHaveBeenCalled();
  });

  it('returns null without calling mem0 when the user turned memory off', async () => {
    userRepo.findCopilotMemoryEnabled.mockResolvedValue(false);

    expect(await makeService().recallForTurn('hello')).toBeNull();
    expect(client.search).not.toHaveBeenCalled();
  });

  it('swallows a recall failure so the turn still runs', async () => {
    client.search.mockRejectedValue(new Error('bedrock down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await makeService().recallForTurn('hello')).toBeNull();

    spy.mockRestore();
  });

  it('gives up and runs without memory when recall outlives its budget', async () => {
    // Never settles — the hang a plain try/catch cannot see.
    client.search.mockReturnValue(new Promise(() => {}));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await makeService(true, 10).recallForTurn('hello')).toBeNull();
    expect(spy.mock.calls[0][0]).toContain('exceeded 10ms');

    spy.mockRestore();
  });

  it('does not leave a late rejection unhandled after a timeout', async () => {
    let reject: (err: Error) => void = () => {};
    client.search.mockReturnValue(
      new Promise((_resolve, r) => {
        reject = r;
      }),
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);

    expect(await makeService(true, 10).recallForTurn('hello')).toBeNull();
    reject(new Error('bedrock gave up too'));
    await new Promise((r) => setTimeout(r, 20));

    expect(onUnhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', onUnhandled);
    spy.mockRestore();
  });

  it('builds the mem0 client once per service, not once per call', async () => {
    const service = makeService();
    await service.recallForTurn('a');
    await service.recallForTurn('b');

    expect(buildClient).toHaveBeenCalledTimes(1);
  });
});

describe('UserMemoryService preference', () => {
  it('is off when the deployment cannot run memory, whatever the user set', async () => {
    expect(await makeService(false).enabledForUser()).toBe(false);
    expect(userRepo.findCopilotMemoryEnabled).not.toHaveBeenCalled();
  });

  it('is off when the user turned it off, even though the deployment can run it', async () => {
    userRepo.findCopilotMemoryEnabled.mockResolvedValue(false);
    expect(await makeService().enabledForUser()).toBe(false);
  });

  it('reads the preference once per service, not once per check', async () => {
    const service = makeService();
    await service.enabledForUser();
    await service.enabledForUser();
    await service.preference();

    expect(userRepo.findCopilotMemoryEnabled).toHaveBeenCalledTimes(1);
    expect(userRepo.findCopilotMemoryEnabled).toHaveBeenCalledWith(USER);
  });

  it('reports the user’s own preference even when the deployment is off', async () => {
    userRepo.findCopilotMemoryEnabled.mockResolvedValue(true);
    expect(await makeService(false).preference()).toBe(true);
  });

  it('writes the preference and serves the stored value from then on', async () => {
    const service = makeService();
    expect(await service.setPreference(false)).toBe(false);

    expect(userRepo.setCopilotMemoryEnabled).toHaveBeenCalledWith(USER, false);
    // No second read: the write result replaces the memoized value.
    expect(await service.enabledForUser()).toBe(false);
    expect(userRepo.findCopilotMemoryEnabled).not.toHaveBeenCalled();
  });
});

describe('UserMemoryService.rememberTurn', () => {
  const turn = {
    userId: USER,
    chatId: 'chat-1',
    userText: 'Always answer me in Bahasa Indonesia.',
    assistantText: 'Understood — I will.',
  };

  it('stores nothing for the ordinary turn, and never reaches mem0', async () => {
    const written = await makeService().rememberTurn(turn);

    expect(written).toBe(0);
    expect(extractFacts).toHaveBeenCalledTimes(1);
    // The point of the gate: no embedding, no vector search, no mem0 call.
    expect(buildClient).not.toHaveBeenCalled();
    expect(client.add).not.toHaveBeenCalled();
  });

  it('hands mem0 only the extracted facts, never the conversation', async () => {
    extractFacts.mockResolvedValue(['Always answers in Bahasa Indonesia']);
    client.add.mockResolvedValue({
      results: [{ id: 'm1', memory: 'Always answers in Bahasa Indonesia' }],
    });

    const written = await makeService().rememberTurn(turn);

    expect(written).toBe(1);
    expect(client.add).toHaveBeenCalledWith(
      [{ role: 'user', content: 'Always answers in Bahasa Indonesia' }],
      { userId: USER, metadata: { source: 'copilot', chat_id: 'chat-1' } },
    );
    // The assistant's reply is not among what was stored.
    expect(JSON.stringify(client.add.mock.calls[0][0])).not.toContain('Understood');
  });

  it('passes the whole exchange to the gate, so a confirmation can be resolved', async () => {
    await makeService().rememberTurn({ ...turn, userText: 'yes', assistantText: 'Focus on coal?' });

    expect(extractFacts).toHaveBeenCalledWith(
      expect.objectContaining({ userText: 'yes', assistantText: 'Focus on coal?' }),
    );
  });

  it('does nothing when either side of the turn is empty', async () => {
    expect(await makeService().rememberTurn({ ...turn, userText: '  ' })).toBe(0);
    expect(await makeService().rememberTurn({ ...turn, assistantText: '' })).toBe(0);
    expect(extractFacts).not.toHaveBeenCalled();
  });

  it('records nothing when the user turned memory off', async () => {
    userRepo.findCopilotMemoryEnabled.mockResolvedValue(false);

    expect(await makeService().rememberTurn(turn)).toBe(0);
    expect(extractFacts).not.toHaveBeenCalled();
  });

  it('swallows an extraction failure so a finished turn is never reported as failed', async () => {
    extractFacts.mockRejectedValue(new Error('anthropic 529'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await makeService().rememberTurn(turn)).toBe(0);
    expect(client.add).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it('swallows a write failure too', async () => {
    extractFacts.mockResolvedValue(['Covers coal']);
    client.add.mockRejectedValue(new Error('anthropic 529'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await makeService().rememberTurn(turn)).toBe(0);

    spy.mockRestore();
  });

  it('refuses to write a turn for a different user than it is scoped to', async () => {
    await expect(
      makeService().rememberTurn({ ...turn, userId: 'someone-else' }),
    ).rejects.toThrow('different user');
  });

  it('deletes anything mem0 wrote that was not in the extracted set', async () => {
    // mem0's `add` still runs its own (maximalist) extraction over what we sent
    // it. `customInstructions` asks it to pass statements through; this asserts
    // we do not take its word for it.
    extractFacts.mockResolvedValue(['Covers Indonesian coal']);
    client.add.mockResolvedValue({
      results: [
        { id: 'm1', memory: 'Covers Indonesian coal' },
        { id: 'm2', memory: 'Acme is valued at $420m' },
      ],
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const written = await makeService().rememberTurn(turn);

    expect(written).toBe(1);
    expect(repo.deleteByIds).toHaveBeenCalledWith(USER, ['m2']);
    spy.mockRestore();
  });

  it('does not treat trivial reformatting as drift', async () => {
    extractFacts.mockResolvedValue(['Covers Indonesian coal']);
    client.add.mockResolvedValue({
      results: [{ id: 'm1', memory: '  covers indonesian coal.  ' }],
    });

    expect(await makeService().rememberTurn(turn)).toBe(1);
    expect(repo.deleteByIds).not.toHaveBeenCalled();
  });

  it('keeps a fact mem0 restated with a subject or in other words, since the original was never stored', async () => {
    extractFacts.mockResolvedValue(['Covers Indonesian coal and nickel', 'Prefers short answers']);
    client.add.mockResolvedValue({
      results: [
        { id: 'm1', memory: 'User covers Indonesian coal and nickel.' },
        { id: 'm2', memory: 'The user prefers short, concise answers' },
      ],
    });

    expect(await makeService().rememberTurn(turn)).toBe(2);
    expect(repo.deleteByIds).not.toHaveBeenCalled();
  });

  it('still removes content that is not in the extracted set, including a topic-adjacent restatement', async () => {
    extractFacts.mockResolvedValue(['Covers Indonesian coal and nickel']);
    client.add.mockResolvedValue({
      results: [
        { id: 'm1', memory: 'User covers Indonesian coal and nickel' },
        { id: 'm2', memory: 'User is bidding $420m for Acme' },
        { id: 'm3', memory: 'Primarily interested in Indonesian coal assets' },
      ],
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await makeService().rememberTurn(turn)).toBe(1);
    expect(repo.deleteByIds).toHaveBeenCalledWith(USER, ['m2', 'm3']);
    spy.mockRestore();
  });
});

describe('UserMemoryService.extractForReview', () => {
  const input = { userId: USER, text: 'Some notes about me.' };

  it('returns the agent’s proposals and stores nothing', async () => {
    runImport.mockResolvedValue({
      statements: ['Covers Indonesian coal'],
      summary: 'Found 1.',
    });

    const result = await makeService().extractForReview(input);

    expect(result).toEqual({ statements: ['Covers Indonesian coal'], summary: 'Found 1.' });
    // The whole point of the split: review happens before any write.
    expect(client.add).not.toHaveBeenCalled();
    expect(buildClient).not.toHaveBeenCalled();
  });

  it('passes the text and origin to the agent, without an owner', async () => {
    await makeService().extractForReview({ ...input, origin: 'ChatGPT export' });

    expect(runImport).toHaveBeenCalledWith(
      expect.objectContaining({ dump: 'Some notes about me.', origin: 'ChatGPT export' }),
    );
    // An extraction has no owner — nothing in the text can redirect a write.
    expect(runImport.mock.calls[0][0]).not.toHaveProperty('userId');
  });

  it('returns nothing without running the agent for empty text', async () => {
    const result = await makeService().extractForReview({ ...input, text: '   ' });

    expect(result).toEqual({ statements: [], summary: '' });
    expect(runImport).not.toHaveBeenCalled();
  });

  it('caps how many statements one import may propose', async () => {
    runImport.mockResolvedValue({
      statements: Array.from({ length: MAX_IMPORT_STATEMENTS + 20 }, (_, i) => `fact ${i}`),
      summary: '',
    });

    const result = await makeService().extractForReview(input);

    expect(result.statements).toHaveLength(MAX_IMPORT_STATEMENTS);
  });

  it('rejects a source too large to extract from', async () => {
    await expect(
      makeService().extractForReview({ ...input, text: 'x'.repeat(MAX_IMPORT_CHARS + 1) }),
    ).rejects.toBeInstanceOf(MemoryImportTooLargeError);
    expect(runImport).not.toHaveBeenCalled();
  });

  it('throws when the user has memory switched off', async () => {
    userRepo.findCopilotMemoryEnabled.mockResolvedValue(false);

    await expect(makeService().extractForReview(input)).rejects.toBeInstanceOf(
      MemoryUnavailableError,
    );
    expect(runImport).not.toHaveBeenCalled();
  });

  it('refuses to extract for a different user than it is scoped to', async () => {
    await expect(
      makeService().extractForReview({ ...input, userId: 'someone-else' }),
    ).rejects.toThrow('different user');
  });
});

describe('UserMemoryService.saveReviewed', () => {
  it('writes the statements through mem0, stamped as an import', async () => {
    // mem0 kept one and de-duplicated the other against what was already known.
    client.add.mockResolvedValue({ results: [{ id: 'm1', memory: 'Focuses on coal' }] });

    const result = await makeService().saveReviewed({
      userId: USER,
      statements: ['Focuses on coal', '  ', 'Based in Jakarta'],
      origin: 'ChatGPT export',
    });

    expect(client.add).toHaveBeenCalledTimes(1);
    expect(client.add).toHaveBeenCalledWith(
      [
        { role: 'user', content: 'Focuses on coal' },
        { role: 'user', content: 'Based in Jakarta' },
      ],
      { userId: USER, metadata: { source: 'import', origin: 'ChatGPT export' } },
    );
    expect(result).toEqual({ submitted: 2, added: 1, skipped: 1 });
  });

  it('deletes anything mem0 wrote that the user did not approve', async () => {
    // The user read these statements and approved them. mem0's `add` still runs
    // its own extraction over what we send, so "review before saving" is only
    // true if we check what it actually wrote.
    client.add.mockResolvedValue({
      results: [
        { id: 'm1', memory: 'Focuses on coal' },
        { id: 'm2', memory: 'Is bidding $420m for Acme' },
      ],
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await makeService().saveReviewed({
      userId: USER,
      statements: ['Focuses on coal'],
    });

    expect(repo.deleteByIds).toHaveBeenCalledWith(USER, ['m2']);
    expect(result.added).toBe(1);
    spy.mockRestore();
  });

  it('truncates a statement the user retyped past the cap', async () => {
    // The agent's schema caps proposals, but the review step lets the user
    // replace one — so the ceiling is enforced on the write too.
    client.add.mockResolvedValue({ results: [] });

    await makeService().saveReviewed({ userId: USER, statements: ['x'.repeat(900)] });

    const sent = client.add.mock.calls[0][0][0].content;
    expect(sent.length).toBeLessThanOrEqual(MAX_IMPORT_STATEMENT_CHARS + 1);
    expect(sent.endsWith('…')).toBe(true);
  });

  it('batches a long import into sequential calls rather than one huge prompt', async () => {
    client.add.mockResolvedValue({ results: [] });

    await makeService().saveReviewed({
      userId: USER,
      statements: Array.from({ length: 60 }, (_, i) => `fact ${i}`),
    });

    // 25 per batch → 25 / 25 / 10.
    expect(client.add).toHaveBeenCalledTimes(3);
    expect(client.add.mock.calls[0][0]).toHaveLength(25);
    expect(client.add.mock.calls[2][0]).toHaveLength(10);
  });

  it('caps how many statements one import may write', async () => {
    client.add.mockResolvedValue({ results: [] });

    const result = await makeService().saveReviewed({
      userId: USER,
      statements: Array.from({ length: MAX_IMPORT_STATEMENTS + 50 }, (_, i) => `fact ${i}`),
    });

    expect(result.submitted).toBe(MAX_IMPORT_STATEMENTS);
  });

  it('returns an empty result without calling mem0 when nothing survived cleaning', async () => {
    const result = await makeService().saveReviewed({
      userId: USER,
      statements: ['', '   '],
    });

    expect(result).toEqual({ submitted: 0, added: 0, skipped: 0 });
    expect(client.add).not.toHaveBeenCalled();
  });

  it('throws — not swallows — when memory is unavailable, because a user is watching', async () => {
    await expect(
      makeService(false).saveReviewed({ userId: USER, statements: ['a'] }),
    ).rejects.toBeInstanceOf(MemoryUnavailableError);
  });

  it('refuses to import for a user who turned memory off', async () => {
    userRepo.findCopilotMemoryEnabled.mockResolvedValue(false);

    await expect(
      makeService().saveReviewed({ userId: USER, statements: ['a'] }),
    ).rejects.toBeInstanceOf(MemoryUnavailableError);
    expect(client.add).not.toHaveBeenCalled();
  });

  it('lets a mem0 failure surface to the caller', async () => {
    client.add.mockRejectedValue(new Error('anthropic 529'));

    await expect(
      makeService().saveReviewed({ userId: USER, statements: ['a'] }),
    ).rejects.toThrow('anthropic 529');
  });
});

describe('UserMemoryService.list', () => {
  it('reads the listing from the repository, not through mem0', async () => {
    repo.list.mockResolvedValue([
      {
        id: 'm1',
        memory: 'column text',
        collection: 'memories',
        payload: { data: 'payload text', source: 'import', origin: 'IC_notes.pdf' },
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-02T00:00:00Z',
      },
    ]);
    repo.count.mockResolvedValue(7);

    const result = await makeService().list();

    expect(buildClient).not.toHaveBeenCalled();
    expect(result.total).toBe(7);
    expect(result.hasMore).toBe(true);
    expect(result.items).toEqual([
      {
        id: 'm1',
        memory: 'payload text',
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z',
        source: 'import',
        origin: 'IC_notes.pdf',
      },
    ]);
  });

  it('treats anything that is not an import as a copilot memory', async () => {
    repo.list.mockResolvedValue([
      {
        id: 'm1',
        memory: 'a',
        collection: 'memories',
        payload: {},
        created_at: 'now',
        updated_at: 'now',
      },
    ]);

    const item = (await makeService().list()).items[0];
    expect(item.source).toBe('copilot');
    // A conversation memory has no filename worth showing.
    expect(item.origin).toBeNull();
  });

  it('clamps the page size', async () => {
    await makeService().list(10_000);
    expect(repo.list.mock.calls[0][2]).toBe(200);
  });

  it('pages with an offset so older memories stay reachable', async () => {
    repo.list.mockResolvedValue([
      { id: 'm3', memory: 'c', collection: 'memories', payload: {}, created_at: 'now', updated_at: 'now' },
    ]);
    repo.count.mockResolvedValue(3);

    const result = await makeService().list(2, 2);

    expect(repo.list).toHaveBeenCalledWith(USER, 'memories', 2, {}, 2);
    expect(result.hasMore).toBe(false);
  });

  it('never reports a negative offset to the repository', async () => {
    await makeService().list(10, -5);
    expect(repo.list.mock.calls[0][4]).toBe(0);
  });
});

describe('UserMemoryService.forget', () => {
  it('reports false when the memory was not this user’s', async () => {
    repo.deleteByIds.mockResolvedValue(0);
    expect(await makeService().forget('m1')).toBe(false);
    expect(repo.deleteByIds).toHaveBeenCalledWith(USER, ['m1']);
  });

  it('reports true when a row was removed', async () => {
    repo.deleteByIds.mockResolvedValue(1);
    expect(await makeService().forget('m1')).toBe(true);
  });
});

describe('UserMemoryService.forgetAll', () => {
  it('clears memories even when the user has memory switched off', async () => {
    userRepo.findCopilotMemoryEnabled.mockResolvedValue(false);
    repo.deleteAll.mockResolvedValue(2);

    expect(await makeService().forgetAll()).toBe(2);
  });

  it('clears the entity index alongside the memories so no link dangles', async () => {
    repo.deleteAll.mockResolvedValueOnce(4).mockResolvedValueOnce(9);

    expect(await makeService().forgetAll()).toBe(4);
    expect(repo.deleteAll).toHaveBeenCalledWith(USER, 'memories');
    expect(repo.deleteAll).toHaveBeenCalledWith(USER, 'memories_entities');
  });
});
