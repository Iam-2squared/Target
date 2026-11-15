-- Strict read-only postflight for 20261115084425_target_pve_challenge_levels.
-- No fixture identities, secrets, rewards, cleanup, or wallet writes are performed.
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(991101);
DO $verify$
DECLARE item record; actual text; helper regprocedure; role_name text; charged bigint; budget bigint;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('public.target_challenge_rpc(text,text,jsonb)','40f9c42130bff6ea176973f5ba7d9c0e',true),
  ('target_private.challenge_dto(uuid,uuid)','87e4cd04309f220801990b5161e4f48a',false),
  ('target_private.challenge_tick(uuid,timestamptz)','ab5dd92b8d57974dca63d8ca65901eb4',false),
  ('target_private.challenge_storage_charge()','69be621da1580b84ed1d793cc7f95737',false),
  ('target_private.wallet_finance_projection(timestamptz)','eafe8da70cbd3912d5310c083bdc303f',false)
 ) expected(signature,digest,definer) LOOP
  helper:=to_regprocedure(item.signature);
  IF helper IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=helper AND md5(prosrc)=item.digest
    AND prosecdef=item.definer AND proconfig=ARRAY['search_path=pg_catalog']) THEN
   RAISE EXCEPTION 'Challenge function hash/security mismatch: %',item.signature; END IF;
  IF item.signature NOT LIKE 'public.%' THEN
   FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF has_function_privilege(role_name,helper,'EXECUTE') THEN
     RAISE EXCEPTION 'Private challenge helper is executable by %: %',role_name,item.signature; END IF;
   END LOOP;
  END IF;
 END LOOP;
 IF NOT has_function_privilege('anon','public.target_challenge_rpc(text,text,jsonb)','EXECUTE') OR
  NOT has_function_privilege('authenticated','public.target_challenge_rpc(text,text,jsonb)','EXECUTE') OR
  has_function_privilege('service_role','public.target_challenge_rpc(text,text,jsonb)','EXECUTE') OR
  EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(p.proacl) a
   WHERE p.oid='public.target_challenge_rpc(text,text,jsonb)'::regprocedure AND a.grantee=0) THEN
  RAISE EXCEPTION 'Challenge public RPC grants changed'; END IF;
 IF (public.target_challenge_rpc(NULL,'start','{}'::jsonb)#>>'{error,code}') IS DISTINCT FROM 'RPC_FORBIDDEN' THEN
  RAISE EXCEPTION 'Challenge private credential gate does not fail closed'; END IF;
 FOR item IN SELECT * FROM (VALUES
  ('challenge_runs'),('challenge_badges'),('challenge_reward_events'),('challenge_requests'),('challenge_rates')
 ) expected(name) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='target_private' AND c.relname=item.name AND c.relkind='r' AND c.relrowsecurity) THEN
   RAISE EXCEPTION 'Missing challenge table or RLS: %',item.name; END IF;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_table_privilege(role_name,'target_private.'||item.name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
    RAISE EXCEPTION 'Private challenge table grants changed: % %',role_name,item.name; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=('target_private.'||item.name)::regclass
   AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=29
   AND t.tgfoid='target_private.challenge_storage_charge()'::regprocedure) THEN
   RAISE EXCEPTION 'Challenge AFTER ROW storage accounting missing: %',item.name; END IF;
 END LOOP;
 FOR item IN SELECT * FROM (VALUES
  ('challenge_badges'),('challenge_reward_events'),('challenge_requests')
 ) expected(name) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=('target_private.'||item.name)::regclass
   AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=27
   AND t.tgfoid='target_private.battle_immutable()'::regprocedure) THEN
   RAISE EXCEPTION 'Challenge immutable evidence fence missing: %',item.name; END IF;
 END LOOP;
 FOR item IN SELECT * FROM (VALUES
  ('challenge_badges_pkey','CREATE UNIQUE INDEX challenge_badges_pkey ON target_private.challenge_badges USING btree (member_id, level)'),
  ('challenge_badges_run_id_key','CREATE UNIQUE INDEX challenge_badges_run_id_key ON target_private.challenge_badges USING btree (run_id)'),
  ('challenge_one_active_run','CREATE UNIQUE INDEX challenge_one_active_run ON target_private.challenge_runs USING btree (member_id) WHERE (status = ANY (ARRAY[''playing''::text, ''paused''::text]))'),
  ('challenge_rates_pkey','CREATE UNIQUE INDEX challenge_rates_pkey ON target_private.challenge_rates USING btree (member_id)'),
  ('challenge_requests_pkey','CREATE UNIQUE INDEX challenge_requests_pkey ON target_private.challenge_requests USING btree (member_id, request_id)'),
  ('challenge_reward_events_pkey','CREATE UNIQUE INDEX challenge_reward_events_pkey ON target_private.challenge_reward_events USING btree (run_id)'),
  ('challenge_rewards_member','CREATE INDEX challenge_rewards_member ON target_private.challenge_reward_events USING btree (member_id, created_at)'),
  ('challenge_runs_pkey','CREATE UNIQUE INDEX challenge_runs_pkey ON target_private.challenge_runs USING btree (id)')
 ) expected(name,definition) LOOP
  SELECT indexdef INTO actual FROM pg_indexes WHERE schemaname='target_private' AND indexname=item.name;
  IF actual IS DISTINCT FROM item.definition THEN RAISE EXCEPTION 'Challenge index mismatch: %',item.name; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) f USING(member_id)
  WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points)
   IS DISTINCT FROM (f.total_points,f.spent_points,f.calculus_points,f.birthday_points,f.casino_net,f.calculus_forgiven_points)) THEN
  RAISE EXCEPTION 'Shared wallet caches do not reconcile with all immutable histories'; END IF;
 IF EXISTS(SELECT 1 FROM target_private.challenge_reward_events e LEFT JOIN target_private.challenge_runs r ON r.id=e.run_id
  WHERE r.id IS NULL OR r.member_id<>e.member_id OR r.level<>e.level OR r.status<>'won' OR r.reward<>e.amount OR e.amount<>e.level*100000) OR
  EXISTS(SELECT 1 FROM target_private.challenge_runs r LEFT JOIN target_private.challenge_reward_events e ON e.run_id=r.id
   WHERE (r.status='won' AND e.run_id IS NULL) OR (r.status<>'won' AND e.run_id IS NOT NULL)) THEN
  RAISE EXCEPTION 'Challenge win/reward receipts do not match one per cleared run'; END IF;
 IF EXISTS(SELECT 1 FROM target_private.challenge_badges b LEFT JOIN target_private.challenge_runs r ON r.id=b.run_id
  WHERE r.id IS NULL OR r.status<>'won' OR r.member_id<>b.member_id OR r.level<>b.level OR NOT r.badge_awarded) OR
  EXISTS(SELECT 1 FROM target_private.challenge_badges b WHERE b.level>1 AND NOT EXISTS(
   SELECT 1 FROM target_private.challenge_badges previous WHERE previous.member_id=b.member_id AND previous.level=b.level-1)) THEN
  RAISE EXCEPTION 'Challenge unique badges or sequential unlock history do not reconcile'; END IF;
 SELECT sum(bytes) INTO charged FROM (
  SELECT pg_column_size(to_jsonb(t))+128 bytes FROM target_private.challenge_runs t UNION ALL
  SELECT pg_column_size(to_jsonb(t))+128 FROM target_private.challenge_badges t UNION ALL
  SELECT pg_column_size(to_jsonb(t))+128 FROM target_private.challenge_reward_events t UNION ALL
  SELECT pg_column_size(to_jsonb(t))+128 FROM target_private.challenge_requests t UNION ALL
  SELECT pg_column_size(to_jsonb(t))+128 FROM target_private.challenge_rates t
 ) retained;
 SELECT logical_bytes INTO budget FROM target_private.system_state WHERE singleton;
 IF budget IS NULL OR budget<coalesce(charged,0) OR budget>104857600 THEN
  RAISE EXCEPTION 'Challenge shared logical storage budget does not cover retained evidence'; END IF;
