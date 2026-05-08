-- Add columns / JSONB blobs needed to bring the Settings UI to parity with the
-- v1 Ops Console form. Most v1 fields already had homes (tone_preset, etc.),
-- this migration adds the rest:
--
--   prompt_addenda     JSONB  → { global, qualifying, offering, verifying,
--                                  qa, hitl, confirming } per-stage prompt
--                                  addenda. Stages append these to their base
--                                  prompts.
--   coverage_zones     TEXT   → free-form text the QA agent surfaces when a
--                                  client asks "¿qué zonas atienden?"
--   public_app_base_url TEXT  → used to build links inside generated PDFs
--   max_properties_to_show INT  → cap how many fincas the agent shows in one
--                                  message (defaults to 3)
--   global_bot_enabled BOOL   → master switch; if false, all conversations
--                                  short-circuit to silence (intended for
--                                  emergency stop / off-hours).
--   owner_contact_override TEXT → legacy: phone number to redirect owner
--                                  notifications to during testing.
--
-- Existing JSONB columns we'll continue to use:
--   selection_notification_settings → { enabled, recipients[] }
--   confirmation_settings           → could hold pdf-related extras
--
-- All columns get sensible defaults so the migration is idempotent and won't
-- break running services.

ALTER TABLE agent_settings
  ADD COLUMN IF NOT EXISTS prompt_addenda JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS coverage_zones TEXT,
  ADD COLUMN IF NOT EXISTS public_app_base_url TEXT,
  ADD COLUMN IF NOT EXISTS max_properties_to_show INT DEFAULT 3 CHECK (max_properties_to_show BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS global_bot_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS owner_contact_override TEXT;
