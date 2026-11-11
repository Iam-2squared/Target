-- Read-only Target postflight for ranking and 24h replay retention.
DO $check$
DECLARE
  source_wins bigint;
  source_points bigint;
  present_moves bigint;
  has_schedule boolean;
BEGIN
  IF to_regprocedure('public.two_player_ranking_rpc(text,text,jsonb)') IS NULL OR
     to_regprocedure('target_private.two_player_prune_replays(integer)') IS NULL THEN
    RAISE EXCEPTION 'Missing ranking or replay retention function';
  END IF;
  IF has_function_privilege('anon','target_private.two_player_prune_replays(integer)','EXECUTE') OR
     has_function_privilege('authenticated','target_private.two_player_prune_replays(integer)','EXECUTE') OR
     has_function_privilege('service_role','target_private.two_player_prune_replays(integer)','EXECUTE') THEN
    RAISE EXCEPTION 'Private replay cleaner is exposed to API roles';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='target-2player-prune-replays') THEN
    RAISE EXCEPTION 'Replay retention schedule missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM target_private.two_player_matches
    WHERE status='finished' AND winner IN ('host','guest')
      AND ((winner='host' AND host_score<>3) OR (winner='guest' AND guest_score<>3))
  ) THEN
    RAISE EXCEPTION 'A finished win lacks three goals; review ranking before publishing';
  END IF;
  WITH victories AS (
    SELECT CASE WHEN winner='host' THEN host_id ELSE guest_id END AS member_id,
      3-CASE WHEN winner='host' THEN guest_score ELSE host_score END AS points
    FROM target_private.two_player_matches
    WHERE status='finished' AND settled_at IS NOT NULL AND escrow=0
      AND ((winner='host' AND host_score=3 AND guest_score BETWEEN 0 AND 2)
        OR (winner='guest' AND guest_score=3 AND host_score BETWEEN 0 AND 2))
  ) SELECT COUNT(*),COALESCE(SUM(points),0) INTO source_wins,source_points FROM victories;
  IF source_points<source_wins OR source_points>source_wins*3 THEN
    RAISE EXCEPTION 'Invalid scores';
  END IF;
  SELECT count(*) INTO present_moves FROM target_private.two_player_moves;
  IF EXISTS(SELECT 1 FROM target_private.two_player_moves x
      LEFT JOIN target_private.two_player_matches m ON m.id=x.match_id WHERE m.id IS NULL) THEN
    RAISE EXCEPTION 'Orphaned replay move';
  END IF;
  IF EXISTS(SELECT 1 FROM target_private.two_player_wallet_events e
      LEFT JOIN target_private.two_player_matches m ON m.id=e.match_id WHERE m.id IS NULL) THEN
    RAISE EXCEPTION 'Orphaned financial receipt';
  END IF;
  RAISE NOTICE 'Ranking/retention PASS: wins %, points %, retained recent replay moves %',
    source_wins,source_points,present_moves;
END $check$;