END; $verify$;
-- Public contract cost proof: no stake, every win pays, first-win badge is separate from gacha frames.
SELECT level,100*level AS enemy_max_hp,100+50*(level-1) AS player_max_hp,
 CASE WHEN level=10 THEN 1000 ELSE 2000-100*(level-1) END AS enemy_attack_interval_ms,
 CASE WHEN level=10 THEN 15 ELSE 5+(level-1) END AS enemy_attack_damage,
 level*100000 AS reward_every_clear,0 AS attempt_cost,
 1+(19-1)*(level-1)/9 AS target1900_max_section,
 1+(10-1)*(level-1)/9 AS target1000_max_section,
 1+(4-1)*(level-1)/9 AS kobun400_max_section
FROM generate_series(1,10) level;
SELECT method,path FROM (VALUES
 ('GET','/api/challenge/map'),('GET','/api/challenge/state?runId=<uuid>'),
 ('POST','/api/challenge/start'),('POST','/api/challenge/answer'),
 ('POST','/api/challenge/pause'),('POST','/api/challenge/resume'),('POST','/api/challenge/abort')
) endpoints(method,path);
SELECT 'challenge_verified' AS result,
 (SELECT count(*) FROM target_private.challenge_runs) AS runs,
 (SELECT count(*) FROM target_private.challenge_reward_events) AS paid_clears,
 (SELECT coalesce(sum(amount),0) FROM target_private.challenge_reward_events) AS paid_reward_total,
 (SELECT count(*) FROM target_private.challenge_badges) AS unique_level_badges,
 (SELECT logical_bytes FROM target_private.system_state WHERE singleton) AS shared_logical_bytes;
COMMIT;
