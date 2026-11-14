-- Strict read-only postflight for the wallet-sized stake release.
-- No credentials, identities or individual financial values are returned.
BEGIN READ ONLY;
DO $verify$
DECLARE expected record; relation text; role_name text;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public.two_player_rpc(text,text,jsonb)','a31ef2f093dc1dc3204cd9683047c17d'),
    ('public.two_player_lobby_rpc(text,text,jsonb)','af35ca40298855630d51db1f7d515d37'),
    ('target_private.two_player_money(uuid,uuid,text,text,bigint)','536c0e60d75fca1a97058633b9f73138'),
    ('target_private.two_player_money(uuid,uuid,text,text,integer)','f19948e4a15087127038853897220831'),
    ('target_private.two_player_lobby_pair(text,uuid,uuid,bigint,integer,bigint,integer)','24fcbe80e85bdfbce70bbb26351db993'),
    ('target_private.two_player_lobby_pair(text,uuid,uuid,integer,integer,integer,integer)','ec2f3a2af81c9ec2f90b28dd4c68d71a'),
    ('target_private.two_player_wallet_headroom()','02ea9fa563451bce080961a168c93fcb'),
    ('target_private.two_player_settle(uuid,text,text,text)','bcd0fae5b63e4ae7695f765551516843'),
    ('target_private.two_player_permanent()','1a98be9595a7c9e7d35d62ae272ba941'),
    ('target_private.two_player_shared_formation()','e64bb7f29197d8ff6df1b19983dc7704'),
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
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=expected.signature::regprocedure) IS DISTINCT FROM expected.hash AND NOT EXISTS(
      SELECT 1 FROM (VALUES
        ('public.two_player_rpc(text,text,jsonb)','07bd70771529b5749c49810f8feb2f08'),
        ('target_private.two_player_settle(uuid,text,text,text)','21c21d2d34d4ffda68263fde9e9aa7ba'),
        ('target_private.two_player_match_dto(uuid,boolean)','47fb22ebd189fe67249b1ba2bb127f35')
      ) newer(signature,hash) WHERE newer.signature=expected.signature AND
        newer.hash=(SELECT md5(prosrc) FROM pg_proc WHERE oid=expected.signature::regprocedure)) THEN
      RAISE EXCEPTION 'Wallet stake or unchanged gameplay/financial boundary differs: %',expected.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES
    ('two_player_matches','host_offer'),('two_player_matches','guest_offer'),
    ('two_player_matches','stake'),('two_player_matches','escrow'),
    ('two_player_wallet_events','delta'),('two_player_lobby_queue','stake'),('two_player_lobby_invites','stake')
  ) x(relation,column_name) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=('target_private.'||expected.relation)::regclass
      AND a.attname=expected.column_name AND a.atttypid='bigint'::regtype AND NOT a.attisdropped) THEN
      RAISE EXCEPTION 'Stake column is not bigint: %.%',expected.relation,expected.column_name; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES
    ('two_player_matches','two_player_matches_host_offer_check','10000000000000'),
    ('two_player_matches','two_player_matches_guest_offer_check','10000000000000'),
    ('two_player_matches','two_player_matches_stake_check','10000000000000'),
    ('two_player_matches','two_player_matches_escrow_check','20000000000000'),
    ('two_player_wallet_events','two_player_wallet_events_delta_check','20000000000000'),
    ('two_player_lobby_queue','two_player_lobby_queue_stake_check','10000000000000'),
    ('two_player_lobby_invites','two_player_lobby_invites_stake_check','10000000000000')
  ) x(relation,constraint_name,maximum) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=('target_private.'||expected.relation)::regclass
      AND c.conname=expected.constraint_name AND c.contype='c' AND c.convalidated
      AND position(expected.maximum IN pg_get_constraintdef(c.oid))>0) THEN
      RAISE EXCEPTION 'Wallet-sized stake constraint missing or unvalidated: %',expected.constraint_name; END IF;
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['two_player_matches','two_player_wallet_events','two_player_lobby_queue','two_player_lobby_invites'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=('target_private.'||relation)::regclass) THEN
      RAISE EXCEPTION 'Stake table RLS is missing: %',relation; END IF;
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF has_table_privilege(role_name,'target_private.'||relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
        RAISE EXCEPTION 'API role can access a private stake table: % %',role_name,relation; END IF;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='target_private' AND p.proname IN ('two_player_money','two_player_lobby_pair','two_player_wallet_headroom')
    AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR
      has_function_privilege('service_role',p.oid,'EXECUTE'))) THEN
    RAISE EXCEPTION 'API role can invoke a private financial or pairing helper'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='two_player_wallet_headroom' AND NOT tgisinternal AND tgenabled='O'
    AND tgrelid='target_private.profiles'::regclass AND tgfoid='target_private.two_player_wallet_headroom()'::regprocedure) OR
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='two_player_wallet_events_permanent' AND NOT tgisinternal AND tgenabled='O'
    AND tgrelid='target_private.two_player_wallet_events'::regclass AND tgfoid='target_private.two_player_permanent()'::regprocedure) THEN
    RAISE EXCEPTION 'Wallet headroom or immutable-event trigger is missing'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.two_player_matches m LEFT JOIN LATERAL(
    SELECT coalesce(sum(e.delta),0) AS delta FROM target_private.two_player_wallet_events e WHERE e.match_id=m.id) ledger ON true
    WHERE ledger.delta+m.escrow<>0) THEN RAISE EXCEPTION 'Soccer ledger and escrow do not conserve funds'; END IF;
  IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles p USING(member_id)
    WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points)
      IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)) THEN
    RAISE EXCEPTION 'Wallet history no longer reconciles'; END IF;
END $verify$;
SELECT 'two_player_unlimited_stakes_postflight_passed' AS result;
ROLLBACK;
