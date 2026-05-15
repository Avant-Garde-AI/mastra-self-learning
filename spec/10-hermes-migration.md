# Hermes Migration

## Importing from Hermes Agent / agentskills.io

If you have existing skills from Hermes Agent or the agentskills.io ecosystem, you can import them directly.

## Skill Format Compatibility

The SKILL.md format used by this package is compatible with agentskills.io:

| Feature | Hermes Agent | This Package | Notes |
|---|---|---|---|
| YAML frontmatter | ✅ | ✅ | Same structure |
| `name`, `description` | ✅ | ✅ | Direct mapping |
| `version` | ✅ | ✅ | Semver |
| `author` | ✅ | ✅ | Extended with Mastra metadata |
| `tags`, `platforms` | ✅ | ✅ | Direct mapping |
| `## Procedure` section | ✅ | ✅ | Same format |
| `## When to Use` section | ✅ | ✅ | Same format |
| `## Prerequisites` section | ✅ | ✅ | Same format |
| `## Pitfalls` section | ✅ | ✅ | Same format |
| Trust tiers | `builtin/official/community` | `builtin/official/community/agent-created` | Extended |
| Metadata | Generic | `metadata.mastra` namespace | Additive |

### What Gets Added on Import

When importing a Hermes skill, we add:
- `metadata.mastra.extractionTrigger: 'import'`
- `trust: 'community'` (unless overridden)
- `status: 'active'`
- `successCount: 0`, `failCount: 0`
- Embedding vector (if embedding model configured)

## CLI Import

```bash
# Import a single skill
npx @avant-garde/mastra-self-learning-cli import --file ./skills/deploy-cloud-run.md

# Import a directory of skills
npx @avant-garde/mastra-self-learning-cli import --dir ./skills/

# Import from a Hermes agent's skill directory
npx @avant-garde/mastra-self-learning-cli import --dir ~/.hermes/skills/

# Import with trust tier override
npx @avant-garde/mastra-self-learning-cli import --dir ./skills/ --trust official

# Dry run (show what would be imported)
npx @avant-garde/mastra-self-learning-cli import --dir ./skills/ --dry-run
```

## CLI Export

```bash
# Export all skills to agentskills.io format
npx @avant-garde/mastra-self-learning-cli export --dir ./exported-skills/

# Export skills for a specific agent
npx @avant-garde/mastra-self-learning-cli export --agent ops-agent --dir ./exported-skills/

# Export with Mastra metadata stripped (pure agentskills.io)
npx @avant-garde/mastra-self-learning-cli export --strip-mastra --dir ./exported-skills/
```

## Hermes Memory Migration

### MEMORY.md → Fact Layer

Hermes stores cross-session memory in `MEMORY.md`. The CLI can import this:

```bash
npx @avant-garde/mastra-self-learning-cli import-memory --file ~/.hermes/MEMORY.md
```

The importer:
1. Parses the MEMORY.md markdown
2. Splits into individual fact entries
3. Categorizes each fact (preference, context, project, etc.)
4. Stores in the Fact Layer with `confidence: 0.8` (slightly below max since facts are imported, not directly observed)

### SOUL.md → Identity Layer

Hermes stores agent personality in `SOUL.md`:

```bash
npx @avant-garde/mastra-self-learning-cli import-identity --file ~/.hermes/SOUL.md
```

This creates an `Identity` configuration that can be passed to `createSkillContextProcessor()`.

## Programmatic Import

```typescript
import { parseSkillDocument, SkillStorageExtension } from '@avant-garde/mastra-self-learning';
import { readFileSync } from 'fs';

const storage = new SkillStorageExtension(store);

// Import a single skill
const markdown = readFileSync('./skills/deploy-cloud-run.md', 'utf-8');
const { frontmatter, body } = parseSkillDocument(markdown);

await storage.createSkill({
  name: frontmatter.name,
  version: frontmatter.version ?? '1.0.0',
  content: markdown,
  frontmatter,
  trustTier: 'community',
  status: 'active',
  successCount: 0,
  failCount: 0,
});
```

## Bidirectional Sync

For teams running both Hermes Agent and Mastra-based agents, skills can flow in both directions:

1. **Hermes → Mastra**: CLI import, periodic sync
2. **Mastra → Hermes**: CLI export to agentskills.io format, drop into Hermes skill directory

The `metadata.mastra` namespace in frontmatter is ignored by Hermes Agent (which only reads standard agentskills.io fields), so exported skills are fully compatible.
