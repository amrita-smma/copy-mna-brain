import { test, expect, Page } from '@playwright/test';
import { mockAuthSession } from './helpers/auth';

/** Stub the streaming /api/chat endpoint so sending a message doesn't hit a real LLM. */
const mockChatEndpoint = (page: Page) =>
  page.route('**/api/chat', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      // Minimal no-op stream – useChat just needs the request to complete.
      body: '',
    });
  });

// /ai-discovery now redirects to /dashboard, where the AI CoPilot lives as an
// embedded side pane (AICopilotPane) rather than a standalone page.
test.describe('AI Discovery', () => {
  test('Unauthenticated user is redirected to login', async ({ page }) => {
    await mockAuthSession(page, null);

    await page.goto('/ai-discovery');
    await page.waitForURL('**/login');
    await expect(page).toHaveURL(/\/login/);
  });

  test('Authenticated user lands on the dashboard with the AI CoPilot pane', async ({ page }) => {
    await mockAuthSession(page);
    await mockChatEndpoint(page);

    await page.goto('/ai-discovery');

    // The route redirects to the dashboard.
    await page.waitForURL('**/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);

    // The CoPilot pane: "AI CoPilot" label, the welcome heading, and the input.
    await expect(page.getByText('AI CoPilot')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /M&A discovery assistant/i, level: 1 }),
    ).toBeVisible();
    await expect(page.getByPlaceholder('Ask anything...')).toBeVisible();
  });

  test('Send button reflects input state', async ({ page }) => {
    await mockAuthSession(page);
    await mockChatEndpoint(page);
    await page.goto('/ai-discovery');
    await page.waitForURL('**/dashboard');

    const input = page.getByPlaceholder('Ask anything...');
    const sendBtn = input.locator('..').locator('button[type="submit"]');

    await expect(sendBtn).toBeDisabled();
    await input.fill('what companies are in L1?');
    await expect(sendBtn).toBeEnabled();
  });

  test('User sends a chat message', async ({ page }) => {
    await mockAuthSession(page);
    await mockChatEndpoint(page);
    await page.goto('/ai-discovery');
    await page.waitForURL('**/dashboard');

    const input = page.getByPlaceholder('Ask anything...');
    await input.fill('hello');

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/chat')),
      input.press('Enter'),
    ]);

    expect(req.method()).toBe('POST');
  });
});
