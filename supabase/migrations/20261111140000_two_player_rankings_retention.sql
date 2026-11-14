-- 2player: permanent aggregate ranking from settled match summaries; replay details
-- need not be retained after a 24-hour grace period.
-- Money ledger, request receipts and match summaries are never erased.
--
-- This migration must run only against the Target project. It does not touch KGS.
CREATE FUNCTION public.two_player_ranking_rpc(p_secret text,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $ranking$
DECLARE result_rows jsonb;
BEGIN
  -- Same private server credential as the existing soccer RPC; check it before
  -- parsing any actor input or accessing private match/profile tables.
  IF p_secret IS NULL OR length(p_secret) NOT BETWEEN 32 AND 256 OR NOT EXISTS(
    SELECT 1 FROM target_private.two_player_credentials
    WHERE singleton AND key_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex')
  ) THEN
    RETURN target_private.error_result(403,'RPC_FORBIDDEN','この操作は許可されていません。');
  END IF;
  IF p_action IS DISTINCT FROM 'list' OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR pg_column_size(p_input)>4096 OR
    (SELECT count(*) FROM jsonb_object_keys(p_input))<>2 OR
    NOT(p_input?'memberId' AND p_input?'name') OR
    coalesce(p_input->>'memberId','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
    OR jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string'
    OR length(btrim(p_input->>'name')) NOT BETWEEN 1 AND 20 THEN
    RETURN target_private.error_result(400,'INVALID_REQUEST','送信内容を確認してください。');
  END IF;

  -- 3:0 -> 3, 3:1 -> 2, 3:2 -> 1. A loss/draw/cancel scores zero.
  -- Read only from authoritative completed matches, not caller-supplied scores,
  -- mutable display names, or refund/void records.
  WITH victories AS (
    SELECT CASE WHEN m.winner='host' THEN m.host_id ELSE m.guest_id END AS member_id,
      3-CASE WHEN m.winner='host' THEN m.guest_score ELSE m.host_score END AS points
    FROM target_private.two_player_matches m
    WHERE m.status='finished' AND m.settled_at IS NOT NULL AND m.escrow=0
      AND ((m.winner='host' AND m.host_score=3 AND m.guest_score BETWEEN 0 AND 2)
        OR (m.winner='guest' AND m.guest_score=3 AND m.host_score BETWEEN 0 AND 2))
  ), totals AS (
    SELECT member_id,count(*)::bigint AS wins,sum(points)::bigint AS points
    FROM victories GROUP BY member_id
  ), ranked AS (
    SELECT t.member_id,t.wins,t.points,
      row_number() OVER (ORDER BY t.points DESC,t.wins DESC,t.member_id) AS place
    FROM totals t
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object('rank',r.place,'name',p.name,'wins',r.wins,'points',r.points,
      'isYou',r.member_id=(p_input->>'memberId')::uuid)
    ORDER BY r.place),'[]'::jsonb)
  INTO result_rows
  FROM (SELECT * FROM ranked ORDER BY place LIMIT 100) r
    JOIN target_private.profiles p ON p.member_id=r.member_id;
  RETURN jsonb_build_object('ok',true,'ranking',result_rows);
END $ranking$;
REVOKE ALL ON FUNCTION public.two_player_ranking_rpc(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.two_player_ranking_rpc(text,text,jsonb) TO anon,authenticated,service_role;

-- Protect all active and recent replay data, and make completed historical
-- replay rows eligible for deletion by the private maintenance function only
-- after their escrow has been settled for 24 hours. Results cannot be changed.
CREATE OR REPLACE FUNCTION target_private.two_player_protect_move()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $guard$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.resolved_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM target_private.two_player_matches m
      WHERE m.id=OLD.match_id AND m.status IN ('finished','cancelled')
        AND m.settled_at < clock_timestamp()-interval '24 hours'
        AND m.escrow=0
    ) THEN
      RAISE EXCEPTION 'Active or unsettled soccer replay cannot be removed' USING ERRCODE='42501';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.resolved_at IS NOT NULL OR
    (NEW.match_id,NEW.round,NEW.version,NEW.actor,NEW.angle,NEW.power,NEW.piece,NEW.created_at)
    IS DISTINCT FROM (OLD.match_id,OLD.round,OLD.version,OLD.actor,OLD.angle,OLD.power,OLD.piece,OLD.created_at)
  THEN RAISE EXCEPTION 'Soccer input/result is immutable' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $guard$;

-- Only database owners/cron may call the private retention function. No HTTP
-- endpoint can invoke it; anon/authenticated/service_role get no privilege.
CREATE FUNCTION target_private.two_player_prune_replays(p_limit integer DEFAULT 1500)
RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog AS $prune$
DECLARE item record; removed_count integer:=0; released_bytes bigint:=0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Invalid replay pruning limit' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(991101);
  FOR item IN
    SELECT mv.match_id,mv.round,mv.charged_bytes,
      coalesce(c.credit_bytes,0)::integer AS credit_bytes
    FROM target_private.two_player_moves mv
    JOIN target_private.two_player_matches m ON m.id=mv.match_id
    LEFT JOIN target_private.two_player_replay_quota_credits c
      ON c.match_id=mv.match_id AND c.round=mv.round
    WHERE mv.resolved_at IS NOT NULL AND m.status IN ('finished','cancelled')
      AND m.settled_at < clock_timestamp()-interval '24 hours' AND m.escrow=0
    ORDER BY m.settled_at,mv.match_id,mv.round
    LIMIT p_limit FOR UPDATE OF mv SKIP LOCKED
  LOOP
    IF item.charged_bytes < item.credit_bytes THEN
      RAISE EXCEPTION 'Invalid replay quota for completed move';
    END IF;
    -- RESTRICT FK on quota credits must be cleared before its finished move.
    -- Both deletes and quota subtraction belong to the same transaction.
    DELETE FROM target_private.two_player_replay_quota_credits
      WHERE match_id=item.match_id AND round=item.round;
    DELETE FROM target_private.two_player_moves
      WHERE match_id=item.match_id AND round=item.round;
    IF NOT FOUND THEN RAISE EXCEPTION 'Replay disappeared during pruning'; END IF;
    released_bytes:=released_bytes+item.charged_bytes-item.credit_bytes;
    removed_count:=removed_count+1;
  END LOOP;
  IF released_bytes>0 THEN
    UPDATE target_private.system_state
    SET logical_bytes=logical_bytes-released_bytes
    WHERE singleton AND logical_bytes>=released_bytes;
    IF NOT FOUND THEN RAISE EXCEPTION 'Replay quota counter mismatch'; END IF;
  END IF;
  RETURN removed_count;
END $prune$;
REVOKE ALL ON FUNCTION target_private.two_player_prune_replays(integer)
  FROM PUBLIC,anon,authenticated,service_role;

-- Existing pg_cron project runs minute-based settlement maintenance.
-- Prune at 13:15 JST daily, retaining one full day for the final-shot animation
-- and reconnect/retry, without deleting match summaries or financial receipts.
DO $cron$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='target-2player-prune-replays') THEN
      PERFORM cron.schedule('target-2player-prune-replays','15 4 * * *',
        'SELECT target_private.two_player_prune_replays(1500)');
    END IF;
  END IF;
END $cron$;

-- Make the new guarded read-only RPC discoverable by the existing PostgREST API.
NOTIFY pgrst, 'reload schema';
