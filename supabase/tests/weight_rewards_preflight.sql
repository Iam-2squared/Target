BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
 IF to_regclass('target_private.weight_reward_receipts') IS NOT NULL OR to_regprocedure('public.target_weight_rpc(text,text,jsonb)') IS NOT NULL THEN
  RAISE EXCEPTION 'Weight rewards are already installed; inspect before attempting to reapply';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)<>'bd93399757a066fdfb8f35e7e29af2dc' THEN
  RAISE EXCEPTION 'Target finance source differs from reviewed baseline';
 END IF;
END $preflight$;
SELECT jsonb_build_object('checkedAt',clock_timestamp(),
 'profilesHash',(SELECT md5(coalesce(string_agg(to_jsonb(p)::text,'' ORDER BY p.member_id),'')) FROM target_private.profiles p),
 'projectionBodyMD5',(SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure),
 'financeProjectionMismatchCount',(SELECT count(*) FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) f USING(member_id)
   WHERE (p.total_points,p.spent_points,p.casino_net) IS DISTINCT FROM(f.total_points,f.spent_points,f.casino_net)),
 'logicalBytes',(SELECT logical_bytes FROM target_private.system_state WHERE singleton),
 'profileCount',(SELECT count(*) FROM target_private.profiles)) AS preflight;
ROLLBACK;
