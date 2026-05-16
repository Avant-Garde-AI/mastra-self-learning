import { Mastra } from '@mastra/core';
import { MastraAgent } from '@ag-ui/mastra';
import { registerCopilotKit } from '@ag-ui/mastra/copilotkit';
import { harnessAgent } from './agent.js';
import { AGENT_ID } from './storage.js';
import { adminRoutes } from '../routes/admin.js';

const CORS = {
  // Dev harness: accept any localhost origin. Vite hops ports (5173→5174…)
  // when one is taken, so pinning a single origin is fragile here. An explicit
  // HARNESS_WEB_ORIGIN still wins if set.
  origin: (origin: string) => {
    const pinned = process.env.HARNESS_WEB_ORIGIN;
    if (pinned) return origin === pinned ? origin : '';
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ? origin
      : '';
  },
  credentials: true,
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
};

// CopilotKit chat route — only when an LLM-backed agent exists.
const copilotRoutes = harnessAgent
  ? [
      registerCopilotKit({
        path: '/copilotkit',
        resourceId: 'harness',
        agents: {
          [AGENT_ID]: new MastraAgent({
            agentId: AGENT_ID,
            agent: harnessAgent,
            resourceId: 'harness',
          }),
        },
      }),
    ]
  : [];

export const mastra = new Mastra({
  agents: harnessAgent ? { [AGENT_ID]: harnessAgent } : {},
  server: {
    port: Number(process.env.PORT ?? 4111),
    host: '0.0.0.0',
    cors: CORS,
    apiRoutes: [...adminRoutes, ...copilotRoutes],
  },
});
