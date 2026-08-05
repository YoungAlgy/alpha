-- alpha · proof-of-send column · 2026-08-05
--
-- Closes the biggest remaining single point of failure flagged by the
-- 2026-08-05 resilience audit: runPersistAndSend (app/api/cron/weekly-
-- send/route.ts) stamps delivered_at as an atomic CLAIM before calling
-- Resend. If the process dies between winning that claim and Resend
-- actually confirming the send (a killed runner, an OOM, a network
-- partition), the row is left with delivered_at set but no email was ever
-- sent -- and every check in the system (the alreadyDelivered prefetch,
-- the RETRY-SAFETY reuse block, the watchdog's own delivered_count) reads
-- "delivered_at IS NOT NULL" as "done, nothing to do here." That
-- subscriber silently never gets a letter, with no error anywhere.
--
-- resend_message_id is the fix: only ever set AFTER sendLetterNotification
-- (lib/email.ts) actually returns Resend's message id, i.e. genuine proof
-- the email was accepted. A row with delivered_at set but
-- resend_message_id still null, past a safety margin comfortably longer
-- than any legitimate in-flight send, is unambiguously a stuck claim --
-- the reclaim step added alongside this column (weekly-send/route.ts)
-- nulls delivered_at back out for exactly that pattern, letting the
-- existing retry-safety path pick the subscriber back up on the next run.
alter table public.issues
  add column if not exists resend_message_id text;

comment on column public.issues.resend_message_id is
  'Resend''s message id, set only after a confirmed successful send. NULL + delivered_at set + past the reclaim safety margin = a stuck claim (process died between the atomic claim and Resend confirming) -- see weekly-send/route.ts''s reclaim step.';
