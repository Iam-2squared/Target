BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_rpc(text,text,jsonb)'::regprocedure)<>'b23ee976ec11ad3d3622d0011b1ec810' THEN
  RAISE EXCEPTION 'Target RPC differs from the reviewed study-ranking baseline';
 END IF;
 IF EXISTS(SELECT 1 FROM target_private.profiles
   WHERE total_points-calculus_points-birthday_points-casino_net-calculus_forgiven_points<0) THEN
  RAISE EXCEPTION 'Existing study component is invalid';
 END IF;
END $preflight$;
SELECT jsonb_build_object('checkedAt',clock_timestamp(),
 'profilesHash',(SELECT md5(coalesce(string_agg(to_jsonb(p)::text,'' ORDER BY member_id),'')) FROM target_private.profiles p),
 'answersHash',(SELECT md5(coalesce(string_agg(to_jsonb(a)::text,'' ORDER BY quiz_id,question_id),'')) FROM target_private.answers a),
 'systemStateHash',(SELECT md5(to_jsonb(s)::text) FROM target_private.system_state s WHERE singleton),
 'profileCount',(SELECT count(*) FROM target_private.profiles),
 'eligibleCount',(SELECT count(*) FROM target_private.profiles WHERE answered_count>0),
 'functionBodyMD5',(SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_rpc(text,text,jsonb)'::regprocedure),
 'financeProjectionBodyMD5',(SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure),
 'walletStateBodyMD5',(SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_state(target_private.profiles)'::regprocedure)) AS verification;
ROLLBACK;
