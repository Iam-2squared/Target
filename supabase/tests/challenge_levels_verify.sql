-- Strict read-only postflight through 20261115142451_target_challenge_graded_choice_feedback,
-- preserving the latest Epic/Legendary financial projection.
-- No fixture identities, secrets, rewards, cleanup, or wallet writes are performed.
-- Quiz cleanup intentionally deletes answers after their retention period while
-- preserving lifetime study totals (20261109064636, lines 241-246). A release with
-- such preexisting carry must supply its separately captured pre-release digest:
-- SET target.challenge_legacy_study_carry_sha256='<reviewed SHA-256>';
-- This pins every positive member/carry pair; changing any amount fails verification.
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(991101);
DO $verify$
DECLARE item record; actual text; helper regprocedure; role_name text; charged bigint; budget bigint;
 carry_digest text; expected_carry_digest text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('public.target_challenge_rpc(text,text,jsonb)','66e060d1532f0fa08800f30579897d9a',true),
  ('target_private.challenge_dto(uuid,uuid)','f4f5f936f9d5b046b6d9baee36512532',false),
  ('target_private.challenge_tick(uuid,timestamptz)','88458e872af0fd28593b35511ec9099a',false),
  ('target_private.challenge_storage_charge()','69be621da1580b84ed1d793cc7f95737',false),
  ('target_private.wallet_finance_projection(timestamptz)','bd93399757a066fdfb8f35e7e29af2dc',false)
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
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='target_private.challenge_runs'::regclass
  AND conname='challenge_runs_attack_remaining_ms_check'
  AND pg_get_constraintdef(oid)='CHECK (((attack_remaining_ms >= 0) AND (attack_remaining_ms <= 3000)))') OR
  NOT EXISTS(SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
   WHERE d.adrelid='target_private.challenge_runs'::regclass AND a.attname='attack_remaining_ms'
   AND pg_get_expr(d.adbin,d.adrelid)='3000') THEN
  RAISE EXCEPTION 'Challenge gentler remaining-clock bounds/default changed'; END IF;
 IF EXISTS(SELECT 1 FROM target_private.challenge_runs r,LATERAL jsonb_array_elements(r.questions) q
  WHERE r.status IN ('playing','paused') AND q->>'book'='kobun400'
   AND (r.level<7 OR (q->>'number')::integer>100*(r.level-6))) THEN
  RAISE EXCEPTION 'Challenge active queue contains classical Japanese outside the new level range'; END IF;
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
 -- Spending and every non-study income component retain permanent evidence and
 -- must match exactly, including the games component containing challenge wins.
 IF EXISTS(SELECT 1 FROM target_private.profiles p FULL JOIN target_private.wallet_finance_projection(NULL) f USING(member_id)
  WHERE p.member_id IS NULL OR f.member_id IS NULL OR
   (p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points)
    IS DISTINCT FROM (f.spent_points,f.calculus_points,f.birthday_points,f.casino_net,f.calculus_forgiven_points)) THEN
  RAISE EXCEPTION 'Shared wallet permanent components do not reconcile'; END IF;
 -- Only removed study awards may account for a positive total-income residual.
 -- Deleted histories cannot reconstruct the exact amount, so the reviewed
 -- release digest below is required as well as these independent semantic bounds.
 IF EXISTS(WITH retained AS (
   SELECT member_id,count(*) FILTER(WHERE response->>'correct'='true') correct
   FROM target_private.answers GROUP BY member_id)
  SELECT 1 FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) f USING(member_id)
   LEFT JOIN retained a USING(member_id)
  WHERE p.total_points<f.total_points OR (p.total_points-f.total_points)%100<>0 OR
   p.correct_count<coalesce(a.correct,0) OR
   p.total_points-f.total_points>(p.correct_count-coalesce(a.correct,0))*100000 OR
   p.total_points-p.calculus_points-p.birthday_points-p.casino_net-p.calculus_forgiven_points NOT BETWEEN 0 AND p.correct_count*100000 OR
   (p.total_points-p.calculus_points-p.birthday_points-p.casino_net-p.calculus_forgiven_points)%100<>0 OR
   p.total_points-f.total_points IS DISTINCT FROM
    p.total_points-p.calculus_points-p.birthday_points-p.casino_net-p.calculus_forgiven_points-f.raw_study_points) THEN
  RAISE EXCEPTION 'Shared wallet study carry violates retained/lifetime evidence'; END IF;
 expected_carry_digest:=nullif(current_setting('target.challenge_legacy_study_carry_sha256',true),'');
 IF expected_carry_digest IS NOT NULL OR EXISTS(
  SELECT 1 FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) f USING(member_id)
  WHERE p.total_points>f.total_points) THEN
  SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(p.member_id,p.total_points-f.total_points) ORDER BY p.member_id),'[]'::jsonb)::text,'UTF8')),'hex')
   INTO carry_digest FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) f USING(member_id)
   WHERE p.total_points>f.total_points;
  IF expected_carry_digest IS NULL OR expected_carry_digest!~'^[a-f0-9]{64}$' OR carry_digest IS DISTINCT FROM expected_carry_digest THEN
   RAISE EXCEPTION 'Shared wallet legacy study carry differs from the reviewed pre-release baseline'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM target_private.challenge_reward_events e LEFT JOIN target_private.challenge_runs r ON r.id=e.run_id
  WHERE r.id IS NULL OR r.member_id<>e.member_id OR r.level<>e.level OR r.status<>'won' OR r.reward<>e.amount OR e.amount<>e.level*100000) OR
  EXISTS(SELECT 1 FROM target_private.challenge_runs r LEFT JOIN target_private.challenge_reward_events e ON e.run_id=r.id
   WHERE (r.status='won' AND e.run_id IS NULL) OR (r.status<>'won' AND e.run_id IS NOT NULL)) THEN
  RAISE EXCEPTION 'Challenge win/reward receipts do not match one per cleared run'; END IF;
 -- Historical answers remain unchanged. Fixed-ten-percent receipts have three
 -- special fields; growing-special receipts add their actual milestone percent.
 IF EXISTS(SELECT 1 FROM target_private.challenge_requests q WHERE q.action='answer'
  AND (q.response->'answer') ?| ARRAY['specialAttack','specialDamage','specialPower','specialPercent'] AND (
   NOT ((q.response->'answer') ?& ARRAY['specialAttack','specialDamage','specialPower']) OR
   jsonb_typeof(q.response#>'{answer,specialAttack}') IS DISTINCT FROM 'boolean' OR
   jsonb_typeof(q.response#>'{answer,specialDamage}') IS DISTINCT FROM 'number' OR
   jsonb_typeof(q.response#>'{answer,specialPower}') IS DISTINCT FROM 'number' OR
   ((q.response->'answer') ? 'specialPercent' AND jsonb_typeof(q.response#>'{answer,specialPercent}') IS DISTINCT FROM 'number'))) THEN
  RAISE EXCEPTION 'Challenge special-attack receipt fields are incomplete'; END IF;
 IF EXISTS(SELECT 1 FROM target_private.challenge_requests q JOIN target_private.challenge_runs r ON r.id=q.run_id
  WHERE q.action='answer' AND (q.response->'answer') ? 'specialAttack' AND (
   (q.response#>>'{answer,specialDamage}')::integer<0 OR
   (q.response#>>'{answer,specialDamage}')::integer>(q.response#>>'{answer,specialPower}')::integer OR
   CASE WHEN (q.response#>>'{answer,specialAttack}')::boolean THEN
    (q.response#>>'{answer,correct}')::boolean IS DISTINCT FROM true OR
    (q.response#>>'{answer,streakBonus}')::boolean IS DISTINCT FROM true OR
    (q.response#>>'{answer,damage}')::integer IS DISTINCT FROM 5 OR
    CASE WHEN (q.response->'answer') ? 'specialPercent' THEN
     (q.response#>>'{answer,specialPercent}')::integer<10 OR
     (q.response#>>'{answer,specialPercent}')::integer%10<>0 OR
     (q.response#>>'{answer,specialPower}')::integer IS DISTINCT FROM (q.response#>>'{answer,specialPercent}')::integer*r.level
    ELSE (q.response#>>'{answer,specialPower}')::integer IS DISTINCT FROM 10*r.level END
   ELSE (q.response#>>'{answer,specialDamage}')::integer<>0 OR
    (q.response#>>'{answer,specialPower}')::integer<>0 OR
    ((q.response->'answer') ? 'specialPercent' AND (q.response#>>'{answer,specialPercent}')::integer IS DISTINCT FROM 0) END)) THEN
  RAISE EXCEPTION 'Challenge special-attack receipt damage is inconsistent'; END IF;
 -- Older answer receipts have no correction ID. New accepted answers reveal a
 -- UUID for the already-graded question only; private text is never returned.
 IF EXISTS(SELECT 1 FROM target_private.challenge_requests q
  WHERE (q.response->'answer') ? 'correctChoiceId' AND (
   q.action<>'answer' OR
   jsonb_typeof(q.response#>'{answer,correctChoiceId}') IS DISTINCT FROM 'string' OR
   coalesce(q.response#>>'{answer,correctChoiceId}','')!~'^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$')) THEN
  RAISE EXCEPTION 'Challenge graded-choice correction ID is invalid'; END IF;
 -- Older immutable receipts lack pause metadata. New receipts attest the pause
 -- created by that answer; later current run state may legitimately differ.
 IF EXISTS(SELECT 1 FROM target_private.challenge_requests q WHERE q.action='answer'
  AND (q.response->'answer') ?| ARRAY['specialPaused','specialPausedAt'] AND (
   NOT ((q.response->'answer') ?& ARRAY['specialPaused','specialPausedAt']) OR
   jsonb_typeof(q.response#>'{answer,specialPaused}') IS DISTINCT FROM 'boolean' OR
   CASE WHEN q.response#>>'{answer,specialPaused}'='true' THEN
    q.response#>>'{answer,specialAttack}' IS DISTINCT FROM 'true' OR
    jsonb_typeof(q.response#>'{answer,specialPausedAt}') IS DISTINCT FROM 'string' OR
    q.response ? 'reward'
   ELSE jsonb_typeof(q.response#>'{answer,specialPausedAt}') IS DISTINCT FROM 'null' END)) THEN
  RAISE EXCEPTION 'Challenge special pause receipt metadata is inconsistent'; END IF;
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
 3000 AS enemy_attack_interval_ms,
 CASE WHEN level=10 THEN 15 ELSE 5+(level-1) END AS enemy_attack_damage,
 level*100000 AS reward_every_clear,0 AS attempt_cost,
 5 AS normal_correct_damage,10 AS special_every_consecutive_correct,
 10*level AS special_at_ten,20*level AS special_at_twenty,30*level AS special_at_thirty,40*level AS special_at_forty,
 1+(19-1)*(level-1)/9 AS target1900_max_section,
 1+(10-1)*(level-1)/9 AS target1000_max_section,
 CASE WHEN level<7 THEN 0 ELSE level-6 END AS kobun400_max_section,
 CASE WHEN level<7 THEN 8 ELSE 10 END AS questions_per_block,
 5 AS target1900_questions_per_block,3 AS target1000_questions_per_block,
 CASE WHEN level<7 THEN 0 ELSE 2 END AS kobun400_questions_per_block
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
