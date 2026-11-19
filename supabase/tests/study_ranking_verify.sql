BEGIN TRANSACTION READ ONLY;
DO $verify$
DECLARE source text;
BEGIN
 SELECT prosrc INTO source FROM pg_proc WHERE oid='public.target_rpc(text,text,jsonb)'::regprocedure;
 IF md5(source)<>'105637cfd295b787caa12936894e2690' THEN
  RAISE EXCEPTION 'Target study-ranking RPC does not match the reviewed source';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)<>'421a0a0c6a859a8eb874adeeaaa5565d' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_state(target_private.profiles)'::regprocedure)<>'bc5164b65cd12933819abf9e28f13e3b' THEN
  RAISE EXCEPTION 'An unrelated wallet calculation changed';
 END IF;
 IF NOT(SELECT prosecdef AND proconfig=ARRAY['search_path=pg_catalog, target_private'] FROM pg_proc WHERE oid='public.target_rpc(text,text,jsonb)'::regprocedure) THEN
  RAISE EXCEPTION 'Existing Target RPC privilege boundary changed';
 END IF;
 IF EXISTS(SELECT 1 FROM target_private.profiles
   WHERE total_points-calculus_points-birthday_points-casino_net-calculus_forgiven_points<0) THEN
  RAISE EXCEPTION 'Existing study component is invalid';
 END IF;
END $verify$;
SELECT jsonb_build_object('checkedAt',clock_timestamp(),'verification','study_only_ranking_verified',
 'profilesHash',(SELECT md5(coalesce(string_agg(to_jsonb(p)::text,'' ORDER BY member_id),'')) FROM target_private.profiles p),
 'answersHash',(SELECT md5(coalesce(string_agg(to_jsonb(a)::text,'' ORDER BY quiz_id,question_id),'')) FROM target_private.answers a),
 'systemStateHash',(SELECT md5(to_jsonb(s)::text) FROM target_private.system_state s WHERE singleton),
 'profileCount',(SELECT count(*) FROM target_private.profiles),
 'eligibleCount',(SELECT count(*) FROM target_private.profiles WHERE answered_count>0),
 'functionBodyMD5',(SELECT md5(prosrc) FROM pg_proc WHERE oid='public.target_rpc(text,text,jsonb)'::regprocedure),
 'financeProjectionBodyMD5',(SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure),
 'walletStateBodyMD5',(SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_state(target_private.profiles)'::regprocedure),
 'metadataOnly',true) AS verification;
ROLLBACK;
