-- Safe read-only postflight. Run only on Target's intended project.
-- No private member IDs, wallet details or replay payloads are displayed.
DO $postflight$
DECLARE
  uncredited bigint;
  mismatched bigint;
  total_credit bigint;
  game_rows bigint;
  current_bytes bigint;
BEGIN
  IF to_regclass('target_private.two_player_replay_quota_credits') IS NULL THEN
    RAISE EXCEPTION 'Quota credit table missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='target_private.two_player_moves'::regclass
      AND tgname='two_player_replay_quota_credit' AND tgenabled='O'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='target_private.two_player_moves'::regclass
      AND tgname='two_player_moves_locked' AND tgenabled='O'
  ) THEN
    RAISE EXCEPTION 'Replay credit or immutable-result trigger missing/disabled';
  END IF;
  IF has_table_privilege('anon','target_private.two_player_replay_quota_credits','SELECT') OR
     has_table_privilege('authenticated','target_private.two_player_replay_quota_credits','SELECT') THEN
    RAISE EXCEPTION 'Private quota credits exposed to browser roles';
  END IF;

  SELECT count(*) INTO uncredited FROM target_private.two_player_moves m
   WHERE m.resolved_at IS NOT NULL AND
     m.charged_bytes>2048+pg_column_size(m.frames)+pg_column_size(m.state) AND NOT EXISTS (
       SELECT 1 FROM target_private.two_player_replay_quota_credits c
       WHERE c.match_id=m.match_id AND c.round=m.round);
  SELECT count(*) INTO mismatched FROM target_private.two_player_replay_quota_credits c
    JOIN target_private.two_player_moves m ON m.match_id=c.match_id AND m.round=c.round
    WHERE m.resolved_at IS NULL OR c.credit_bytes > m.charged_bytes;
  IF uncredited<>0 OR mismatched<>0 THEN
    RAISE EXCEPTION 'Invalid replay quota credits: missing %, mismatched %',uncredited,mismatched;
  END IF;

  SELECT count(*),coalesce(sum(credit_bytes),0) INTO game_rows,total_credit
    FROM target_private.two_player_replay_quota_credits;
  SELECT logical_bytes INTO current_bytes FROM target_private.system_state WHERE singleton;
  IF current_bytes IS NULL OR current_bytes<0 OR current_bytes>104857600 THEN
    RAISE EXCEPTION 'Invalid Target capacity state';
  END IF;
  RAISE NOTICE 'Quota PASS: credited moves %, bytes returned %, current logical use % of 104857600',
    game_rows,total_credit,current_bytes;
END $postflight$;
