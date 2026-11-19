BEGIN READ ONLY;
DO $audit$
BEGIN
 IF to_regprocedure('public.target_badge_rpc(text,text,jsonb)') IS NULL OR
    to_regclass('target_private.section_mastery_achievements') IS NULL THEN
   RAISE EXCEPTION 'Target mastery badge contract missing'; END IF;
 IF (SELECT md5(p.prosrc) FROM pg_proc p
    WHERE p.oid='public.target_badge_rpc(text,text,jsonb)'::regprocedure)
    IS NULL OR
    (SELECT relrowsecurity FROM pg_class WHERE oid='target_private.section_mastery_achievements'::regclass) IS NOT TRUE
 THEN RAISE EXCEPTION 'Private mastery entitlements not protected'; END IF;
 IF (public.target_badge_rpc('invalid','list','{}'::jsonb)#>>'{error,code}') IS DISTINCT FROM 'RPC_FORBIDDEN'
 THEN RAISE EXCEPTION 'Server-secret check failed'; END IF;
 IF EXISTS(SELECT 1 FROM (
   SELECT 'anon'::text AS role UNION ALL SELECT 'authenticated' UNION ALL SELECT 'service_role'
 ) roles WHERE has_table_privilege(roles.role,'target_private.section_mastery_achievements','SELECT'))
 THEN RAISE EXCEPTION 'Raw private achievements exposed'; END IF;
 IF EXISTS(SELECT 1 FROM target_private.two_player_matches m
   WHERE m.escrow+coalesce((SELECT sum(e.delta) FROM target_private.two_player_wallet_events e
     WHERE e.match_id=m.id),0)<>0)
 THEN RAISE EXCEPTION 'Soccer wallet changed unexpectedly'; END IF;
 IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) f
   JOIN target_private.profiles p USING(member_id)
   WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points)
    IS DISTINCT FROM (f.total_points,f.spent_points,f.calculus_points,f.birthday_points,f.casino_net,f.calculus_forgiven_points))
 THEN RAISE EXCEPTION 'Wallet accounting changed'; END IF;
END $audit$;
SELECT 'target_mastery_badges_postflight_passed' AS result;
ROLLBACK;