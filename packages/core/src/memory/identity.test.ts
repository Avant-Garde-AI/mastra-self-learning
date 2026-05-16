import { describe, expect, it } from 'vitest';
import { IdentityLayer } from './identity.js';
import { IdentityLayerConfigSchema, IdentitySchema } from '../config.js';

const cfg = IdentityLayerConfigSchema.parse({});

function layer(identity = IdentitySchema.parse({ personality: 'You are a DevOps expert.' })) {
  return new IdentityLayer({}, cfg, identity);
}

describe('IdentityLayer.buildIdentityBlock', () => {
  it('renders a full identity with all sections', () => {
    const identity = IdentitySchema.parse({
      personality: 'You are a senior DevOps engineer.',
      expertise: ['gcp', 'kubernetes'],
      formatting: { defaultLength: 'concise', codeStyle: 'documented', listPreference: 'bullets' },
      guardrails: ['Never delete prod without confirmation'],
    });
    const block = layer(identity).buildIdentityBlock();
    expect(block).toContain('## Identity');
    expect(block).toContain('senior DevOps engineer');
    expect(block).toContain('**Expertise:** gcp, kubernetes');
    expect(block).toContain('**Formatting:** concise responses, documented code, bullets lists');
    expect(block).toContain('**Guardrails:**');
    expect(block).toContain('- Never delete prod without confirmation');
  });

  it('renders a minimal identity (personality only)', () => {
    const identity = IdentitySchema.parse({ personality: 'Be terse.' });
    const block = layer(identity).buildIdentityBlock();
    expect(block).toContain('## Identity');
    expect(block).toContain('Be terse.');
    expect(block).not.toContain('**Guardrails:**');
  });

  it('returns empty string for a truly empty identity (no personality, no formatting, no lists)', () => {
    // Construct the bare object directly — bypassing the schema, which always
    // injects formatting defaults. This models the internal "nothing to show"
    // path. (createSkillContextProcessor guards the absent-identity case
    // separately by not calling buildIdentityBlock at all.)
    const bare = { personality: '', expertise: [], guardrails: [] } as never;
    expect(layer(bare).buildIdentityBlock()).toBe('');
  });

  it('a schema-parsed blank identity still renders formatting defaults', () => {
    const identity = IdentitySchema.parse({ personality: '' });
    const block = layer(identity).buildIdentityBlock();
    expect(block).toContain('**Formatting:**');
    expect(block).not.toContain('## Identity');
  });

  it('renders expertise/guardrails even when personality is blank', () => {
    const identity = IdentitySchema.parse({
      personality: '',
      expertise: ['x'],
      guardrails: ['y'],
    });
    const block = layer(identity).buildIdentityBlock();
    expect(block).toContain('**Expertise:** x');
    expect(block).toContain('- y');
  });
});

describe('IdentityLayer Phase-6 stubs', () => {
  it('getCurrentIdentity returns the seed', async () => {
    const identity = IdentitySchema.parse({ personality: 'seed' });
    const cur = await layer(identity).getCurrentIdentity('agent-1');
    expect(cur.personality).toBe('seed');
  });

  it('updateCalibration throws Phase-6', async () => {
    await expect(layer().updateCalibration('a', {})).rejects.toThrow(/Phase 6/);
  });

  it('measureDrift throws Phase-6', async () => {
    await expect(layer().measureDrift('a')).rejects.toThrow(/Phase 6/);
  });
});
