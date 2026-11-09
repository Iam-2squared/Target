-- Read-only postflight. No credentials or member-specific financial data.
BEGIN READ ONLY;
DO $verify$
DECLARE relation text; role_name text; required_budget bigint;
BEGIN
  FOREACH relation IN ARRAY ARRAY['two_player_credentials','two_player_matches','two_player_participants',
    'two_player_moves','two_player_wallet_events','two_player_requests','two_player_rates'] LOOP
    IF (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='target_private' AND c.relname=relation) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Soccer table lacks RLS: %',relation; END IF;
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF has_table_privilege(role_name,'target_private.'||relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
        RAISE EXCEPTION 'API role has private soccer access: % %',role_name,relation; END IF;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM target_private.two_player_matches m LEFT JOIN LATERAL(
    SELECT coalesce(sum(e.delta),0) delta FROM target_private.two_player_wallet_events e WHERE e.match_id=m.id) events ON true
    WHERE events.delta+m.escrow<>0) THEN
    RAISE EXCEPTION 'Soccer balance plus escrow is not conserved'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.two_player_wallet_events e JOIN target_private.two_player_matches m ON m.id=e.match_id
    WHERE e.member_id NOT IN (m.host_id,m.guest_id) OR
      (e.phase='reserve' AND e.delta<>-m.stake) OR
      (e.phase='settle' AND e.delta<>(CASE WHEN m.winner='host' THEN CASE WHEN e.member_id=m.host_id THEN 2*m.stake ELSE 0 END
        WHEN m.winner='guest' THEN CASE WHEN e.member_id=m.guest_id THEN 2*m.stake ELSE 0 END ELSE m.stake END))) THEN
    RAISE EXCEPTION 'Soccer ledger event differs from the agreed stake or winner'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.two_player_matches m WHERE m.stake IS NOT NULL AND
    ((SELECT count(*) FROM target_private.two_player_wallet_events e WHERE e.match_id=m.id AND e.phase='reserve')<>2 OR
      (m.status IN ('finished','cancelled') AND
       (SELECT count(*) FROM target_private.two_player_wallet_events e WHERE e.match_id=m.id AND e.phase='settle')<>2))) THEN
    RAISE EXCEPTION 'Soccer funding or settlement receipt is incomplete'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.two_player_participants a JOIN target_private.two_player_matches m ON m.id=a.match_id
    WHERE m.status NOT IN ('waiting','playing') OR (a.member_id<>m.host_id AND a.member_id IS DISTINCT FROM m.guest_id)) OR
    EXISTS(SELECT 1 FROM target_private.two_player_matches m WHERE m.status IN ('waiting','playing') AND
      (NOT EXISTS(SELECT 1 FROM target_private.two_player_participants a WHERE a.match_id=m.id AND a.member_id=m.host_id) OR
        (m.guest_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM target_private.two_player_participants a WHERE a.match_id=m.id AND a.member_id=m.guest_id)))) THEN
    RAISE EXCEPTION 'Soccer active participant slots disagree with matches'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles p USING(member_id)
    WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points)
      IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) THEN
    RAISE EXCEPTION 'Wallet components do not reconcile with permanent history'; END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_games_rpc(text,text,jsonb)'::regprocedure)
      IS DISTINCT FROM '71ddbc56e79a79dcd8a046d556b73a59' THEN
    RAISE EXCEPTION 'Retired gambling boundary changed'; END IF;
  SELECT (SELECT count(*)*16384 FROM target_private.two_player_matches)
    +(SELECT coalesce(sum(charged_bytes),0) FROM target_private.two_player_moves)
    +(SELECT count(*)*512 FROM target_private.two_player_requests WHERE action NOT IN ('resolve','cancel'))
    +(SELECT count(*)*256 FROM target_private.two_player_rates) INTO required_budget;
  IF (SELECT logical_bytes FROM target_private.system_state WHERE singleton)<required_budget THEN
    RAISE EXCEPTION 'Soccer logical storage budget is undercharged'; END IF;
END $verify$;
SELECT 'two_player_soccer_postflight_passed' AS result;
ROLLBACK;
