-- Extend the five fixed, short-lived soccer text stamps to eight.
-- Existing IDs 1..5, participants-only permissions, five-second sender cooldown,
-- 30-per-match cap, ten-minute expiration, and all financial rules stay unchanged.
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='60s';

DO $guard$
DECLARE constraint_text text; hash text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO constraint_text
    FROM pg_constraint c
    WHERE c.conrelid='target_private.two_player_social_stamps'::regclass
      AND c.conname='two_player_social_stamps_stamp_id_check';
  IF constraint_text IS DISTINCT FROM 'CHECK (((stamp_id >= 1) AND (stamp_id <= 5)))'
    THEN RAISE EXCEPTION 'Existing soccer stamp constraint changed'; END IF;
  SELECT md5(p.prosrc) INTO hash FROM pg_proc p
    WHERE p.oid='public.two_player_social_rpc(text,text,jsonb)'::regprocedure;
  IF hash IS DISTINCT FROM '549fe8ac81f3e50a5470d20a5eee1d69'
    THEN RAISE EXCEPTION 'Reviewed soccer social RPC changed'; END IF;
END $guard$;

ALTER TABLE target_private.two_player_social_stamps
  DROP CONSTRAINT two_player_social_stamps_stamp_id_check,
  ADD CONSTRAINT two_player_social_stamps_stamp_id_check
    CHECK (stamp_id BETWEEN 1 AND 8);

DO $replace$
DECLARE code text;
  previous text := '''^[1-5]$''';
  expanded text := '''^[1-8]$''';
BEGIN
  SELECT pg_get_functiondef('public.two_player_social_rpc(text,text,jsonb)'::regprocedure)
    INTO code;
  IF length(code)-length(replace(code,previous,''))<>length(previous)
    THEN RAISE EXCEPTION 'Expected exactly one immutable numeric stamp allowlist'; END IF;
  code:=replace(code,previous,expanded);
  EXECUTE code;
  IF position(expanded IN
    pg_get_functiondef('public.two_player_social_rpc(text,text,jsonb)'::regprocedure))=0
    THEN RAISE EXCEPTION 'Expanded stamp authorization did not take effect'; END IF;
END $replace$;

-- Existing anonymous RPC restrictions, RLS, short retention, and finances remain.
NOTIFY pgrst,'reload schema';
COMMIT;
