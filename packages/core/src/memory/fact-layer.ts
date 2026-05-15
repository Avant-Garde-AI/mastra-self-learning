import type { FactLayerConfig } from '../config.js';

export interface FactEntry {
  id: string;
  category: 'preference' | 'context' | 'project' | 'credential' | 'constraint' | 'relationship';
  content: string;
  /** Confidence score (0-1), decays over time if not reinforced */
  confidence: number;
  sourceThreadId: string;
  createdAt: string;
  lastReinforced: string;
  /** Optional TTL in seconds */
  ttl?: number | null;
}

/**
 * Cross-thread fact persistence layer.
 *
 * Composes alongside Observational Memory rather than replacing it:
 * - OM handles conversation compression (within a thread)
 * - FactLayer handles persistent facts (across threads)
 *
 * Facts are categorized and decay over time unless reinforced.
 * A "nudge" mechanism periodically prompts the agent to review
 * whether new facts should be persisted.
 *
 * @see docs/05-memory-layers.md
 */
export class FactLayer {
  constructor(
    private storage: unknown, // MastraStorage
    private config: FactLayerConfig,
  ) {}

  async persistFact(fact: Omit<FactEntry, 'id' | 'createdAt' | 'lastReinforced'>): Promise<FactEntry> {
    throw new Error('Not implemented — Phase 3');
  }

  async getRelevantFacts(context: string, limit?: number): Promise<FactEntry[]> {
    throw new Error('Not implemented — Phase 3');
  }

  async reinforceFact(id: string): Promise<void> {
    throw new Error('Not implemented — Phase 3');
  }

  async applyDecay(): Promise<number> {
    throw new Error('Not implemented — Phase 3');
  }

  /**
   * Build the facts block for system prompt injection.
   */
  async buildFactsBlock(agentId?: string): Promise<string> {
    throw new Error('Not implemented — Phase 3');
  }
}
