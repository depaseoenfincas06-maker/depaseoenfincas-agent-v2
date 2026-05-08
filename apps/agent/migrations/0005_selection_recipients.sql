-- 0005: Selection notification recipients + owner template config.
-- Adds the columns needed for the v1-parity Sprint 4 sub-workflows
-- (Send selection notifications + Fire owner reservation request).
--
-- selection_notification_recipients: comma/semicolon/newline-separated list
--   of staff phone numbers (Meta E.164 without the +) that get pinged when
--   a customer selects a finca.
-- staff_template_name / owner_template_name: which Meta-approved template
--   to use. Defaults match v1.
-- staff_template_language / owner_template_language: ISO language code.

ALTER TABLE agent_settings
  ADD COLUMN IF NOT EXISTS selection_notification_recipients text,
  ADD COLUMN IF NOT EXISTS staff_template_name text DEFAULT 'staff_finca_selected_v1',
  ADD COLUMN IF NOT EXISTS staff_template_language text DEFAULT 'es',
  ADD COLUMN IF NOT EXISTS owner_template_name text DEFAULT 'solicitud_reserva',
  ADD COLUMN IF NOT EXISTS owner_template_language text DEFAULT 'es';

-- Backfill defaults on the existing row (if it pre-existed before
-- the column was added with a DEFAULT).
UPDATE agent_settings SET
  staff_template_name = COALESCE(staff_template_name, 'staff_finca_selected_v1'),
  staff_template_language = COALESCE(staff_template_language, 'es'),
  owner_template_name = COALESCE(owner_template_name, 'solicitud_reserva'),
  owner_template_language = COALESCE(owner_template_language, 'es')
  WHERE id = 1;
