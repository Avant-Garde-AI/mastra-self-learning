/**
 * Observational Memory Composition Example
 *
 * Demonstrates how the self-learning processors compose alongside
 * Mastra's built-in Observational Memory (OM). The two systems
 * handle complementary concerns:
 *
 * - OM: compresses old messages into dense observations (per-thread)
 * - Self-learning: extracts reusable skills + persists facts (cross-thread)
 *
 * The system prompt stack becomes:
 *   Identity (ours) → Facts (ours) → Skill Index (ours) → Observations (OM) → Messages (Mastra)
 */

import { Agent } from '@mastra/core';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import {
  createSelfLearningTools,
  createSelfLearningProcessor,
  createSkillContextProcessor,
} from '@avant-garde/mastra-self-learning';

// --- Storage ---
const storage = new PostgresStore({
  connectionString: process.env.DATABASE_URL!,
});

// --- Observational Memory ---
// Mastra's OM uses background Observer/Reflector agents to compress
// old messages into dense observations. This runs independently of
// the self-learning system.
const memory = new Memory({
  storage,
  options: {
    // Enable observational memory
    observational: {
      enabled: true,
      // Observer compresses messages into observations
      observer: {
        model: 'anthropic/claude-haiku-3-5-20241022',
        triggerThreshold: 10, // Observe after 10 messages
      },
      // Reflector synthesizes observations into higher-level summaries
      reflector: {
        model: 'anthropic/claude-haiku-3-5-20241022',
        triggerThreshold: 5, // Reflect after 5 observations
      },
    },
  },
});

// --- Agent with OM + Self-Learning ---
const agent = new Agent({
  name: 'full-memory-agent',
  model: 'anthropic/claude-sonnet-4-20250514',
  memory, // Mastra's memory handles OM + message persistence
  instructions: `You are a helpful assistant with both observational memory
and a self-learning skill system. You remember conversation context
through observations AND have access to reusable procedural skills
learned from past tasks.`,
  tools: {
    ...createSelfLearningTools({ storage, agentId: 'full-memory-agent' }),
  },

  // Self-learning input processor prepends identity, facts, and skill index
  // BEFORE OM's observations in the system prompt
  inputProcessors: [
    createSkillContextProcessor({
      storage,
      identity: {
        personality: 'You are a knowledgeable, patient technical assistant.',
        expertise: ['full-stack', 'devops', 'data-engineering'],
      },
      factLayer: { enabled: true },
      skillRouter: { indexBudget: 3000, activeBudget: 8000 },
    }),
  ],

  // Self-learning output processor observes the agent loop
  // and triggers skill extraction on complex task completions
  outputProcessors: [
    createSelfLearningProcessor({
      storage,
      extraction: {
        minToolCalls: 5,
        requireApproval: false,
      },
    }),
  ],
});

// --- Usage ---
async function main() {
  const threadId = 'thread-with-om-and-learning';

  // First conversation — OM starts observing, self-learning starts tracking
  const result1 = await agent.generate({
    messages: [
      { role: 'user', content: 'Help me set up a new GCP project with Terraform' },
    ],
    threadId,
  });
  console.log('Response 1:', result1.text);

  // Later in the same thread — OM has compressed earlier messages,
  // self-learning may have extracted a skill
  const result2 = await agent.generate({
    messages: [
      { role: 'user', content: 'Now deploy a Cloud Run service in that project' },
    ],
    threadId,
  });
  console.log('Response 2:', result2.text);

  // In a NEW thread — OM starts fresh, but self-learning carries over:
  // - Facts persisted from the first thread are still available
  // - Skills extracted from the first thread appear in the skill index
  const result3 = await agent.generate({
    messages: [
      { role: 'user', content: 'Deploy another Cloud Run service in a different project' },
    ],
    threadId: 'thread-2-new-context',
  });
  console.log('Response 3 (new thread, same skills):', result3.text);
}

main().catch(console.error);
