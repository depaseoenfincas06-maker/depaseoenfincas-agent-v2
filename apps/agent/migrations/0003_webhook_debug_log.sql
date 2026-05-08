-- Captures EVERY hit to webhook routes regardless of auth/parse result.
-- Used to diagnose "is Chatwoot actually delivering?" — without this we
-- have to guess based on whether conversations appear in our main tables,
-- which only happens AFTER auth + normalize succeed.
--
-- Cap retention to keep this small: a cron should DELETE rows older than
-- 7 days. For now we just rely on volume staying low.

CREATE TABLE IF NOT EXISTS webhook_debug_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path text NOT NULL,
  method text NOT NULL,
  remote_ip text,
  user_agent text,
  content_type text,
  content_length int,
  has_chatwoot_signature boolean DEFAULT false,
  has_webhook_secret_header boolean DEFAULT false,
  auth_result text,                  -- 'ok-hmac' | 'ok-literal' | 'ok-open' | 'fail-no-match' | 'fail-no-rawbody'
  outcome text,                       -- 'processed' | 'duplicate' | 'ignored' | 'unauthorized' | 'parse_error'
  body_preview text,                  -- first 1000 chars, for quick eyeball
  headers_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_debug_log_created_idx
  ON webhook_debug_log (created_at DESC);
