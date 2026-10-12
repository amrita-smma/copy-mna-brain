import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractFundUpdateProposal } from './llmExtractor';
import { ChatAnthropic } from '@langchain/anthropic';

// Mock Langfuse to prevent telemetry during tests
vi.mock('@/lib/langfuse', () => ({
  // The real helper's tracing-off behaviour: hand the config straight back.
  withLangfuseCallbacks: vi.fn((config: unknown) => config ?? {}),
}));

// Mock createAgent from langchain since the test environment crashes inside langgraph
vi.mock('langchain', () => ({
  createAgent: vi.fn(() => ({
    stream: vi.fn(async function* () {
      yield { messages: [{ content: (global as any)._mockLlmContent || '' }] };
    }),
  })),
}));

// Mock Anthropic SDK directly to avoid actual API calls
vi.mock('@anthropic-ai/sdk', async () => {
  const actual = await vi.importActual<any>('@anthropic-ai/sdk');
  return {
    ...actual,
    toFile: vi.fn().mockReturnValue({}),
    default: class MockAnthropic {
      beta = {
        messages: {
          create: vi.fn(),
        },
        files: {
          upload: vi.fn().mockResolvedValue({ id: 'test_file_id' }),
        }
      };
    },
  };
});

describe('llmExtractor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test_key';
  });

  it('gracefully handles missing LLM output (parse error)', async () => {
    (global as any)._mockLlmContent = 'I could not find any assets in this document.';

    const result = await extractFundUpdateProposal('some text', Buffer.from(''), 'text/plain', 'file.txt');
    expect(result).toBeNull();
  });

  it('correctly parses and normalizes well-formed LLM JSON', async () => {
    const mockJson = JSON.stringify({
      assets: [
        {
          name: 'Tech Startup Inc.',
          entity: 'Fund I',
          stakePct: '12.5', // Should be coerced to 12.5
          valuations: [
            {
              asOfDate: '2023-12-31',
              marketValue: '1,500,000', // Should be coerced to 1500000
              valuationMethod: 'invalid_method_should_be_other',
            },
            {
              asOfDate: 'invalid-date', // Should be stripped
              marketValue: 100,
            }
          ],
          txns: [
            {
              date: '2023-06-15',
              type: 'contribution',
              valueAmount: 500000,
            }
          ]
        }
      ]
    });

    (global as any)._mockLlmContent = `Here is the data:\n\`\`\`json\n${mockJson}\n\`\`\``;

    const result = await extractFundUpdateProposal('some text', Buffer.from(''), 'text/plain', 'file.txt');
    expect(result).not.toBeNull();
    expect(result?.assets).toHaveLength(1);

    const asset = result!.assets[0];
    expect(asset.name).toBe('Tech Startup Inc.');
    expect(asset.code).toBe('techstartupinc'); // Generated code from name
    expect(asset.stakePct).toBe(12.5); // Number coercion

    expect(asset.valuations).toHaveLength(1); // The invalid date was filtered out
    expect(asset.valuations[0].marketValue).toBe(1500000); // Comma stripped
    expect(asset.valuations[0].valuationMethod).toBe('other'); // Invalid enum coerced to 'other'
    expect(asset.valuations[0].periodLabel).toBe('Q4 2023');
    expect(asset.fund).toBe('Fund I');
    
    expect(asset.txns).toHaveLength(1);
    expect(asset.txns[0].valueAmount).toBe(500000);
  });
});
