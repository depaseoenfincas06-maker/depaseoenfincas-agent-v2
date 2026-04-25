-- Initial schema for the rewritten agent. Brand-new project, no n8n compatibility.
-- All tables in the public schema.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- conversations: one row per WhatsApp/Chatwoot conversation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  wa_id text PRIMARY KEY,
  chatwoot_conversation_id bigint UNIQUE,
  client_name text,
  current_stage text NOT NULL DEFAULT 'QUALIFYING'
    CHECK (current_stage IN ('QUALIFYING','OFFERING','VERIFYING_AVAILABILITY','CONFIRMING_RESERVATION','HITL')),
  search_criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
  shown_fincas text[] NOT NULL DEFAULT ARRAY[]::text[],
  selected_finca text,
  owner_response jsonb,
  pricing jsonb,
  reservation jsonb,
  agente_activo boolean NOT NULL DEFAULT true,
  hitl_reason text,
  extras jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_stage_updated_idx
  ON conversations (current_stage, updated_at DESC);

-- ---------------------------------------------------------------------------
-- messages: every inbound and outbound message
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL REFERENCES conversations(wa_id) ON DELETE CASCADE,
  external_message_id text,                  -- chatwoot id or wamid
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  message_type text NOT NULL,
  content text,                              -- nullable for media without transcription
  media_url text,
  media_mime_type text,
  media_filename text,
  media_duration_sec numeric,
  transcription_status text CHECK (transcription_status IN ('ok','empty','failed')),
  transcription_attempts jsonb,              -- array of attempts with model+result
  detected_intent text,
  extracted_data jsonb,
  state_at_time text,
  agent_used text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_text_or_media CHECK (
    content IS NOT NULL
    OR media_url IS NOT NULL
    OR message_type IN ('SYSTEM','AUDIO_UNTRANSCRIBED')
  )
);

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_external_id_idx
  ON messages (external_message_id) WHERE external_message_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- message_inbox: incoming jobs (worker consumes via SKIP LOCKED)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','done','failed','skipped')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS message_inbox_status_idx
  ON message_inbox (status, created_at);
CREATE INDEX IF NOT EXISTS message_inbox_conv_idx
  ON message_inbox (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- message_outbox: outgoing messages with retry/audit
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id uuid,
  conversation_id text NOT NULL,
  channel text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  external_message_id text,                  -- assigned after send
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE INDEX IF NOT EXISTS message_outbox_conv_idx
  ON message_outbox (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- traces: one per inbound→outbound cycle
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS traces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL,
  inbound_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  stage_before text,
  stage_after text,
  intent text,
  outbound_count int NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('ok','silent','fallback','error')),
  silence_reason text,
  duration_ms int,
  error_detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS traces_conv_created_idx
  ON traces (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS traces_status_idx
  ON traces (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- agent_turns: one per LLM call
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id uuid REFERENCES traces(id) ON DELETE CASCADE,
  stage text NOT NULL,
  model text NOT NULL,
  prompt jsonb NOT NULL,
  response jsonb,
  tools_called jsonb NOT NULL DEFAULT '[]'::jsonb,
  tokens_in int,
  tokens_out int,
  cost_usd numeric,
  latency_ms int,
  status text NOT NULL CHECK (status IN ('ok','malformed','timeout','error')),
  error_detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_turns_trace_idx ON agent_turns (trace_id);
CREATE INDEX IF NOT EXISTS agent_turns_status_idx
  ON agent_turns (status, created_at DESC) WHERE status <> 'ok';

-- ---------------------------------------------------------------------------
-- fallback_events: invariant violations (always-respond guarantee)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fallback_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL,
  trace_id uuid REFERENCES traces(id) ON DELETE SET NULL,
  reason text NOT NULL,
  context jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fallback_events_created_idx
  ON fallback_events (created_at DESC);

-- ---------------------------------------------------------------------------
-- agent_settings: editable from dashboard (single row, id=1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  tone_preset text NOT NULL DEFAULT 'colombian-bogota-warm',
  tone_guidelines_extra text,
  initial_message_template text,
  handoff_message text,
  company_knowledge jsonb NOT NULL DEFAULT '{}'::jsonb,
  company_documents jsonb NOT NULL DEFAULT '[]'::jsonb,
  payment_methods jsonb NOT NULL DEFAULT '{}'::jsonb,
  inventory_sheet_id text,
  inventory_sheet_tab text,
  followup_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  selection_notification_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  owner_test_mode boolean NOT NULL DEFAULT false,
  confirmation_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO agent_settings (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- followups: scheduled reminders to clients
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL REFERENCES conversations(wa_id) ON DELETE CASCADE,
  message text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pendiente'
    CHECK (status IN ('pendiente','enviada','cancelada','fallida')),
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS followups_status_scheduled_idx
  ON followups (status, scheduled_for) WHERE status = 'pendiente';

-- ---------------------------------------------------------------------------
-- selection_notifications: alerts to staff when client selects finca
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS selection_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL REFERENCES conversations(wa_id) ON DELETE CASCADE,
  selected_finca_id text,
  recipient_phone text,
  template_name text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','failed')),
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

-- ---------------------------------------------------------------------------
-- evals: persisted eval runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by text,
  total int NOT NULL DEFAULT 0,
  passed int NOT NULL DEFAULT 0,
  failed int NOT NULL DEFAULT 0,
  cases jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- updated_at trigger helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS conversations_updated_at ON conversations;
CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS agent_settings_updated_at ON agent_settings;
CREATE TRIGGER agent_settings_updated_at BEFORE UPDATE ON agent_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
