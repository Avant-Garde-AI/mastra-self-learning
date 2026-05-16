import type { Identity, IdentityLayerConfig } from '../config.js';

/**
 * Identity layer that prevents tone drift over long agent usage.
 *
 * MVP scope: static identity rendering only. The identity passed at
 * construction time is what gets rendered, every request. Drift detection and
 * calibration storage are deferred (they throw with a Phase-6 marker).
 *
 * @see docs/mvp/04-phase-context-injection.md
 */
export class IdentityLayer {
  constructor(
    private storage: unknown,
    private config: IdentityLayerConfig,
    private seedIdentity: Identity,
  ) {}

  /**
   * The current identity. In the MVP this is always the seed — calibration
   * storage lands in Phase 6.
   */
  async getCurrentIdentity(_agentId?: string): Promise<Identity> {
    return this.seedIdentity;
  }

  async updateCalibration(_agentId: string, _updates: Partial<Identity>): Promise<void> {
    throw new Error(
      'IdentityLayer.updateCalibration is a Phase 6 feature (identity calibration storage).',
    );
  }

  async measureDrift(_agentId: string): Promise<number> {
    throw new Error(
      'IdentityLayer.measureDrift is a Phase 6 feature (drift detection / embeddings).',
    );
  }

  /**
   * Build the Identity block for system-prompt injection. Returns an empty
   * string if the identity has no meaningful content so the caller can omit
   * the section (and its separator) cleanly.
   */
  buildIdentityBlock(identity: Identity = this.seedIdentity): string {
    const parts: string[] = [];

    const personality = identity.personality?.trim();
    if (personality) {
      parts.push(`## Identity\n\n${personality}`);
    }

    if (identity.expertise && identity.expertise.length > 0) {
      parts.push(`**Expertise:** ${identity.expertise.join(', ')}`);
    }

    if (identity.formatting) {
      const f = identity.formatting;
      const bits: string[] = [];
      if (f.defaultLength) bits.push(`${f.defaultLength} responses`);
      if (f.codeStyle) bits.push(`${f.codeStyle} code`);
      if (f.listPreference) bits.push(`${f.listPreference} lists`);
      if (bits.length > 0) parts.push(`**Formatting:** ${bits.join(', ')}`);
    }

    if (identity.guardrails && identity.guardrails.length > 0) {
      parts.push(
        `**Guardrails:**\n${identity.guardrails.map((g) => `- ${g}`).join('\n')}`,
      );
    }

    // If only the header would render (no personality and nothing else),
    // return empty so the section is skipped entirely.
    if (parts.length === 0) return '';
    return parts.join('\n\n');
  }
}
