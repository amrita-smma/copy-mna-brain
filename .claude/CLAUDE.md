## Overview

Use Typescript Strict mode.
When processing asynchronous tasks, put them in the jobs table and store state changes in job_logs.
Update the README.md when an architecture change happens.
Unit tests should be added for every change to the backend side of the project, which is in src/lib

## Agent Design Pattern (`src/lib/agents`)

Each agent lives in its own folder under `src/lib/agents`, named after the agent. The folder structure must be:

```
src/lib/agents/<agent_name>/
  index.ts                      # Main agent entrypoint — must use `createAgent` and stream
  tools/
    index.ts                    # Registers all tools for the agent
    <tool_name>.ts              # One file per tool (one tool per file)
    <tool_name>.test.ts         # Unit tests for the tool
```

Rules:
- Each agent's `index.ts` is the main entrypoint and must use `createAgent`.
- Each agent must be streaming.
- Each tool gets its own dedicated file under `tools/`.
- `tools/index.ts` is responsible for registering all tools.
- Every tool must have unit tests.
