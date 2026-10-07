# Sector agents (`@minerba`, `@dikti`, `@bangun`)

Specialist agents, one per sector, alongside the general Copilot:

| Agent | Sector |
| --- | --- |
| `@minerba` | Mining and minerals |
| `@dikti` | Education |
| `@bangun` | Construction and property development |

- **Bind an insight to an agent.** An insight can be assigned to a sector
  agent. Chatting from that insight, and its scheduled refreshes, then use that
  agent. Its version history shows which agent wrote each version.
- **Context.** When you chat from an open insight, the agent already knows the
  insight's contents.
- **Retired agents.** A retired agent can't be chosen for new insights. Refresh
  schedules on it pause until the insight is moved to another agent.
- **Code.** Agents are defined in code: `src/lib/agents/sector/registry.ts` lists
  them, and each has a folder under `src/lib/agents/<key>/`.
