'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { CopilotAgentType } from '@/lib/agents/analysis';

const CopilotAgentContext = createContext<CopilotAgentType>('mna');

export function CopilotAgentProvider({
  agentType,
  children,
}: {
  agentType: CopilotAgentType;
  children: ReactNode;
}) {
  return (
    <CopilotAgentContext.Provider value={agentType}>{children}</CopilotAgentContext.Provider>
  );
}

export function useCopilotAgent(): CopilotAgentType {
  return useContext(CopilotAgentContext);
}
