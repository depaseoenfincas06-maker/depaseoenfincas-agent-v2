-- Bring the conversations + messages schema to v1 parity. The v1 workflow
-- (n8n) expects a richer set of columns and a `follow_on` table for the
-- scheduled follow-ups worker. Without these, normalizePostActions and the
-- updated `actualizar contexto` SQL can't apply the patches that v1 ships.
--
-- All ALTERs are idempotent (`IF NOT EXISTS`) so re-running is safe.
-- All defaults match v1 behaviour so existing rows stay valid.

BEGIN;

-- ============================================================================
-- conversations: missing v1 columns
-- ============================================================================

ALTER TABLE conversations
  -- State machine extras
  ADD COLUMN IF NOT EXISTS previous_state TEXT,
  ADD COLUMN IF NOT EXISTS state_changed_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_message_from TEXT CHECK (last_message_from IN ('CLIENT','AGENT')) DEFAULT 'CLIENT',
  ADD COLUMN IF NOT EXISTS waiting_for TEXT DEFAULT 'CLIENT',
  ADD COLUMN IF NOT EXISTS hitl_reason TEXT,

  -- Pricing block (split fields the engine writes in normalizePostActions)
  ADD COLUMN IF NOT EXISTS precio_noche NUMERIC,
  ADD COLUMN IF NOT EXISTS noches INT,
  ADD COLUMN IF NOT EXISTS subtotal NUMERIC,
  ADD COLUMN IF NOT EXISTS deposito_seguridad NUMERIC,
  ADD COLUMN IF NOT EXISTS total NUMERIC,
  ADD COLUMN IF NOT EXISTS anticipo_requerido NUMERIC,
  ADD COLUMN IF NOT EXISTS anticipo_pagado NUMERIC,
  ADD COLUMN IF NOT EXISTS saldo_pagado NUMERIC,
  ADD COLUMN IF NOT EXISTS metodo_pago TEXT,
  ADD COLUMN IF NOT EXISTS comprobante_url TEXT,

  -- Follow-up tracking
  ADD COLUMN IF NOT EXISTS next_followup_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS followup_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS followup_enabled BOOLEAN DEFAULT TRUE,

  -- Confirmation lifecycle
  ADD COLUMN IF NOT EXISTS confirmacion_enviada BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS confirmacion_aceptada BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS confirmacion_version INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS huespedes_completos BOOLEAN DEFAULT FALSE,

  -- Selected finca: id stored separately from the JSONB payload so the engine
  -- can update one without touching the other (avoids stale composites).
  ADD COLUMN IF NOT EXISTS selected_finca_id TEXT,

  -- Pricing structure as a single JSONB blob (mirrors v1 'pricing' field).
  -- Used by the dashboard for at-a-glance display; individual fields above
  -- are the source of truth.
  ADD COLUMN IF NOT EXISTS pricing JSONB,

  -- Guest details (number, ages, pets) as JSONB.
  ADD COLUMN IF NOT EXISTS huespedes JSONB,

  -- Free-form extras (used by confirmation_data_update, etc.)
  ADD COLUMN IF NOT EXISTS extras JSONB DEFAULT '{}'::jsonb,

  -- Chatwoot link (legacy alias of chatwoot_conversation_id; some v1 SQL
  -- references `chatwoot_id`. Keep both for compatibility.)
  ADD COLUMN IF NOT EXISTS chatwoot_id INT;

-- Backfill chatwoot_id from chatwoot_conversation_id if column was just added
UPDATE conversations
   SET chatwoot_id = chatwoot_conversation_id
 WHERE chatwoot_id IS NULL AND chatwoot_conversation_id IS NOT NULL;

-- Backfill state_changed_at to created_at for old rows (instead of forcing now())
UPDATE conversations
   SET state_changed_at = created_at
 WHERE state_changed_at IS NULL OR state_changed_at = state_changed_at; -- no-op safe

-- ============================================================================
-- messages: pending flag for burst aggregation (v1's "Is latest inbound?" path)
-- ============================================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS pending BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS extracted_data JSONB DEFAULT '{}'::jsonb;

-- Index to make the "pending inbox per conversation" lookup fast.
CREATE INDEX IF NOT EXISTS messages_pending_idx
  ON messages (conversation_id, pending)
  WHERE pending = TRUE;

-- ============================================================================
-- follow_on: scheduled follow-up messages (cron-style worker reads from here)
-- ============================================================================

CREATE TABLE IF NOT EXISTS follow_on (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(wa_id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (status IN ('pendiente','sent','cancelada','failed','skipped')),
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  sent_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS follow_on_due_idx
  ON follow_on (status, scheduled_for)
  WHERE status = 'pendiente';

CREATE INDEX IF NOT EXISTS follow_on_conversation_idx
  ON follow_on (conversation_id, status, created_at DESC);

COMMIT;
