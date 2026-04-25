# De Paseo en Fincas — Agent

Conversational agent backend + dashboard for the De Paseo en Fincas WhatsApp bot. This is a ground-up rewrite of the previous n8n-based system with these goals:

- **Always respond.** Hard invariant: every inbound message produces an outbound or an explicit, logged silence reason.
- **Multi-user safe.** Conversation-level locking via Postgres `SELECT ... FOR UPDATE SKIP LOCKED` + BullMQ; many users can converse in parallel without context bleed.
- **Total observability.** Every inbound→outbound cycle records a trace; every LLM call records prompt, response, tools, tokens, latency, cost.
- **No black-box agents.** Stages are explicit state-machine nodes; LLM is used as a structured-output classifier/generator, never as an opaque agent loop.
- **Real audio transcription.** Multi-attempt with `gpt-4o-transcribe` (full) + Whisper-1 fallback + domain prompt; "please type it" is a rare last resort, not a feature.

## Architecture

```
┌──────────────┐   ┌────────────────────┐    ┌───────────┐
│ Chatwoot /   │──▶│ Webhook receiver   │───▶│ Postgres  │
│ Meta WA      │   │ (Fastify)          │    │ inbox     │
└──────────────┘   └────────────────────┘    └─────┬─────┘
                                                   │
                                                   ▼
                                         ┌───────────────────┐
                                         │ BullMQ worker     │
                                         │ (1 job/conv lock) │
                                         └─────────┬─────────┘
                                                   │
                          ┌────────────────────────┴────────────────────────┐
                          ▼                                                  ▼
                ┌──────────────────┐                                ┌────────────────┐
                │ Orchestrator     │                                │ Channel sender │
                │  - prechecks     │                                │  - typing      │
                │  - intent router │                                │  - text        │
                │  - stage handler │                                │  - media/PDF   │
                │  - tools         │                                └────────────────┘
                │  - "always       │
                │     respond"     │
                └──────────────────┘
```

## Repo layout

```
apps/
  agent/        Fastify HTTP server + BullMQ workers + orchestrator
  dashboard/    Next.js admin UI (settings, conversations, traces, evals)
packages/
  shared/       Shared TypeScript types + zod schemas
docs/           Architecture decisions, runbooks
infra/          Docker compose + deploy scripts
```

## Prerequisites

- Node 20+ and pnpm 10+ (we recommend `corepack enable` and let it manage pnpm)
- Docker Desktop or OrbStack for local Postgres + Redis (or point `DATABASE_URL` / `REDIS_URL` at a remote instance)

## Quick start

```bash
# 1. Infra (Postgres + Redis)
pnpm infra:up

# 2. Install deps
pnpm install

# 3. Configure env
cp .env.example .env
# fill in GEMINI_API_KEY, OPENAI_API_KEY, etc

# 4. DB migrations
pnpm db:migrate

# 5. Run
pnpm dev   # runs agent + dashboard in parallel
```

## Tech

- Node.js 20 + TypeScript 5
- Fastify 5 (HTTP) + BullMQ 5 (queue)
- Postgres 16 (Supabase in prod, docker-compose locally)
- Redis 7
- Next.js 15 (App Router) for dashboard
- pino for structured logging
- vitest for tests
- Zod for runtime validation everywhere

## Quality bar

- Strict TS (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
- Eval suite covering known-bad cases (the 13 silence cases from production)
- CI runs lint + typecheck + tests + evals on every push
