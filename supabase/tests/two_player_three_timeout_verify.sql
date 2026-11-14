-- Production read-only safety check for three own-turn timeouts.
BEGIN READ ONLY;
DO $verify$
DECLARE x record;
BEGIN
  FOR x IN SELECT * FROM (VALUES
     ('target_private.two_player_advance_turn(uuid,integer)','5c3589f589e15933d14d04eaf4a9e045'),
     ('target_private.two_player_match_dto(uuid,boolean)','4bbe5ed5165bd777d3fe0655515b3a16'),
     ('public.two_player_ranking_rpc(text,text,jsonb)','9b1138b270ae62cce61dcca9354cdb77'),
     ('target_private.two_player_settle(uuid,text,text,text)','21c21d2d34d4ffda68263fde9e9aa7ba'),
     ('target_private.two_player_validate_money()','6ea6717846d69a24a91e47758f8818b5')
  ) AS guards(signature,hash) LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=x.signature::regprocedure) IS DISTINCT FROM x.hash
    THEN RAISE EXCEPTION 'Soccer timeout or settlement implementation changed: %',x.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='two_player_reset_timeout_streak'
    AND tgenabled='O' AND tgrelid='target_private.two_player_moves'::regclass) THEN
    RAISE EXCEPTION 'Verified input must clear the individual streak'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.two_player_matches WHERE
    host_timeout_streak NOT BETWEEN 0 AND 3 OR guest_timeout_streak NOT BETWEEN 0 AND 3) THEN
    RAISE EXCEPTION 'Timeout values invalid'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.two_player_matches
    WHERE reason='three_timeouts' AND
      (status<>'finished' OR winner NOT IN ('host','guest') OR
       (winner='host' AND guest_timeout_streak<>3) OR
       (winner='guest' AND host_timeout_streak<>3) OR escrow<>0)) THEN
    RAISE EXCEPTION 'Forfeit does not preserve final result and settlement'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.two_player_matches m
    WHERE m.escrow+coalesce((SELECT sum(e.delta) FROM target_private.two_player_wallet_events e
      WHERE e.match_id=m.id),0)<>0) THEN
    RAISE EXCEPTION 'Mismatch in soccer wallet reserves and settlements'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) f
    JOIN target_private.profiles p USING(member_id)
    WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points)
    IS DISTINCT FROM
      (f.total_points,f.spent_points,f.calculus_points,f.birthday_points,f.casino_net,f.calculus_forgiven_points)) THEN
    RAISE EXCEPTION 'Shared wallet changed unexpectedly'; END IF;
  IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='two-player-soccer-forfeit-turns'
    AND schedule='* * * * *') THEN
    RAISE EXCEPTION 'Minute-by-minute forfeit checking is missing'; END IF;
  IF has_function_privilege('anon','target_private.two_player_advance_turn(uuid,integer)','EXECUTE')
     OR has_function_privilege('authenticated','target_private.two_player_advance_turn(uuid,integer)','EXECUTE')
     OR has_function_privilege('service_role','target_private.two_player_advance_turn(uuid,integer)','EXECUTE')
     OR has_function_privilege('anon','target_private.two_player_reset_timeout_streak()','EXECUTE')
  THEN RAISE EXCEPTION 'Private soccer timeout functions unexpectedly exposed'; END IF;
END $verify$;
SELECT 'three_timeout_forfeit_postflight_passed' AS result;
ROLLBACK;
