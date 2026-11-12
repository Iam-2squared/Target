-- Read-only postflight. No player names or balances are returned.
BEGIN READ ONLY;
DO $audit$
BEGIN
 IF to_regclass('target_private.two_player_social_viewers') IS NULL OR
    to_regclass('target_private.two_player_social_stamps') IS NULL OR
    to_regprocedure('public.two_player_social_rpc(text,text,jsonb)') IS NULL
 THEN RAISE EXCEPTION 'Missing soccer social feature'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class
    WHERE oid='target_private.two_player_social_viewers'::regclass AND relrowsecurity)
 OR NOT EXISTS(SELECT 1 FROM pg_class
    WHERE oid='target_private.two_player_social_stamps'::regclass AND relrowsecurity)
 THEN RAISE EXCEPTION 'Social tables require RLS'; END IF;
 IF EXISTS(SELECT 1 FROM target_private.two_player_social_stamps
   WHERE stamp_id NOT BETWEEN 1 AND 8 OR actor_side NOT IN ('host','guest'))
 THEN RAISE EXCEPTION 'Unexpected stamp record'; END IF;
 IF EXISTS(SELECT 1 FROM target_private.two_player_social_viewers v
   JOIN target_private.two_player_matches m ON m.id=v.match_id
   WHERE v.member_id IN (m.host_id,m.guest_id))
 THEN RAISE EXCEPTION 'Players unexpectedly counted as spectators'; END IF;
 IF EXISTS(SELECT 1 FROM target_private.two_player_matches m
   WHERE m.escrow+coalesce((SELECT sum(e.delta) FROM target_private.two_player_wallet_events e
     WHERE e.match_id=m.id),0)<>0)
 THEN RAISE EXCEPTION 'Match wallet receipts not conserved'; END IF;
 IF EXISTS(SELECT 1 FROM target_private.wallet_finance_projection(NULL) f
   JOIN target_private.profiles p USING(member_id)
   WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points)
   IS DISTINCT FROM
         (f.total_points,f.spent_points,f.calculus_points,f.birthday_points,f.casino_net,f.calculus_forgiven_points))
 THEN RAISE EXCEPTION 'Wallet finance projection changed'; END IF;
 IF EXISTS(SELECT 1 FROM (
   SELECT 'anon'::text AS role UNION ALL SELECT 'authenticated' UNION ALL SELECT 'service_role'
 ) roles WHERE has_table_privilege(roles.role,'target_private.two_player_social_viewers','SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege(roles.role,'target_private.two_player_social_stamps','SELECT,INSERT,UPDATE,DELETE')
    OR has_function_privilege(roles.role,'target_private.two_player_social_cleanup()','EXECUTE'))
 THEN RAISE EXCEPTION 'Private social data exposed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
   IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='two-player-social-cleanup')
   THEN RAISE EXCEPTION 'Social TTL cleanup schedule missing'; END IF;
 END IF;
 IF (public.two_player_social_rpc('invalid','list','{}'::jsonb)#>>'{error,code}')
     IS DISTINCT FROM 'RPC_FORBIDDEN'
 THEN RAISE EXCEPTION 'Credential check failed'; END IF;
END $audit$;
SELECT 'two_player_social_postflight_passed' AS result;
ROLLBACK;
