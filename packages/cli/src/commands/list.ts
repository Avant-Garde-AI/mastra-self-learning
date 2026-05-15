import { Command } from 'commander';

export const listCommand = new Command('list')
  .description('List all skills with usage stats')
  .option('--agent <id>', 'Filter by agent')
  .option('--trust <tier>', 'Filter by trust tier')
  .option('--sort <field>', 'Sort by: name, created, used, success', 'name')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    // TODO: Phase 4
    // 1. List skills from storage
    // 2. Format as table or JSON
    console.log('List command — not yet implemented (Phase 4)');
    console.log('Options:', options);
  });
