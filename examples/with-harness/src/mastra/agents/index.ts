/**
 * Harness Example — Tier 3 (Full Harness Integration)
 *
 * Demonstrates the complete self-learning stack:
 * - Input processor: injects identity, facts, and skill index
 * - Output processor: observes task execution, triggers extraction
 * - Tools: skill CRUD + memory persistence
 * - Harness: learn mode for explicit skill review sessions
 * - Gardening: scheduled workflows for skill maintenance
 */

import { Agent, Mastra, Harness } from '@mastra/core';
import { PostgresStore } from '@mastra/pg';
import {
  createSelfLearningTools,
  createSelfLearningProcessor,
  createSkillContextProcessor,
  createSelfLearningMode,
  createGardeningWorkflows,
} from '@avant-garde/mastra-self-learning';

// --- Storage ---
const storage = new PostgresStore({
  connectionString: process.env.DATABASE_URL!,
});

// --- Agent with full processor stack ---
const agent = new Agent({
  name: 'ops-agent',
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: `You are a senior DevOps engineer specializing in GCP infrastructure.
Before starting any task, check your skill library for relevant procedures.
After completing complex tasks, the system will automatically extract reusable skills.`,
  tools: {
    ...createSelfLearningTools({ storage, agentId: 'ops-agent' }),
  },
  inputProcessors: [
    createSkillContextProcessor({
      storage,
      identity: {
        personality: `You are a senior DevOps engineer. You communicate in a direct,
technical style. You always verify before executing destructive operations.
You prefer Terraform over ClickOps and value infrastructure-as-code.`,
        expertise: ['gcp', 'kubernetes', 'terraform', 'ci-cd', 'monitoring'],
        formatting: {
          defaultLength: 'concise',
          codeStyle: 'documented',
          listPreference: 'bullets',
        },
        guardrails: [
          'Never delete production resources without explicit user confirmation',
          'Always suggest a dry-run before applying infrastructure changes',
          'Escalate billing-impacting changes > $100/month to the user',
        ],
      },
      factLayer: { enabled: true, nudgeInterval: 10 },
      skillRouter: {
        indexBudget: 3000,
        activeBudget: 8000,
        overflowStrategy: 'relevant',
      },
    }),
  ],
  outputProcessors: [
    createSelfLearningProcessor({
      storage,
      auxiliaryModel: 'anthropic/claude-sonnet-4-20250514',
      extraction: {
        minToolCalls: 5,
        minTurns: 3,
        requirePositiveOutcome: true,
        cooldownMs: 300_000,
        deduplicationThreshold: 0.85,
        requireApproval: false,
        useGeneralizabilityCheck: true,
      },
    }),
  ],
});

// --- Harness with chat + learn modes ---
const harness = new Harness({
  modes: {
    chat: {
      agent,
      defaultModel: 'anthropic/claude-sonnet-4-20250514',
    },
    learn: createSelfLearningMode({
      agent,
      storage,
      defaultModel: 'anthropic/claude-sonnet-4-20250514',
    }),
  },
  tools: {
    ...createSelfLearningTools({ storage, agentId: 'ops-agent' }),
  },
});

// --- Mastra instance with gardening workflows ---
const mastra = new Mastra({
  agents: { 'ops-agent': agent },
  workflows: {
    ...createGardeningWorkflows({
      storage,
      auxiliaryModel: 'anthropic/claude-sonnet-4-20250514',
    }),
  },
});

// --- Usage ---
async function main() {
  // Normal chat — skills are injected and extraction runs passively
  console.log('=== Chat Mode ===');
  const chatResult = await harness.sendMessage({
    content: 'Deploy my service to Cloud Run with canary traffic splitting',
  });
  console.log(chatResult);

  // Switch to learn mode for explicit skill review
  console.log('\n=== Learn Mode ===');
  await harness.switchMode({ modeId: 'learn' });
  const learnResult = await harness.sendMessage({
    content: 'Review my recent deployments and create any missing skills',
  });
  console.log(learnResult);

  // Switch back to chat
  await harness.switchMode({ modeId: 'chat' });
}

main().catch(console.error);
