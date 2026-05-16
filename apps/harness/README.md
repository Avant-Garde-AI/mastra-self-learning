# Self-Learning Dev Harness

A local Mastra server + React admin UI for **watching `@avant-garde/mastra-self-learning`
learn**. Chat with a self-learning agent, then watch skills get extracted,
retrieved, used, and refined in real time.

```
┌────────────┐   AG-UI    ┌─────────────────────────────┐   SQL    ┌──────────┐
│  React UI  │◀──────────▶│  Mastra server (:4111)      │◀────────▶│ Postgres │
│  (:5173)   │  /copilotkit│  agent + self-learning loop │ pgvector │ (:5544)  │
│  CopilotKit│  /admin/*  │  + admin/observability API  │          │          │
└────────────┘            └─────────────────────────────┘          └──────────┘
```

## What you can see

- **Learned Skills** (left) — every skill the agent has extracted, with version,
  trust tier, success/fail counts, tags. Click one for full `SKILL.md`, the
  version history, and per-version unified **diffs**.
- **Chat** (center) — talk to the agent via CopilotKit. Ask it to do a
  multi-step task; when it completes one, a skill appears on the left.
- **Learning timeline** (right) — a live SSE feed of every
  `extraction.*` / `refinement.*` event as the loop fires.
- **Facts** (right) — the cross-thread fact layer.
- **Run learning demo** (top-right) — a scripted, **credential-free**
  demonstration: drives the real loop against real Postgres so you can watch
  an extraction *and* a refinement happen even without an API key.

## Run it

```bash
# 1. Postgres (pgvector)
docker compose -f apps/harness/docker-compose.yml up -d

# 2. (optional) enable real chat + automatic learning
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Server  (terminal A)
pnpm --filter @avant-garde/harness-server dev      # → http://localhost:4111

# 4. Web  (terminal B)
pnpm --filter @avant-garde/harness-web dev         # → http://localhost:5173
```

Open <http://localhost:5173>. With no API key, the chat panel explains itself
and the **Run learning demo** button still shows the full loop. With a key,
chat drives extraction/refinement organically.

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5544/mastra_harness` | Postgres |
| `ANTHROPIC_API_KEY` | _(unset)_ | Enables chat + auto-learning |
| `HARNESS_MODEL` | `claude-sonnet-4-5-20250929` | Chat + aux model |
| `HARNESS_AGENT_ID` | `harness-agent` | Skill scope |
| `PORT` | `4111` | Server port |
| `HARNESS_WEB_ORIGIN` | `http://localhost:5173` | CORS origin |
| `VITE_SERVER_URL` | `http://localhost:4111` | Web → server base URL |

## Admin API (read-only observability)

```
GET  /admin/health                 server + db + llm + event stats
GET  /admin/skills                 list learned skills
GET  /admin/skills/:id             skill + versions + usage
GET  /admin/skills/:id/versions    version history (with diffs)
GET  /admin/skills/:id/usage       aggregate usage stats
GET  /admin/facts?q=               fact layer (FTS)
GET  /admin/events?limit=200       recent learning events (JSON)
GET  /admin/events?stream=1        live SSE event stream
POST /admin/demo                   run the scripted learning demo
```

Chat runs through the AG-UI/Mastra CopilotKit bridge at `/copilotkit`.
