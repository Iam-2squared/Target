-- Read-only production postflight. No identities, credentials or balances returned.
BEGIN READ ONLY;
DO $verify$
DECLARE expected record; role_name text; definition text;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public.two_player_rpc(text,text,jsonb)','625162362bf7d46fa98b19f254ee5671'),
    ('target_private.two_player_initial_state(integer,integer)','cac093826b5065ce31f96840cfa493ac'),
    ('target_private.two_player_match_dto(uuid,boolean)','b746278bd91fbdc8a325a2372dc6d1b3'),
    ('target_private.two_player_expire(uuid,integer)','ff595d6a469ce8c7a3156b719d0db6fa'),
    ('target_private.two_player_move_version()','bc03f5e0c41d3f73b6da82d06e0f4c04'),
    ('target_private.two_player_turn_clock()','8c5857cb963477c3432cf02787b40db5'),
    ('target_private.two_player_advance_turn(uuid,integer)','a25258beceff1f0747c97dd275bc333b'),
    ('target_private.two_player_clear_goal_areas(jsonb)','558a4753bd811842077288d2a3417491'),
    ('target_private.wallet_finance_projection(timestamptz)','8e69577732c1f54b2dae637b87aa3fd6'),
    ('public.target_games_rpc(text,text,jsonb)','71ddbc56e79a79dcd8a046d556b73a59')
  ) x(signature,hash) LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=expected.signature::regprocedure) IS DISTINCT FROM expected.hash AND NOT
      (expected.signature='public.two_player_rpc(text,text,jsonb)' AND
        (SELECT md5(prosrc) FROM pg_proc WHERE oid=expected.signature::regprocedure)='a31ef2f093dc1dc3204cd9683047c17d') THEN
      RAISE EXCEPTION 'Turn-rule or unchanged financial boundary differs: %',expected.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='two_player_turn_clock' AND NOT tgisinternal AND tgenabled='O'
    AND tgrelid='target_private.two_player_matches'::regclass AND tgfoid='target_private.two_player_turn_clock()'::regprocedure) THEN
    RAISE EXCEPTION 'Turn clock trigger is missing or disabled'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.two_player_matches WHERE
    (status='playing' AND (turn_started_at IS NULL OR turn_expires_at IS NULL OR turn_expires_at<>turn_started_at+interval '60 seconds')) OR
    (status<>'playing' AND (turn_started_at IS NOT NULL OR turn_expires_at IS NOT NULL))) THEN
    RAISE EXCEPTION 'Turn deadline invariant differs'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='target_private.two_player_matches'::regclass
    AND conname='two_player_turn_clock_check' AND convalidated) THEN
    RAISE EXCEPTION 'Turn deadline constraint is not validated'; END IF;
  SELECT prosrc INTO definition FROM pg_proc WHERE oid='public.two_player_rpc(text,text,jsonb)'::regprocedure;
  IF position('forty_moves' IN definition)>0 OR position('>=256' IN definition)>0 OR position('BETWEEN 1 AND 40' IN definition)>0 THEN
    RAISE EXCEPTION 'Old gameplay turn/request cap remains'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.two_player_matches m WHERE m.status='playing' AND
    NOT EXISTS(SELECT 1 FROM target_private.two_player_moves x WHERE x.match_id=m.id AND x.round=m.round AND x.resolved_at IS NULL) AND
    target_private.two_player_clear_goal_areas(m.state) IS DISTINCT FROM m.state) THEN
    RAISE EXCEPTION 'Settled next-turn state still contains a goal-area piece'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.two_player_moves x WHERE x.turn_rules AND x.resolved_at IS NOT NULL AND x.goal IS NULL AND
    (x.state IS DISTINCT FROM target_private.two_player_clear_goal_areas(x.state) OR
     x.frames->(jsonb_array_length(x.frames)-1) IS DISTINCT FROM x.state)) THEN
    RAISE EXCEPTION 'Canonical settled state and final replay frame disagree'; END IF;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF has_function_privilege(role_name,'target_private.two_player_turn_clock()','EXECUTE') OR
      has_function_privilege(role_name,'target_private.two_player_advance_turn(uuid,integer)','EXECUTE') OR
      has_function_privilege(role_name,'target_private.two_player_clear_goal_areas(jsonb)','EXECUTE') OR
      has_table_privilege(role_name,'target_private.two_player_matches','INSERT,UPDATE,DELETE,TRIGGER') OR
      has_table_privilege(role_name,'target_private.two_player_moves','INSERT,UPDATE,DELETE,TRIGGER') THEN
      RAISE EXCEPTION 'API role can bypass the turn-rule boundary'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM target_private.two_player_matches m LEFT JOIN LATERAL(
    SELECT coalesce(sum(e.delta),0) AS delta FROM target_private.two_player_wallet_events e WHERE e.match_id=m.id) ledger ON true
    WHERE ledger.delta+m.escrow<>0) THEN RAISE EXCEPTION 'Soccer ledger and escrow do not conserve funds'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles p USING(member_id)
    WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points)
      IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) THEN
    RAISE EXCEPTION 'Wallet history no longer reconciles'; END IF;
END $verify$;
SELECT 'two_player_turn_clock_postflight_passed' AS result;
ROLLBACK;
