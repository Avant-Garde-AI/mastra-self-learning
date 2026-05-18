import { Agent } from '@mastra/core/agent';
import type {
  InputProcessorOrWorkflow,
  OutputProcessorOrWorkflow,
} from '@mastra/core/processors';
import {
  createSelfLearningTools,
  createSelfLearningProcessor,
  createSkillContextProcessor,
  IdentitySchema,
} from '@avant-garde/mastra-self-learning';

// The core package types its processors *structurally* (no hard `@mastra/core`
// type import — see packages/core/MASTRA_API_NOTES.md "structural typing"
// decision) to avoid Mastra-version coupling. The runtime shapes are correct
// and proven by 176 core tests; these casts bridge the structural types to
// Mastra's concrete `Processor` unions at the single integration seam.
const asInput = (p: unknown) => p as unknown as InputProcessorOrWorkflow;
const asOutput = (p: unknown) => p as unknown as OutputProcessorOrWorkflow;
import { skillStorage, AGENT_ID, embedder } from './storage.js';
import { chatModel, auxGenerate, hasLLM } from './aux.js';
import { recordEvent } from './events.js';

const IDENTITY = IdentitySchema.parse({
  personality:
    'You are a pragmatic DevOps automation expert. You prefer reproducible, ' +
    'verifiable procedures and you always confirm before destructive actions.',
  expertise: ['gcp', 'cloud-run', 'kubernetes', 'terraform', 'ci-cd'],
  formatting: {
    defaultLength: 'concise',
    codeStyle: 'documented',
    listPreference: 'bullets',
  },
  guardrails: [
    'Never delete production resources without explicit confirmation.',
    'Always suggest a dry-run before applying infrastructure changes.',
  ],
});

/**
 * The self-learning-wired chat agent. Only constructed when an LLM key is
 * present — without it, `harnessAgent` is undefined and the chat route is
 * disabled while the admin/observability surface keeps working.
 */
export const harnessAgent: Agent | undefined = hasLLM
  ? new Agent({
      id: AGENT_ID,
      name: AGENT_ID,
      instructions:
        'You are a helpful DevOps assistant. When you complete a non-trivial, ' +
        'multi-step task, your work is automatically distilled into a reusable ' +
        'skill. Before reasoning from scratch, call skill_list / skill_search to ' +
        'see if a learned procedure already exists, and skill_view to follow it. ' +
        'After using a skill, call skill_feedback with the outcome.',
      model: chatModel!,
      tools: {
        ...createSelfLearningTools({ storage: skillStorage, agentId: AGENT_ID, embed: embedder }),
      },
      inputProcessors: [
        asInput(
          createSkillContextProcessor({
            storage: skillStorage,
            agentId: AGENT_ID,
            identity: IDENTITY,
            factLayer: { enabled: true, nudgeInterval: 6 },
            embed: embedder,
            skillRouter: { overflowStrategy: 'relevant' },
          }),
        ),
      ],
      outputProcessors: [
        asOutput(
          createSelfLearningProcessor({
            storage: skillStorage,
            agentId: AGENT_ID,
            generate: auxGenerate,
            embed: embedder,
            extraction: { minToolCalls: 4, minTurns: 2, cooldownMs: 15_000 },
            refinementCooldownMs: 10_000,
            onEvent: recordEvent,
          }),
        ),
      ],
    })
  : undefined;
