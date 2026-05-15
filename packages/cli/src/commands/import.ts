import { Command } from 'commander';

export const importCommand = new Command('import')
  .description('Import skills from Hermes Agent or agentskills.io format')
  .option('-f, --file <path>', 'Import a single SKILL.md file')
  .option('-d, --dir <path>', 'Import all SKILL.md files from a directory')
  .option('-t, --trust <tier>', 'Override trust tier (builtin|official|community)', 'community')
  .option('--dry-run', 'Show what would be imported without writing')
  .option('--agent <id>', 'Scope imported skills to a specific agent')
  .action(async (options) => {
    // TODO: Phase 4
    // 1. Resolve file(s) from --file or --dir
    // 2. Parse each with parseSkillDocument()
    // 3. Run scanSkillContent() on each
    // 4. If --dry-run, print summary and exit
    // 5. Store via SkillStorageExtension
    console.log('Import command — not yet implemented (Phase 4)');
    console.log('Options:', options);
  });
