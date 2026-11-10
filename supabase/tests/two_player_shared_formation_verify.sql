-- Read-only postflight. Never returns credentials, names or individual balances.
BEGIN READ ONLY;
DO $verify$
DECLARE role_name text; previous_source text; current_source text;
BEGIN
  SELECT prosrc INTO current_source FROM pg_proc WHERE oid='public.two_player_rpc(text,text,jsonb)'::regprocedure;
  previous_source:=replace(current_source,
    '  IF p_action=''formation'' THEN'||chr(10)||
    '    RETURN target_private.error_result(409,''FORMATION_FIXED'',''陣形は対戦ごとに自動で決まります。'');'||chr(10)||
    '  END IF;'||chr(10),'');
  -- Both reviewed generations are accepted so the historical migration suite
  -- remains runnable; the current turn-clock postflight pins every new helper.
  IF md5(current_source) NOT IN ('640f070ee4aae1d25910ab58b8284648','625162362bf7d46fa98b19f254ee5671') OR
    (md5(current_source)='640f070ee4aae1d25910ab58b8284648' AND md5(previous_source) IS DISTINCT FROM 'b7a4c7594a8191dce5b6f677773616df') OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.two_player_lobby_pair(text,uuid,uuid,integer,integer,integer,integer)'::regprocedure)
      IS DISTINCT FROM '5161a2f3b98b94e07d0927a28093893f' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.two_player_shared_formation()'::regprocedure)
      IS DISTINCT FROM 'e64bb7f29197d8ff6df1b19983dc7704' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.two_player_initial_state(integer,integer)'::regprocedure)
      NOT IN ('2358e90576964049d2979b1c7d1b81d5','cac093826b5065ce31f96840cfa493ac') OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)
      IS DISTINCT FROM '8e69577732c1f54b2dae637b87aa3fd6' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_games_rpc(text,text,jsonb)'::regprocedure)
      IS DISTINCT FROM '71ddbc56e79a79dcd8a046d556b73a59' THEN
    RAISE EXCEPTION 'Shared random formation or unchanged financial boundary differs'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='target_private.two_player_matches'::regclass
    AND tgname='two_player_shared_formation' AND NOT tgisinternal AND tgenabled='O' AND tgtype=23
    AND tgfoid='target_private.two_player_shared_formation()'::regprocedure) THEN
    RAISE EXCEPTION 'Random formation INSERT/UPDATE trigger is missing or disabled'; END IF;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF has_function_privilege(role_name,'target_private.two_player_shared_formation()','EXECUTE') OR
      has_function_privilege(role_name,'target_private.two_player_lobby_pair(text,uuid,uuid,integer,integer,integer,integer)','EXECUTE') OR
      has_table_privilege(role_name,'target_private.two_player_matches','INSERT,UPDATE,DELETE,TRIGGER') THEN
      RAISE EXCEPTION 'API role can bypass the private formation boundary'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM target_private.two_player_matches m LEFT JOIN LATERAL(
    SELECT coalesce(sum(e.delta),0) AS delta FROM target_private.two_player_wallet_events e WHERE e.match_id=m.id) ledger ON true
    WHERE ledger.delta+m.escrow<>0) THEN
    RAISE EXCEPTION 'Soccer ledger and escrow no longer conserve funds'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles p USING(member_id)
    WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points)
      IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) THEN
    RAISE EXCEPTION 'Wallet history no longer reconciles'; END IF;
END $verify$;
SELECT 'two_player_shared_formation_postflight_passed' AS result;
ROLLBACK;
