# Claude Code Configuration

## 🚨 CRITICAL: CONCURRENT EXECUTION & FILE MANAGEMENT

**ABSOLUTE RULES**:
1. ALL operations MUST be concurrent/parallel in a single message
2. **NEVER save working files, text/mds and tests to the root folder**
3. ALWAYS organize files in appropriate subdirectories
4. **USE THE TASK TOOL** for spawning agents concurrently

### ⚡ GOLDEN RULE: "1 MESSAGE = ALL RELATED OPERATIONS"

**MANDATORY PATTERNS:**
- **TodoWrite**: ALWAYS batch ALL todos in ONE call (5-10+ todos minimum)
- **Task tool**: ALWAYS spawn ALL agents in ONE message with full instructions
- **File operations**: ALWAYS batch ALL reads/writes/edits in ONE message
- **Bash commands**: ALWAYS batch ALL terminal operations in ONE message

### 📁 File Organization Rules

**NEVER save to root folder. Use these directories:**
- `/src` - Source code files
- `/tests` - Test files
- `/docs` - Documentation and markdown files
- `/config` - Configuration files
- `/scripts` - Utility scripts

---

## Validation Commands (run from `api/`)

- API dry run (recommended for longer work): `./start_dry_run.sh`
- Full build (required for frontend changes): `make web`
- Any time `make web` is required or run, restart/validate the API afterward so the user can observe the newly embedded static assets:
  - if `whoami` is `incognito`, run `make start`
  - otherwise, run `make dry-run`
- Startup validation after frontend-affecting work:
  - if `whoami` is `incognito`, run `make start`
  - otherwise, run `make dry-run`
- OAuth/browser callback QA must run on the configured public dev host and default local port. On the `incognito` machine, do not silently move the service to another port for Facebook or other provider OAuth testing; clear the stale listener and run `make start` on port `8000` so `https://dev.neurograph.io` callbacks reach the service under test.

## Database Console Policy

- Use `cd api && ./dbtool dev console "<sql>"` for read-only inspection of the Core database.
- Agents may use the DB console only to:
  - validate changes
  - inspect schema/data
  - gather example data for realistic mocks or fixtures
- Do not use the DB console to insert, update, or delete data.
- If data needs to be changed, do it through repository code, migrations, or explicit fixture/command programs checked into the repo.

## Required Codegen

- If you change anything under `api/db/sql/schemas` or `api/db/sql/queries`, run:
  - `make gen`
- If you add or modify a migration under `api/db/sql/schemas`, also run:
  - `make up`
  - Fix any migration errors before finishing the task
- If you change anything under `api/handlers/`, run:
  - `make swagger`
- After `make gen` and `make swagger`, refresh local SDK artifacts and frontend build in order:
  1) `make -C api-sdk gen`
  2) `make web`
  3) if `whoami` is `incognito`, run `make start`; otherwise run `make dry-run`
- Only run `make api-sdk` when the user explicitly wants to publish the SDK for the current batch.
- If you change anything under the frontend app (`frontend-admin/`), run:
  - `make web`
  - Resolve any frontend compile/build errors before finishing the task
  - After `make web`, run startup validation and serve the newly embedded web assets:
    - if `whoami` is `incognito`, run `make start`
    - otherwise, run `make dry-run`
  - Resolve any Go compile/runtime startup errors reported by that startup validation before finishing the task
  - For UI, routing, auth, or end-to-end workflow changes, run Playwright from `frontend-admin/`:
    - `bun run test:e2e`
    - Resolve any Playwright failures before finishing the task
- If a task changes both `api/` and `frontend-admin/`, still complete the frontend build/restart sequence after the frontend changes:
  1) `make web`
  2) if `whoami` is `incognito`, run `make start`; otherwise run `make dry-run`

## Runtime Config Verification

- If you add, rename, or make use of new runtime config or secrets in application code, you must trace that config through the real deploy path before considering the work complete.
- Do not stop at local compile/build validation when the feature depends on runtime configuration.
- Follow the repository's established deployment pattern for each environment. If production/staging use checked-in deployment manifests or platform env wiring, update that wiring in the same batch.
- GitHub Secrets are not assumed to reach runtime unless the deploy workflow or platform config in this repo explicitly maps them there.
- When a new required config key is introduced, verify all relevant deploy surfaces are updated, or clearly stop and report the missing runtime wiring as a blocker instead of declaring the task complete.

## Playwright

- Playwright is configured in `frontend-admin/` and should be used for visual and end-to-end validation of frontend work when practical.
- Run Playwright commands from `frontend-admin/`.
- Standard commands:
  - `bun run test:e2e`
  - `bun run test:e2e:ui`
  - `bun run test:e2e:headed`
  - `bun run test:e2e:codegen`
- The Playwright config uses:
  - `e2e/auth.setup.ts` to create authenticated browser state
  - `e2e/.auth/user.json` as the saved storage state
  - `.env.playwright` for local credentials
- `.env.playwright` is intentionally gitignored. Use `.env.playwright.example` as the template for local setup.
- On the `incognito` machine, local Playwright auth is expected to work with the preconfigured dev-only admin user unless the user says otherwise.
- If the task involves authenticated admin/member UX and Playwright cannot authenticate, stop and report the auth blocker clearly.

## Compliance Route Convention

- Admin routes that support internal review workflows and admin UI belong under `/api/v1/admin/compliance/...`
- Provider-specific admin routes belong under `/api/v1/admin/compliance/<provider>/...`
- Generic cross-provider admin routes may live directly under `/api/v1/admin/compliance/...`
- Public platform-facing compliance callbacks and status endpoints belong under `/api/v1/compliance/<provider>/...`
- Do not place public platform callback routes directly under `/api/v1/<provider>/...`

## Generated Files

- Never modify files that contain `// Code generated by sqlc. DO NOT EDIT.`

## Frontend Auth Policy

- Frontend (`frontend-admin/`) must use Firebase ID tokens only (`ApiKeyAuth`) for API calls.
- Do not add or use service-token cookie/header logic in frontend request code.
- If a frontend flow needs an endpoint currently guarded by `HasServiceToken`, change the endpoint guard to `HasAnyAuth` instead of introducing service-token usage on the frontend.

## Sidebar Convention

- Canonical sidebar variant names are `SideBarClient`, `SideBarOrg`, and `SideBarAdmin`.
- Layouts must instantiate the correct sidebar variant outside the sidebar component based on role, route, or masquerade context.
- Do not bury variant selection inside a generic sidebar component via `switch` statements or large internal conditional trees.
- Shared sidebar scaffolding is allowed, but each variant should remain a first-class component with its own explicit name.

## Code Style & Best Practices

- **Modular Design**: Files under 500 lines
- **Environment Safety**: Never hardcode secrets
- **Test-First**: Write tests before implementation
- **Clean Architecture**: Separate concerns

---

# important-instruction-reminders
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
Never save working files, text/mds and tests to the root folder.
