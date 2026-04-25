# Deployment Guide

## Architecture (production)

```
        ┌──────────────────────────────────┐
WhatsApp──→Chatwoot──webhook──→ Backend HTTP ──→ Postgres (Supabase)
                                  │              ↑
                                  ▼              │
                                Redis ←──── BullMQ Worker (separate process)
                                                 │
                                                 ▼
                                          Gemini / OpenAI APIs

  Browser ────────→ Dashboard (Next.js, Vercel) ──Next rewrite──→ Backend HTTP
```

Three separate runtimes:

| Component | What | Where |
|-----------|------|-------|
| **Backend HTTP** | Fastify server — receives Chatwoot webhooks, exposes admin API | persistent server (Render / Elestio / Railway / Fly) |
| **Backend Worker** | BullMQ worker — processes message_inbox jobs, calls LLM, sends outbound | persistent server (same image, different command) |
| **Dashboard** | Next.js — read-only ops UI | Vercel |
| **Postgres** | Conversations, messages, traces, settings | **Supabase** (you already have it — separate project from old one) |
| **Redis** | BullMQ queue | Upstash free tier OR included with the backend platform |

## Why NOT Vercel for the backend

Vercel is serverless: each request gets a fresh function with a 60s (hobby) or 5min (pro) timeout. That doesn't fit our backend because:

- The **BullMQ worker** has to stay alive 24/7 to process jobs as they enqueue
- Audio transcription + Gemini calls can take 8–15s, fine on Vercel pro but borderline
- Database connections need pooling (we use `pg.Pool`) which doesn't survive between serverless invocations

Vercel is **perfect for the dashboard** (Next.js, no long-running needs).

## Recommended setups

### Option A — Render (everything in one place, simplest)

Pros: blueprint deploy from `render.yaml` we already committed, includes Redis, generous free tier.
Cons: cold starts on free tier, you'll want at least the Starter plan ($7/mo per service).

**Steps:**

1. Sign up at https://render.com (use GitHub).
2. New → "Blueprint" → connect this repo (`juanda89/depaseoenfincas-agent`).
3. Render reads `render.yaml` and shows: 1 web service, 1 worker, 1 Redis. Click "Apply".
4. After provisioning, set the secret env vars in each service:
   - `DATABASE_URL` — your Supabase pooler URL
   - `GEMINI_API_KEY`, `OPENAI_API_KEY`
   - `CHATWOOT_BASE_URL`, `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_API_TOKEN`
   - `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_OWNER_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`
   - `INVENTORY_SHEET_DOCUMENT_ID`, `INVENTORY_SHEET_TAB_NAME`
5. Run the migration once (Render shell or local `pnpm db:migrate` against the DATABASE_URL).
6. The web service URL is e.g. `https://depf-agent-server.onrender.com`.

Then deploy the dashboard:

7. Go to Vercel → import the same repo → root directory `apps/dashboard`.
8. Set env: `AGENT_API_URL=https://depf-agent-server.onrender.com`.
9. Vercel builds and gives you `https://depf-dashboard.vercel.app`.

### Option B — Elestio (already familiar, same provider as n8n + Chatwoot)

Pros: dashboard alongside your existing services, same billing.
Cons: more manual setup than Render's blueprint.

**Steps:**

1. Elestio → New Service → Docker Compose.
2. Use the production `docker-compose.prod.yml` (committed alongside `docker-compose.yml` — TODO: I need to write this if you go this route).
3. Set env vars in the service config.
4. Add a Redis service (Elestio has 1-click Redis).
5. Migrations run automatically on deploy via the entrypoint script (TODO).

### Option C — Fly.io (best for low latency + great dev tooling)

Skip unless you specifically want global edge.

## Connecting Chatwoot

Once the backend is deployed and reachable at e.g. `https://depf-agent-server.onrender.com`:

1. Chatwoot → Settings → Integrations → Webhooks → Add new
2. URL: `https://depf-agent-server.onrender.com/webhook/chatwoot`
3. Events: only `Conversation: Message Created` (we ignore everything else)
4. (Optional) Add header `X-Webhook-Secret: <value>` matching `WEBHOOK_SHARED_SECRET` env var

The route at `/webhook/chatwoot` accepts Chatwoot's native payload format, normalizes it (extracts wa_id, content, attachments), dedupes by `source_id` (wamid) to handle Chatwoot retries, and enqueues a BullMQ job.

For the **inbound number to switch to +57 310 5639334**, you also need to:

1. Connect the new number to your WhatsApp Business Account (Meta or Kapso)
2. Tell Chatwoot to use this new inbox
3. Outbound from Chatwoot will automatically use the inbox connected to the conversation

## Database migration

The new project uses a **separate Postgres** from the old one. Don't share — that would mix two systems writing to the same `conversations` table. Either:

- **Same Supabase project, different schema** — set `?schema=depf_v2` on the DATABASE_URL and we'll create the tables there. Cleanest if you want one Supabase project for both. Migration file would need a `CREATE SCHEMA IF NOT EXISTS` prepended.
- **New Supabase project** — create a fresh one, paste pooler URL into DATABASE_URL. Cleanest separation.

Then `pnpm db:migrate` once.

## Local testing the Chatwoot webhook BEFORE deploying

If you want to verify the Chatwoot integration without deploying yet, use a tunnel:

```bash
# Cloudflare tunnel — no signup, no install if you have brew, but you don't.
# Easiest with ngrok:
brew install ngrok        # if you install homebrew
ngrok http 3200
# Use the https://*.ngrok-free.app URL as the Chatwoot webhook URL temporarily
```

Or use a stand-in: post a sample Chatwoot payload to `/webhook/chatwoot` directly with curl to verify the normalizer works.

## What's next when you decide a platform

Tell me which (Render / Elestio / Vercel-for-dashboard / Railway), and I'll:

1. Verify the deploy config matches that platform
2. Write any platform-specific entrypoint script (e.g. auto-migrate on first boot)
3. Walk you through the env vars setup, in order
4. Test from end to end (post a test webhook, watch the trace land in dashboard)

You shouldn't have to manually configure 12 env vars across 3 different UIs — I can give you a checklist.
