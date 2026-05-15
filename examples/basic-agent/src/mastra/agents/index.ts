/**
 * Basic Agent Example — Tier 1 (Tools Only)
 *
 * The simplest integration: add skill tools to an existing Mastra agent.
 * The agent can list, search, view, and manually create skills,
 * but there's no automatic extraction.
 */

import { Agent } from '@mastra/core';
import { PostgresStore } from '@mastra/pg';
import { createSelfLearningTools } from '@avant-garde/mastra-self-learning';

// --- Storage ---
const storage = new PostgresStore({
  connectionString: process.env.DATABASE_URL!,
});

// --- Agent with skill tools ---
export const agent = new Agent({
  name: 'basic-agent',
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: `You are a helpful assistant with access to a skill library.

Before starting a complex task, check if a relevant skill exists using skill_list or skill_search.
If a skill exists, load it with skill_view and follow its procedure.
After completing a task successfully, consider creating a skill with skill_create
so you can reuse the procedure next time.`,
  tools: {
    ...createSelfLearningTools({ storage }),
  },
});

// --- Usage ---
async function main() {
  const result = await agent.generate({
    messages: [
      { role: 'user', content: 'Deploy my service to Cloud Run with canary traffic splitting' },
    ],
  });

  console.log(result.text);
}

main().catch(console.error);
