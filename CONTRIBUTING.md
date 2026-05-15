# Contributing to @avant-garde/mastra-self-learning

## Development Setup

```bash
# Clone the repo
git clone https://github.com/avant-garde-labs/mastra-self-learning.git
cd mastra-self-learning

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Dev mode (watch + rebuild)
pnpm dev
```

## Linking for Local Development

To test against a consuming project (e.g. NeuroGraph):

```bash
# In this repo
cd packages/core && pnpm link --global

# In your consuming project
pnpm link --global @avant-garde/mastra-self-learning
```

## Making Changes

1. Create a branch from `main`
2. Make your changes
3. Run `pnpm changeset` to describe the change
4. Run `pnpm test` and `pnpm typecheck`
5. Open a PR

## Release Process

Releases are automated via GitHub Actions + Changesets:
1. PRs with changesets get auto-versioned on merge
2. A "Version Packages" PR is created
3. Merging that PR publishes to npm

## Code Style

- TypeScript strict mode
- Prettier for formatting (`pnpm format`)
- Prefer named exports over default exports
- All public APIs must have JSDoc comments
- Test files live alongside source: `foo.ts` → `foo.test.ts`
