import { NextRequest, NextResponse } from 'next/server';
import { getAgentGraph, AIMessage } from '@/lib/agents/analysis';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { BaseMessage } from '@langchain/core/messages';
import { toUIMessageStream, toBaseMessages } from '@ai-sdk/langchain';
import { createUIMessageStreamResponse, UIMessage } from 'ai';

const convertLangChainMessageToVercelMessage = (message: BaseMessage) => {
  if (message._getType() === 'human') {
    return { content: message.content, role: 'user' };
  } else if (message._getType() === 'ai') {
    return {
      content: message.content,
      role: 'assistant',
      tool_calls: (message as AIMessage).tool_calls,
    };
  } else {
    return { content: message.content, role: message._getType() };
  }
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const returnIntermediateSteps = body.show_intermediate_steps;

    const db = createDb();
    const { chatService } = createContainer(db);
    const contextData = await chatService.buildContext();

    console.log(JSON.stringify(body.messages));

    const filteredMessages = (body.messages ?? []).filter(
      (message: { role: string }) =>
        message.role === 'user' || message.role === 'assistant',
    );

    const rawMessages: UIMessage[] = filteredMessages.map((msg: { role: string; parts?: { type: string }[]; content?: unknown }) => {
      if (msg.parts && Array.isArray(msg.parts)) {
        const textParts = msg.parts.filter((part: { type: string }) => part.type === 'text');
        return { ...msg, parts: textParts };
      }
      return {
        ...msg,
        parts: msg.content
          ? [
              {
                type: 'text',
                text:
                  typeof msg.content === 'string'
                    ? msg.content
                    : JSON.stringify(msg.content),
              },
            ]
          : [],
      };
    });

    const messages: BaseMessage[] = await toBaseMessages(rawMessages);

    const agent = getAgentGraph();
    if (!agent) {
      return NextResponse.json(
        { error: 'Agent not available. Please ensure ANTHROPIC_API_KEY is set.' },
        { status: 500 },
      );
    }

    if (!returnIntermediateSteps) {
      const eventStream = await agent.streamEvents(
        { messages, additionalSystemContext: contextData || undefined },
        { version: 'v2', recursionLimit: 50 },
      );

      return createUIMessageStreamResponse({
        stream: toUIMessageStream(eventStream),
      });
    } else {
      const result = await agent.invoke(
        { messages, additionalSystemContext: contextData || undefined },
        { recursionLimit: 50 },
      );

      const validMessages = result.messages.map((m: BaseMessage | string) => {
        if (typeof m === 'string') {
          return new AIMessage(m);
        }
        return m as BaseMessage;
      });

      return NextResponse.json(
        { messages: validMessages.map(convertLangChainMessageToVercelMessage) },
        { status: 200 },
      );
    }
  } catch (e: unknown) {
    const err = e as { message?: string; status?: number };
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
