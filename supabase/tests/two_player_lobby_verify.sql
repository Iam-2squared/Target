-- Read-only postflight for online presence, invitations and FIFO matchmaking.
-- No keys, pupil names, account tokens or member-specific balances are returned.
BEGIN READ ONLY;
DO $verify$
DECLARE relation text; role_name text; required_budget bigint;
BEGIN
  FOREACH relation IN ARRAY ARRAY['two_player_lobby_presence','two_player_lobby_queue',
    'two_player_lobby_invites','two_player_lobby_requests','two_player_lobby_rates'] LOOP
    IF (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='target_private' AND c.relname=relation) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Lobby table lacks RLS: %',relation; END IF;
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF has_table_privilege(role_name,'target_private.'||relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
        RAISE EXCEPTION 'API role has private lobby access: % %',role_name,relation; END IF;
    END LOOP;
  END LOOP;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.two_player_rpc(text,text,jsonb)'::regprocedure)
      IS DISTINCT FROM 'b7a4c7594a8191dce5b6f677773616df' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)
      IS DISTINCT FROM '8e69577732c1f54b2dae637b87aa3fd6' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_games_rpc(text,text,jsonb)'::regprocedure)
      IS DISTINCT FROM '71ddbc56e79a79dcd8a046d556b73a59' THEN
    RAISE EXCEPTION 'Soccer, financial projection or retired gambling boundary changed'; END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='target_private' AND p.proname LIKE 'two_player_lobby_%'
      AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR
        has_function_privilege('service_role',p.oid,'EXECUTE'))) THEN
    RAISE EXCEPTION 'API role can invoke a private lobby helper'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles p USING(member_id)
    WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points)
      IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) THEN
    RAISE EXCEPTION 'Wallet history no longer reconciles'; END IF;
  SELECT (SELECT count(*)*16384 FROM target_private.two_player_matches)
    +(SELECT coalesce(sum(charged_bytes),0) FROM target_private.two_player_moves)
    +(SELECT count(*)*512 FROM target_private.two_player_requests WHERE action NOT IN ('resolve','cancel'))
    +(SELECT count(*)*256 FROM target_private.two_player_rates)
    +(SELECT count(*)*512 FROM target_private.two_player_lobby_presence)
    +(SELECT count(*)*512 FROM target_private.two_player_lobby_queue)
    +(SELECT count(*)*1024 FROM target_private.two_player_lobby_invites)
    +(SELECT count(*)*512 FROM target_private.two_player_lobby_requests)
    +(SELECT count(*)*256 FROM target_private.two_player_lobby_rates) INTO required_budget;
  IF (SELECT logical_bytes FROM target_private.system_state WHERE singleton)<required_budget THEN
    RAISE EXCEPTION 'Soccer and lobby storage budgets are undercharged'; END IF;
END $verify$;
SELECT 'two_player_lobby_postflight_passed' AS result;
ROLLBACK;
