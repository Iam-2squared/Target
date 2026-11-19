BEGIN TRANSACTION READ ONLY;
DO $verify$
DECLARE role_name text; signature text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)<>'421a0a0c6a859a8eb874adeeaaa5565d' THEN
  RAISE EXCEPTION 'Weight finance projection does not match reviewed source';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='target_private.weight_reward_receipts'::regclass AND relrowsecurity) OR
   NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='target_private.weight_reward_receipts'::regclass AND contype='p' AND convalidated) OR
   NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='target_private.weight_reward_receipts'::regclass AND tgname='weight_reward_receipt_permanent' AND tgenabled='O') THEN
  RAISE EXCEPTION 'Weight receipts are missing their privacy or permanence guards';
 END IF;
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_table_privilege(role_name,'target_private.weight_reward_receipts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
   RAISE EXCEPTION 'Weight receipt table is exposed to %',role_name;
  END IF;
  FOREACH signature IN ARRAY ARRAY['target_private.weight_income(uuid)','target_private.weight_status(uuid)','target_private.protect_weight_reward_receipt()'] LOOP
   IF has_function_privilege(role_name,signature,'EXECUTE') THEN RAISE EXCEPTION 'Weight helper exposed to %: %',role_name,signature; END IF;
  END LOOP;
 END LOOP;
 IF NOT has_function_privilege('anon','public.target_weight_rpc(text,text,jsonb)','EXECUTE') OR
   has_function_privilege('service_role','public.target_weight_rpc(text,text,jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'Weight RPC has unexpected caller grants';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid IN('public.target_weight_rpc(text,text,jsonb)'::regprocedure,'target_private.weight_income(uuid)'::regprocedure,'target_private.weight_status(uuid)'::regprocedure,'target_private.protect_weight_reward_receipt()'::regprocedure) AND proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']) THEN
  RAISE EXCEPTION 'Weight function search_path is not pinned';
 END IF;
 IF NOT(SELECT prosecdef FROM pg_proc WHERE oid='public.target_weight_rpc(text,text,jsonb)'::regprocedure) OR
   EXISTS(SELECT 1 FROM pg_proc WHERE oid IN('target_private.weight_income(uuid)'::regprocedure,'target_private.weight_status(uuid)'::regprocedure,'target_private.protect_weight_reward_receipt()'::regprocedure) AND prosecdef) THEN
  RAISE EXCEPTION 'Weight function privilege boundary changed';
 END IF;
END $verify$;
SELECT jsonb_build_object('verification','weight_rewards_verified','conversionRate',1000,
 'receiptCount',(SELECT count(*) FROM target_private.weight_reward_receipts),
 'financeProjectionBodyMD5',(SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure),
 'privateLedger',true,'metadataOnly',true) AS verification;
ROLLBACK;
