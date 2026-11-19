-- Count persisted, TOAST-compressed replay bytes instead of the transient uncompressed
-- JSON request. Financial events, user answers, inputs, and replay JSON are never modified.
-- This is an additive accounting credit, not deletion or rewriting of finished soccer moves.
--
-- Existing resolved moves are immutable; credit them in an independent private table.
-- For future moves, the AFTER trigger reads the STORED row. Using NEW.frames directly
-- would measure the large, not-yet-TOAST-compressed JSON value (verified in PostgreSQL).
CREATE TABLE target_private.two_player_replay_quota_credits (
  match_id uuid NOT NULL,
  round integer NOT NULL,
  credit_bytes integer NOT NULL CHECK(credit_bytes > 0 AND credit_bytes <= 393216),
  PRIMARY KEY (match_id, round),
  FOREIGN KEY (match_id, round)
    REFERENCES target_private.two_player_moves(match_id, round) ON DELETE RESTRICT
);
ALTER TABLE target_private.two_player_replay_quota_credits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON target_private.two_player_replay_quota_credits FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE target_private.two_player_replay_quota_credits IS
  'Immutable accounting credits for replay frames already compressed by PostgreSQL. No gameplay or wallet records are changed.';

CREATE FUNCTION target_private.two_player_replay_quota_credit()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $quota$
DECLARE
  stored_charge integer;
  discount integer;
  granted bigint;
BEGIN
  -- A single real resolve transition; retries and later updates must not re-credit.
  IF OLD.resolved_at IS NOT NULL OR NEW.resolved_at IS NULL THEN RETURN NEW; END IF;

  -- AFTER UPDATE NEW.frames is uncompressed inside PL/pgSQL. Read the on-disk
  -- TOAST representation through a fresh indexed SELECT instead.
  SELECT 2048 + pg_column_size(frames) + pg_column_size(state)
    INTO stored_charge
    FROM target_private.two_player_moves
    WHERE match_id = NEW.match_id AND round = NEW.round;
  IF stored_charge IS NULL OR stored_charge < 2048 THEN
    RAISE EXCEPTION 'Stored soccer replay charge unavailable';
  END IF;
  discount := GREATEST(0, NEW.charged_bytes - stored_charge);
  IF discount = 0 THEN RETURN NEW; END IF;

  WITH issued AS (
    INSERT INTO target_private.two_player_replay_quota_credits(match_id,round,credit_bytes)
    VALUES (NEW.match_id,NEW.round,discount)
    ON CONFLICT (match_id,round) DO NOTHING RETURNING credit_bytes
  )
  SELECT COALESCE(SUM(credit_bytes),0)::bigint INTO granted FROM issued;

  IF granted > 0 THEN
    UPDATE target_private.system_state
      SET logical_bytes = logical_bytes - granted
      WHERE singleton AND logical_bytes >= granted;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invalid replay quota credit'; END IF;
  END IF;
  RETURN NEW;
END $quota$;
REVOKE ALL ON FUNCTION target_private.two_player_replay_quota_credit()
  FROM PUBLIC, anon, authenticated, service_role;

-- No public API, old request/receipt compatibility or finished replay data changes.
CREATE TRIGGER two_player_replay_quota_credit
AFTER UPDATE OF resolved_at ON target_private.two_player_moves
FOR EACH ROW
WHEN (OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL)
EXECUTE FUNCTION target_private.two_player_replay_quota_credit();

-- One-time idempotent credit of already finished moves. The same advisory lock
-- serializes this operation with existing quiz and soccer transactions.
DO $backfill$
DECLARE
  granted bigint;
  unreconciled integer;
BEGIN
  PERFORM pg_advisory_xact_lock(991101);

  WITH issued AS (
    INSERT INTO target_private.two_player_replay_quota_credits(match_id,round,credit_bytes)
    SELECT match_id,round,
      GREATEST(0,charged_bytes - (2048 + pg_column_size(frames) + pg_column_size(state)))
    FROM target_private.two_player_moves
    WHERE resolved_at IS NOT NULL
      AND charged_bytes > 2048 + pg_column_size(frames) + pg_column_size(state)
    ON CONFLICT (match_id,round) DO NOTHING
    RETURNING credit_bytes
  )
  SELECT COALESCE(SUM(credit_bytes),0)::bigint INTO granted FROM issued;

  IF granted > 0 THEN
    UPDATE target_private.system_state
      SET logical_bytes = logical_bytes - granted
      WHERE singleton AND logical_bytes >= granted;
    IF NOT FOUND THEN RAISE EXCEPTION 'Replay credit exceeds existing quota usage'; END IF;
  END IF;

  SELECT count(*) INTO unreconciled
    FROM target_private.two_player_moves m
    WHERE m.resolved_at IS NOT NULL
      AND m.charged_bytes > 2048 + pg_column_size(m.frames) + pg_column_size(m.state)
      AND NOT EXISTS (
        SELECT 1 FROM target_private.two_player_replay_quota_credits c
        WHERE c.match_id=m.match_id AND c.round=m.round
      );
  IF unreconciled <> 0 THEN RAISE EXCEPTION 'Unreconciled soccer replays: %',unreconciled; END IF;
END $backfill$;
